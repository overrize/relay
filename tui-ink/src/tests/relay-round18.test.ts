import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {PassThrough} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import React,{useState} from 'react';
import {render} from 'ink';
import {ModelBar} from '../ui.js';
import {MultilineEditor,editorLines} from '../tui/MultilineEditor.js';
import {HistorySearch} from '../tui/HistorySearch.js';
import {ShortcutInput} from '../tui/ShortcutInput.js';
import {terminalPaste} from '../tui/TerminalPaste.js';
import {rememberPrompt,searchPrompts} from '../tui/PromptHistory.js';
import {configPath,loadConfig,saveAgentModel,saveModelConfig,savePalette,selectSessionModel} from '../config.js';
import http from 'node:http';
import {HttpConvAgent} from '../adapters/httpAgent.js';
import {sessionJournal} from '../session/Journal.js';
import {waitForIndexing} from '../session/SearchIndex.js';
import {buildCommands} from '../tui/commands.js';

fs.mkdirSync('.test-tmp',{recursive:true});
const root=fs.mkdtempSync(path.resolve('.test-tmp/relay18-')),old=process.env.SPAWN_CONFIG_DIR;
process.env.SPAWN_CONFIG_DIR=path.join(root,'config');
after(()=>{if(old===undefined)delete process.env.SPAWN_CONFIG_DIR;else process.env.SPAWN_CONFIG_DIR=old;fs.rmSync(root,{recursive:true,force:true});});
const a={provider:'openai' as const,model:'model-a',apiKey:'fixture-a'},b={...a,model:'model-b',apiKey:'fixture-b'};

function mount(element:React.ReactElement){
 const source=new PassThrough(),input=new ShortcutInput(()=>{}),output=new PassThrough();source.pipe(input);Object.assign(input,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});Object.assign(output,{isTTY:true,columns:100,rows:35});
 let raw='',frames='';output.on('data',chunk=>{raw+=chunk.toString();frames=stripVTControlCharacters(raw);});
 const widget=render(element,{stdin:input as any,stdout:output as any,stderr:output as any,debug:true,patchConsole:false,exitOnCtrlC:false});
 const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){if(Date.now()>end)assert.fail('render timeout '+JSON.stringify(frames.slice(-1400)));await new Promise(r=>setTimeout(r,10));}};
 const send=async(text:string)=>{await until(()=>input.listenerCount('readable')>0);await new Promise(r=>setImmediate(r));source.write(text);await until(()=>input.readableLength===0);await new Promise(r=>setTimeout(r,20));};
 return {send,until,frames:()=>frames,close:()=>{widget.unmount();source.destroy();input.destroy();output.destroy();}};
}

test('session model changes effective routing without changing disk, and unrelated writes do not persist it',()=>{
 saveModelConfig('a',a);saveModelConfig('b',b);saveAgentModel('leader','a');const before=fs.readFileSync(configPath(),'utf8');
 assert.equal(selectSessionModel('leader','b'),true);assert.equal(loadConfig().agents.leader.model,'b');assert.deepEqual(loadConfig().routing!.profiles!.pm,['b']);assert.equal(fs.readFileSync(configPath(),'utf8'),before);
 savePalette('amber');assert.equal(JSON.parse(fs.readFileSync(configPath(),'utf8')).agents.leader.model,'a');
 const route=buildCommands({emitCommandMessage:()=>{}} as any).find(c=>c.name==='route')!;route.handler(['review','a']);assert.deepEqual(JSON.parse(fs.readFileSync(configPath(),'utf8')).routing.profiles.pm,['a']);assert.equal(loadConfig().agents.leader.model,'b');
 const child=spawnSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',"import {loadConfig} from './src/config.ts';console.log(loadConfig().agents.leader.model)"],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'a');
 assert.equal(saveAgentModel('leader','b'),true);assert.equal(JSON.parse(fs.readFileSync(configPath(),'utf8')).agents.leader.model,'b');assert.equal(loadConfig().agents.leader.model,'b');assert.equal(selectSessionModel('leader','missing'),false);
});

