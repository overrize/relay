import {test,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {EventEmitter} from 'node:events';
import {SessionJournal} from '../session/Journal.js';
import {HistoryMetadata} from '../session/HistoryMetadata.js';
import {archiveEntries} from '../session/ArchiveStream.js';
import {decodeArchive,zip,unzip,digest} from '../session/Storage.js';
import {transcriptPage,closeTranscriptReaders} from '../session/Transcript.js';
import {DatabaseSync} from 'node:sqlite';
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/transcript28-'));
after(async()=>{await closeTranscriptReaders();fs.rmSync(root,{recursive:true,force:true});});

test('metadata notifications invalidate in-place writes; periodic audit and unsupported/error watches fall back to full checks',async()=>{
 const folder=path.join(root,'metadata');fs.mkdirSync(folder);const file=path.join(folder,'source');fs.writeFileSync(file,'a');const catalog=new HistoryMetadata();let checks=0;
 try{await catalog.prepare([folder]);await catalog.stat(file,()=>checks++);await catalog.prepare([folder]);await catalog.stat(file,()=>checks++);assert.equal(checks,1);assert.equal(catalog.mode,'watched');
 fs.writeFileSync(file,'different');await catalog.prepare([folder]);assert.equal((await catalog.stat(file,()=>checks++)).size,9);assert.equal(checks,2);
 const now=Date.now,clock=mock.method(Date,'now',()=>now()+6000);try{await catalog.prepare([folder]);await catalog.stat(file,()=>checks++);assert.equal(catalog.mode,'full');assert.equal(checks,3);}finally{clock.mock.restore();}
 }finally{catalog.close();}
 const denied=mock.method(fs,'watch',()=>{throw Error('unsupported');});const fallback=new HistoryMetadata();try{for(let i=0;i<2;i++){await fallback.prepare([folder]);await fallback.stat(file,()=>checks++);assert.equal(fallback.mode,'full');}assert.equal(checks,5);}finally{fallback.close();denied.mock.restore();}
 let watcher:EventEmitter;const broken=mock.method(fs,'watch',(()=>{watcher=new EventEmitter();(watcher as any).close=()=>watcher.emit('close');return watcher;}) as any),lost=new HistoryMetadata();try{await lost.prepare([folder]);await lost.stat(file,()=>checks++);watcher!.emit('error',Error('overflow'));await lost.prepare([folder]);await lost.stat(file,()=>checks++);assert.equal(lost.mode,'full');assert.equal(checks,7);}finally{lost.close();broken.mock.restore();}
});

test('large archive streams Unicode, escaped strings and chunk boundaries; trailing corruption rolls back all staged history',async()=>{
 const folder=path.join(root,'large'),j=new SessionJournal(folder,{automatic:false,segmentBytes:64*1024*1024});j.bind('pm','Leader');for(let i=0;i<600;i++)j.append('message.recorded','pm','pm',0,{role:'user',content:`LARGE_${i} 引号" 反斜杠\\ emoji🙂\n`+'长记录 '.repeat(1200)});
 const maintenance=await j.maintain({maxLogBytes:0,retentionMs:0,maxTotalBytes:128*1024*1024});assert.deepEqual(maintenance.errors,[]);const source=j.historySources().sources[0]!,ref=source.archive!;assert.equal(j.historySources().sources.length,1);
 const expected=await decodeArchive(fs.readFileSync(source.file),ref),fd=fs.openSync(source.file,'r');let count=0;try{for await(const entry of archiveEntries(fd,source.size,ref)){assert.deepEqual(entry,expected.entries[count++]);}assert.equal(count,expected.entries.length);assert.ok(fs.fstatSync(fd).isFile());}finally{fs.closeSync(fd);}
 const progress:any[]=[];const page=await transcriptPage(folder,undefined,20,p=>progress.push(p));assert.equal(page.rows.at(-1)?.text.startsWith('LARGE_599 '),true);assert.ok(progress.some(p=>p.phase==='重建索引'));assert.ok(progress.some(p=>p.visited>0));
 await closeTranscriptReaders(folder);const original=fs.readFileSync(source.file);const bad=Buffer.from(original);bad[bad.length-6]^=1;fs.writeFileSync(source.file,bad);fs.unlinkSync(path.join(folder,'.spawn/transcript-cache/index.sqlite'));await assert.rejects(transcriptPage(folder),/校验/);const db=new DatabaseSync(path.join(folder,'.spawn/transcript-cache/index.sqlite'));try{const exists=db.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get();if(exists)assert.equal((db.prepare('SELECT count(*) AS n FROM messages').get() as any).n,0);}finally{db.close();}fs.writeFileSync(source.file,original);assert.deepEqual((await transcriptPage(folder,undefined,20)).rows,page.rows);
 // Correct gzip CRC with an incorrect archive digest is also rejected at EOF.
 const value=JSON.parse((await unzip(original)).toString());value.digest='0'.repeat(64);const altered=await zip(Buffer.from(JSON.stringify(value)));const file=path.join(root,'bad.gz');fs.writeFileSync(file,altered);const badFd=fs.openSync(file,'r');try{await assert.rejects(async()=>{for await(const _ of archiveEntries(badFd,altered.length,ref)){}},/integrity/);}finally{fs.closeSync(badFd);}
});

test('noncanonical legacy archive headers retain the verified decoder fallback',async()=>{
 const entry:any={version:1,seq:1,ts:1,kind:'message.recorded',agent:'pm',revision:0,data:{role:'user',content:'旧归档🙂'},hash:'a'.repeat(64)},body={version:1 as const,from:1,to:1,lastHash:entry.hash,entries:[entry]},value={...body,digest:digest(body)},bytes=await zip(Buffer.from(JSON.stringify(value,null,2))),file=path.join(root,'legacy.gz');fs.writeFileSync(file,bytes);const ref={name:'legacy',from:1,to:1,lastHash:entry.hash,digest:value.digest,bytes:bytes.length,events:1},fd=fs.openSync(file,'r');try{const rows=[];for await(const row of archiveEntries(fd,bytes.length,ref))rows.push(row);assert.deepEqual(rows,[entry]);assert.ok(fs.fstatSync(fd).isFile());}finally{fs.closeSync(fd);}
});

test('high compression ratio archives stream even with very few events; stopping consumption retains caller descriptor ownership',async()=>{
 const folder=path.join(root,'ratio'),j=new SessionJournal(folder,{automatic:false,segmentBytes:32*1024*1024});j.bind('pm','Leader');j.append('message.recorded','pm','pm',0,{role:'user',content:'压缩🙂'.repeat(350000)});await j.maintain({maxLogBytes:0,retentionMs:0,maxTotalBytes:64*1024*1024});const source=j.historySources().sources[0]!;assert.ok(source.size<65536);assert.ok(source.archive!.events<512);
 const page=await transcriptPage(folder);assert.equal(page.index?.streamedArchives,1);assert.match(page.rows[0]!.text,/长内容已截取/);
 const fd=fs.openSync(source.file,'r');try{for await(const _ of archiveEntries(fd,source.size,source.archive!))break;assert.ok(fs.fstatSync(fd).isFile());}finally{fs.closeSync(fd);}
});
