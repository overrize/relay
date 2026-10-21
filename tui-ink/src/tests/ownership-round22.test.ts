import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {acquireWorkspaceOwnership,WorkspaceOwnershipError,ownershipNotice} from '../session/RuntimeOwner.js';
import {submitInput} from '../tui/submitInput.js';
import React from 'react';
import {PassThrough} from 'node:stream';
import {render} from 'ink';
import {MultilineEditor} from '../tui/MultilineEditor.js';

fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/ownership22-'));
const entry=path.resolve('src/index.tsx'),bootstrap=pathToFileURL(path.resolve('src/runtime/RuntimeBootstrap.ts')).href,tsx=pathToFileURL(path.resolve('node_modules/tsx/dist/loader.mjs')).href;
after(()=>fs.rmSync(root,{recursive:true,force:true}));
function run(source:string,cwd:string){return spawnSync(process.execPath,['--import',tsx,'--input-type=module','-e',source],{cwd,encoding:'utf8',timeout:15000,env:{...process.env,SERVER_ENABLED:'false',SPAWN_PRICE_AUTO_SYNC:'0'}});}

test('actual CLI rejects an occupied workspace before importing the UI or creating journal/config files',()=>{
 const cwd=fs.mkdtempSync(path.join(root,'busy-')),release=acquireWorkspaceOwnership(cwd,'runtime'),ownerFile=path.join(cwd,'.spawn/runtime-owner.json'),before=fs.readFileSync(ownerFile,'utf8');
 try{const child=spawnSync(process.execPath,['--import',tsx,entry],{cwd,encoding:'utf8',timeout:15000});assert.equal(child.status,1,child.stderr);assert.match(child.stderr,/占用进程 PID/);assert.ok(child.stderr.includes(String(process.pid)));assert.doesNotMatch(child.stderr,/\n\s+at |throw new Error|RuntimeOwner\.[jt]s:/);assert.equal(child.stdout,'');assert.equal(fs.readFileSync(ownerFile,'utf8'),before);assert.deepEqual(fs.readdirSync(path.join(cwd,'.spawn')),['runtime-owner.json']);}finally{release();}
});
test('bootstrap releases ownership on clean exit and permits another real process to start',()=>{
 const cwd=fs.mkdtempSync(path.join(root,'clean-')),source=`import {bootstrapRuntime} from ${JSON.stringify(bootstrap)};const ok=await bootstrapRuntime(async()=>{console.log('STARTED')},console.error);if(!ok)process.exitCode=1;`;
 for(let i=0;i<2;i++){const child=run(source,cwd);assert.equal(child.status,0,child.stderr);assert.match(child.stdout,/STARTED/);assert.equal(fs.existsSync(path.join(cwd,'.spawn/runtime-owner.json')),false);}
});
test('a hard-killed owner can be reclaimed without deleting a live owner lock',async()=>{
 const cwd=fs.mkdtempSync(path.join(root,'killed-')),source=`import {bootstrapRuntime} from ${JSON.stringify(bootstrap)};await bootstrapRuntime(async()=>console.log('READY'),console.error);setInterval(()=>{},1000);`;
 const child=spawn(process.execPath,['--import',tsx,'--input-type=module','-e',source],{cwd,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',c=>output+=c);const done=new Promise<void>(r=>child.once('exit',()=>r()));
 try{const limit=Date.now()+15000;while(!output.includes('READY')){assert.ok(Date.now()<limit,'owner did not start');await new Promise(r=>setTimeout(r,10));}assert.throws(()=>acquireWorkspaceOwnership(cwd,'runtime'),WorkspaceOwnershipError);child.kill('SIGKILL');await done;const release=acquireWorkspaceOwnership(cwd,'runtime');assert.equal(JSON.parse(fs.readFileSync(path.join(cwd,'.spawn/runtime-owner.json'),'utf8')).pid,process.pid);release();}finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await done;}}
});
test('interrupted ownership transition gives an actionable notice and is not removed speculatively',()=>{
 const cwd=fs.mkdtempSync(path.join(root,'transition-'));fs.mkdirSync(path.join(cwd,'.spawn'));const lock=path.join(cwd,'.spawn/ownership-transition.lock');fs.writeFileSync(lock,'inspect-me');const child=run(`import {bootstrapRuntime} from ${JSON.stringify(bootstrap)};if(!await bootstrapRuntime(async()=>console.log('WRONG'),console.error))process.exitCode=1;`,cwd);assert.equal(child.status,1);assert.match(child.stderr,/所有权记录需要检查/);assert.equal(child.stdout,'');assert.equal(fs.readFileSync(lock,'utf8'),'inspect-me');
});
test('a rejected real editor submission preserves the draft and remains editable, then retries exactly once',async()=>{
 const input=new PassThrough(),output=new PassThrough();Object.assign(input,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});Object.assign(output,{isTTY:true,columns:100,rows:30});output.resume();let text='需求管理🙂',notice='',fail=true,accepted=0;
 function Composer(){const [draft,setDraft]=React.useState(text);return React.createElement(MultilineEditor,{value:draft,onChange:(s:string)=>{text=s;setDraft(s);},onSubmit:()=>{if(submitInput(()=>{if(fail)throw new WorkspaceOwnershipError('Another application or restore owns this workspace',123);accepted++;},message=>notice=message)){text='';setDraft('');}}});}
 const widget=render(React.createElement(Composer),{stdin:input as any,stdout:output as any,stderr:output as any,debug:true,patchConsole:false,exitOnCtrlC:false});
 const until=async(check:()=>boolean)=>{const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'editor timeout');await new Promise(r=>setTimeout(r,10));}};
 const send=async(s:string)=>{await until(()=>input.listenerCount('readable')>0);await new Promise(r=>setImmediate(r));input.write(s);await until(()=>input.readableLength===0);await new Promise(r=>setTimeout(r,30));};
 try{await send('\r');assert.equal(text,'需求管理🙂');assert.equal(accepted,0);assert.match(notice,/PID 123/);await send('继续');assert.equal(text,'需求管理🙂继续');fail=false;await send('\r');assert.equal(accepted,1);assert.equal(text,'');assert.equal(submitInput(()=>false,()=>{}),false);assert.doesNotMatch(ownershipNotice(new Error('secret-key')),/secret-key/);}finally{widget.unmount();input.destroy();output.destroy();}
});