test('model selector Enter is session-only and Ctrl+S explicitly saves default',async()=>{
 const chosen:any[]=[];const w=mount(React.createElement(ModelBar,{currentRole:'leader',currentModelByRole:{leader:'a',worker:'b',secretary:'a'},modelChoices:['a','b'],onConfirm:(...args)=>chosen.push(args),onCancel:()=>{}}));
 try{await w.until(()=>w.frames().includes('仅本次使用'));await w.send('\x1b[B');await w.send('\r');await w.until(()=>chosen.length===1);assert.deepEqual(chosen[0],['leader','b','session']);await w.send('\x13');await w.until(()=>chosen.length===2);assert.deepEqual(chosen[1],['leader','b','default']);}finally{w.close();}
});

test('multiline editor preserves paste and Unicode, navigates lines, undoes edits and only sends on Enter',async()=>{
 let value='',submitted='';function Composer(){const [text,setText]=useState('');value=text;return React.createElement(MultilineEditor,{value:text,onChange:setText,onSubmit:t=>{submitted=t;}});}
 const w=mount(React.createElement(Composer));
 try{
  await w.until(()=>w.frames().includes('输入消息'));await w.send('第一行');await w.send('\x1b\r');await w.until(()=>value==='第一行\n');await w.send('第二行');assert.equal(submitted,'');
  await w.send('\x1b[A');await w.send('!');await w.until(()=>value==='第一行!\n第二行');await w.send('\x1a');await w.until(()=>value==='第一行\n第二行');await w.send('\x19');await w.until(()=>value==='第一行!\n第二行');
  await w.send('\x1b[B');await w.send('\x1b[200~\n粘贴🙂\r\n末行\x1b[201~');await w.until(()=>value.includes('粘贴🙂\n末行'));assert.equal(submitted,'');
  await w.send('\x7f');await w.until(()=>value.endsWith('末'));await w.send('\x7f');await w.send('\x7f');await w.send('\x7f');await w.until(()=>!value.includes('🙂'));await w.send('\r');await w.until(()=>submitted===value);assert.ok(submitted.includes('\n'));
 }finally{w.close();}
});

test('fragmented bracketed paste never fires control shortcuts or leaks framing into text',async()=>{
 const keys:number[]=[],pastes:string[]=[],raw:Buffer[]=[];const paste=(text:string)=>pastes.push(text);terminalPaste.on('paste',paste);const stream=new ShortcutInput(code=>keys.push(code));stream.on('data',b=>raw.push(b));
 try{for(const chunk of ['\x1b','[20','0~first\x03\x12\r\n','second🙂','\x1b[20','1~','\x12'])stream.write(chunk);stream.end();await new Promise(r=>stream.on('end',r));assert.deepEqual(keys,[0x12]);assert.deepEqual(pastes,['first\x03\x12\r\nsecond🙂']);assert.equal(Buffer.concat(raw).toString(),'');}finally{terminalPaste.off('paste',paste);stream.destroy();}
});

test('paste ordering preserves surrounding typing and consecutive pasted blocks in one input packet',async()=>{
 let value='';function Composer(){const [text,setText]=useState('');value=text;return React.createElement(MultilineEditor,{value:text,onChange:setText,onSubmit:()=>assert.fail('paste must not submit')});}
 const w=mount(React.createElement(Composer));try{await w.until(()=>w.frames().includes('输入消息'));await w.send('head\x1b[200~first\x1b[201~\x1b[200~\nsecond\x1b[201~tail');await w.until(()=>value==='headfirst\nsecondtail');}finally{w.close();}
});

test('mouse framing is stripped once, fragmented reports work and pasted mouse text stays literal',async()=>{
 const mouse:number[][]=[],pastes:string[]=[],chunks:Buffer[]=[];const listen=(text:string)=>pastes.push(text);terminalPaste.on('paste',listen);
 const stream=new ShortcutInput(()=>{},(...m)=>mouse.push(m));stream.on('data',b=>chunks.push(b));
 try{stream.write('\x1b[<64;');stream.write('30;2M');stream.write('abc');stream.write('\x1b[200~literal\x1b[<65;30;2M\nline2\x1b[201~');stream.end();await new Promise(r=>stream.on('end',r));assert.deepEqual(mouse,[[64,30]]);assert.equal(Buffer.concat(chunks).toString(),'abc');assert.deepEqual(pastes,['literal\x1b[<65;30;2M\nline2']);}finally{terminalPaste.off('paste',listen);stream.destroy();}
});

test('visual wrapping preserves graphemes and bounds each row',()=>{
 const rows=editorLines('abcdef\n中文🙂结束',4,s=>Array.from(s).length);assert.deepEqual(rows.map(r=>r.text),['abcd','ef','中文🙂结','束']);assert.equal(rows.map(r=>r.text).join(''),'abcdef中文🙂结束');
});

test('history survives a fresh process, supports Unicode, literal quotes and excludes authentication commands',()=>{
 rememberPrompt('第一轮\n恢复目标 alpha','E:/one','session-one');rememberPrompt('第二轮恢复目标 beta','E:/two','session-two');rememberPrompt('a "quoted" history entry');
 for(const text of ['/connect provider sk-secret-secret','/login','/web connect brave fixture','/feishu id secret','API_KEY=secret','Bearer private-token'])assert.equal(rememberPrompt(text),false);
 assert.equal(searchPrompts('恢复目标').length,2);assert.equal(searchPrompts('"quoted"')[0]!.text,'a "quoted" history entry');assert.equal(searchPrompts('BETA')[0]!.session,'session-two');
 const child=spawnSync(process.execPath,['--import','tsx/esm','--input-type=module','-e',"import {searchPrompts} from './src/tui/PromptHistory.ts';console.log(JSON.stringify(searchPrompts('alpha')))"],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(JSON.parse(child.stdout)[0].session,'session-one');
 assert.equal(searchPrompts('private-token').length,0);
});

test('history selector restores full multiline text without executing it, Escape preserves caller draft',async()=>{
 let selected='',cancelled=0;const w=mount(React.createElement(HistorySearch,{onSelect:text=>{selected=text;},onCancel:()=>cancelled++}));
 try{await w.until(()=>w.frames().includes('跨会话历史'));await w.send('alpha');await w.until(()=>w.frames().includes('第一轮'));await w.send('\r');await w.until(()=>selected.length>0);assert.equal(selected,'第一轮\n恢复目标 alpha');await w.send('\x1b');await w.until(()=>cancelled===1);}finally{w.close();}
});

test('switching while a PM request is in flight preserves its provider and fee snapshot, then uses the new model',async()=>{
 const cwd=process.cwd(),work=path.join(root,'requests');fs.mkdirSync(work);process.chdir(work);
 const calls:string[]=[];let release!:()=>void,started!:()=>void;const waiting=new Promise<void>(r=>{release=r;}),first=new Promise<void>(r=>{started=r;});
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const parsed=JSON.parse(body);calls.push(parsed.model);if(calls.length===1){started();await waiting;}const event=JSON.stringify({v:1,type:'message',agent:'pm',to:'user',text:'MODEL_OK'});res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:event}}],usage:{prompt_tokens:20,completion_tokens:10}})}\n\ndata: [DONE]\n\n`);});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${(server.address() as any).port}/v1`;
 const initial={...a,baseUrl,billing:{mode:'api' as const,inputUsdPerMillion:1,outputUsdPerMillion:1}},next={...b,baseUrl,billing:{mode:'api' as const,inputUsdPerMillion:2,outputUsdPerMillion:2}};
 const journal=sessionJournal();journal.bind('pm','Leader');
 const agent=new HttpConvAgent({id:'pm',role:'Leader',systemPrompt:'Reply to the user',sessionManaged:true,providerCfg:initial});
 try{
  const request=agent.send('first');await first;agent.selectModel({name:'b',config:next});assert.equal(agent.cfg.providerCfg.model,'model-a');release();await request;
  await agent.send('second');assert.deepEqual(calls,['model-a','model-b']);const settled=Object.values(journal.budget()!.reservations);assert.equal(settled.length,2);assert.deepEqual(settled.map(r=>[r.model,r.microUsd,r.settled]),[['model-a',30,true],['model-b',60,true]]);
  assert.equal(journal.budget()!.used.microUsd,90);assert.equal(agent.cfg.providerCfg.model,'model-b');
 }finally{release();agent.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await waitForIndexing();process.chdir(cwd);}
});
