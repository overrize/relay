import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {PassThrough} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import React from 'react';
import {render} from 'ink';
import {Keybindings,keybindings} from '../tui/Keybindings.js';
import {ShortcutInput} from '../tui/ShortcutInput.js';
import {ModelBar} from '../ui.js';
import {loginProviders,providerDirectorySource,directoryModels} from '../models/ProviderDirectory.js';
import snapshot from '../models/providerSnapshot.json' with {type:'json'};
import {LoginFlow} from '../tui/loginFlow.js';
import {preparedCatalog,discoverModels} from '../models/catalog.js';
import {editExternally,splitEditorCommand,editorCommand} from '../tui/ExternalEditor.js';
import {HttpConvAgent,buildChatPath} from '../adapters/httpAgent.js';
import {sessionJournal} from '../session/Journal.js';
import {waitForIndexing} from '../session/SearchIndex.js';

fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/relay19-')),env={...process.env};process.env.SPAWN_CONFIG_DIR=path.join(root,'config');
after(()=>{keybindings.configure({});process.env={...env};fs.rmSync(root,{recursive:true,force:true});});

test('keybindings use OmO action IDs, reject physical conflicts and keep the last good configuration',()=>{
 const k=new Keybindings();assert.equal(k.hint('app.editor.external'),'ctrl+g');assert.equal(k.hint('app.agents.toggle'),'ctrl+b');
 k.configure({'app.model.select':['f2','alt+l']});assert.equal(k.resolve(Buffer.from('\x0c'),'compose')!.output.length,0);assert.equal(k.resolve(Buffer.from('\x1bOQ'),'compose')!.output.toString(),'\x0c');
 assert.throws(()=>k.configure({'app.model.select':'ctrl+k'}),/冲突/);assert.equal(k.hint('app.model.select'),'f2 / alt+l');
 assert.throws(()=>k.configure({'app.model.select':'ctrl+i'}),/冲突/);assert.throws(()=>k.configure({'unknown.action':'ctrl+x'}),/未知/);assert.throws(()=>k.configure(JSON.parse('{"__proto__":[]}')),/未知/);
 assert.throws(()=>k.configure({'app.model.select':'ctrl+shift+l'}),/不支持/);k.configure({'app.model.select':[]});assert.equal(k.hint('app.model.select'),'未绑定');
});

test('custom key decoding handles split function keys and UTF-8 without invoking disabled defaults',async()=>{
 const k=new Keybindings();k.configure({'app.model.select':'f2','app.history.search':'alt+r'});const calls:number[]=[],bytes:Buffer[]=[];
 const stream=new ShortcutInput(code=>calls.push(code),undefined,(input,final)=>k.resolve(input,'compose',final));stream.on('data',b=>bytes.push(b));
 for(const chunk of ['你好','\x0c','\x1b','O','Q','\x1b','r'])stream.write(chunk);stream.end();await new Promise(r=>stream.on('end',r));assert.deepEqual(calls,[0x0c,0x12]);assert.equal(Buffer.concat(bytes).toString(),'你好');
});

test('a real rendered model selector accepts remapped confirm and save keys, and shows the new hints',async()=>{
 const map={'tui.select.confirm':'f4','app.model.save':'alt+s'};keybindings.configure(map);
 const input=new ShortcutInput(()=>{},undefined,(bytes,final)=>keybindings.resolve(bytes,'model',final)),source=new PassThrough(),output=new PassThrough();source.pipe(input);Object.assign(input,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});Object.assign(output,{isTTY:true,columns:120,rows:35});
 let raw='',frames='';output.on('data',b=>{raw+=b.toString();frames=stripVTControlCharacters(raw);});const selections:any[]=[];
 const app=render(React.createElement(ModelBar,{currentRole:'leader',currentModelByRole:{leader:'a',worker:'b',secretary:'a'},modelChoices:['a','b'],onConfirm:(...args)=>selections.push(args),onCancel:()=>{}}),{stdin:input as any,stdout:output as any,stderr:output as any,debug:true,patchConsole:false,exitOnCtrlC:false});
 const until=async(f:()=>boolean)=>{const end=Date.now()+5000;while(!f()){if(Date.now()>end)assert.fail('selector timeout '+JSON.stringify(frames.slice(-1000)));await new Promise(r=>setTimeout(r,10));}};
 const send=async(text:string)=>{await until(()=>input.listenerCount('readable')>0);await new Promise(r=>setImmediate(r));source.write(text);await new Promise(r=>setTimeout(r,30));};
 try{await until(()=>frames.includes('F4 仅本次使用')&&frames.includes('Alt+S 保存默认'));await send('\x1b[B');await send('\r');assert.equal(selections.length,0);await send('\x1bOS');await until(()=>selections.length===1);assert.deepEqual(selections[0],['leader','b','session']);await send('\x1bs');await until(()=>selections.length===2);assert.deepEqual(selections[1],['leader','b','default']);}
 finally{app.unmount();source.destroy();input.destroy();output.destroy();keybindings.configure({});}
});

test('provider directory covers every pinned OmO provider and all model seeds without importing prices',()=>{
 assert.equal(providerDirectorySource.count,49);for(const provider of snapshot.providers){assert.ok(loginProviders.some(p=>p.sourceId===provider.id),provider.id);assert.equal(directoryModels(provider.id).length,provider.models.length);}
 assert.equal(snapshot.providers.reduce((n,p)=>n+p.models.length,0),1936);assert.ok(preparedCatalog('groq','api').models.length>0);assert.ok(preparedCatalog('minimax','api').models.length>0);assert.ok(preparedCatalog('google','api').models.length>0);assert.doesNotMatch(JSON.stringify(snapshot),/inputUsdPerMillion|apiKey|access_token/);
});

test('directory login prepares API, token-plan and unsupported OAuth paths with honest billing',()=>{
 const empty=new LoginFlow(()=>{});empty.choose(1);assert.match(empty.view().options.find(row=>row.includes('Kimi / Moonshot'))!,/未配置/);
 for(const id of ['groq','minimax','google','mistral','ollama','xai']){const flow=new LoginFlow(()=>{});flow.choose(1);flow.choose(flow.availableProviders.findIndex(p=>p.provider.id===id));assert.equal(flow.stage,'key',id);flow.submit('fixture');assert.equal(flow.stage,'models');assert.ok(flow.catalog.models.length>0,id);flow.dispose();}
 let saved:any;const plan=new LoginFlow((_name,config)=>{saved=config;});plan.choose(0);plan.choose(plan.availableProviders.findIndex(p=>p.provider.id==='alibaba-token-plan'));assert.equal(plan.stage,'key');plan.submit('fixture');plan.choose(0);plan.choose(0);plan.finish();assert.equal(saved.transport,'http');assert.equal(saved.billing.mode,'subscription');
 const unsupported=new LoginFlow((_name,config)=>{saved=config;});unsupported.choose(0);unsupported.choose(unsupported.availableProviders.findIndex(p=>p.provider.id==='cursor'));assert.equal(unsupported.stage,'unsupported');assert.match(unsupported.view().options[0]!,/API 计费/);unsupported.choose(0);unsupported.submit('http://127.0.0.1:8080/v1');unsupported.submit('fixture');unsupported.catalog={models:[{id:'fixture',label:'fixture'}],source:'prepared'};unsupported.choose(0);unsupported.choose(0);unsupported.finish();assert.equal(saved.billing.mode,'api');assert.equal(saved.provider,'openai');assert.equal(saved.baseUrl,'http://127.0.0.1:8080/v1');
 const oauth=new LoginFlow(()=>{});oauth.choose(0);oauth.choose(oauth.availableProviders.findIndex(p=>p.provider.id==='xai'));assert.equal(oauth.stage,'unsupported');assert.match(oauth.view().options[0]!,/API 计费/);oauth.choose(0);assert.equal(oauth.mode,'api');assert.equal(oauth.stage,'key');
});

test('catalog discovery respects exact compatible prefixes and Anthropic auth without forwarding credentials elsewhere',async()=>{
 const signal=new AbortController().signal;await discoverModels('google','api','https://fixture.example/v1beta/openai','fixture',signal,(async(url,options)=>{assert.equal(String(url),'https://fixture.example/v1beta/openai/models');assert.equal((options!.headers as any).Authorization,'Bearer fixture');assert.equal(options!.redirect,'error');return new Response('{"data":[{"id":"gemini-fixture"}]}');}) as typeof fetch,undefined,{exactBaseUrl:true});
 await discoverModels('minimax','api','https://fixture.example/anthropic','fixture',signal,(async(url,options)=>{assert.equal(String(url),'https://fixture.example/anthropic/v1/models');assert.equal((options!.headers as any)['x-api-key'],'fixture');return new Response('{"data":[{"id":"minimax-fixture"}]}');}) as typeof fetch,undefined,{protocol:'anthropic'});
 assert.equal(buildChatPath('https://example/v2',true),'/v2/chat/completions');assert.equal(buildChatPath('https://example/v1beta/openai',true),'/v1beta/openai/chat/completions');
});

test('Anthropic-compatible inference actually uses the configured host, port and prefix',async()=>{
 let received:any;const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;received={path:req.url,key:req.headers['x-api-key'],body:JSON.parse(body)};const message=JSON.stringify({v:1,type:'message',agent:'pm',to:'user',text:'ANTHROPIC_COMPAT_OK'});res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({type:'content_block_delta',delta:{type:'text_delta',text:message}})+'\n\ndata: '+JSON.stringify({type:'message_stop'})+'\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const agent=new HttpConvAgent({id:'pm',role:'Leader',providerCfg:{provider:'anthropic',model:'fixture',apiKey:'fixture-key',baseUrl:`http://127.0.0.1:${(server.address() as any).port}/anthropic`}});let text='';agent.on('event',e=>{if(e.type==='message')text=e.text;});
 try{await agent.send('hello');assert.equal(received.path,'/anthropic/v1/messages');assert.equal(received.key,'fixture-key');assert.equal(text,'ANTHROPIC_COMPAT_OK');}finally{agent.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});

test('external editor command parsing preserves spaces and Windows paths without shell expansion',()=>{
 assert.deepEqual(splitEditorCommand('"C:\\Program Files\\Editor\\Code.exe" --wait'),['C:\\Program Files\\Editor\\Code.exe','--wait']);assert.deepEqual(splitEditorCommand("nvim -c 'set spell'"),['nvim','-c','set spell']);assert.throws(()=>splitEditorCommand('"unfinished'),/引号/);
 fs.mkdirSync(process.env.SPAWN_CONFIG_DIR!,{recursive:true});fs.writeFileSync(path.join(process.env.SPAWN_CONFIG_DIR!,'editor.json'),JSON.stringify({command:[process.execPath,'--wait']}));assert.deepEqual(editorCommand(),[process.execPath,'--wait']);
});

test('external editing is asynchronous, restores multiline Unicode and retains recovery files on failure',async()=>{
 const script=path.join(root,'editor fixture.mjs');fs.writeFileSync(script,"import fs from 'node:fs';setTimeout(()=>{fs.writeFileSync(process.argv.at(-1),'编辑后的草稿\\r\\n第二行🙂');},120);");let ticks=0,suspended=0,resumed=0;const timer=setInterval(()=>ticks++,10);
 try{const result=await editExternally('original',{root,command:[process.execPath,script],suspend:()=>{suspended++;},resume:()=>{resumed++;}});assert.equal(result.status,'complete');assert.equal(result.content,'编辑后的草稿\n第二行🙂');assert.ok(ticks>2);assert.equal(suspended,1);assert.equal(resumed,1);
 const failed=await editExternally('original',{root,command:[path.join(root,'missing-editor.exe')]});assert.equal(failed.status,'failed');assert.equal(fs.readFileSync(failed.recoveryPath!,'utf8'),'original');assert.ok(failed.recoveryPath!.startsWith(root));
 const invalid=await editExternally('{}',{root,command:[process.execPath,script],validate:content=>new Keybindings().configure(JSON.parse(content))});assert.equal(invalid.status,'failed');assert.match(fs.readFileSync(invalid.recoveryPath!,'utf8'),/编辑后的草稿/);
 }finally{clearInterval(timer);}
});

test('partial usage from a compatible provider keeps an uncertain reservation rather than billing missing output as zero',async()=>{
 const cwd=process.cwd(),work=path.join(root,'partial-usage');fs.mkdirSync(work);process.chdir(work);let request:any;
 const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;request=JSON.parse(body);const content=JSON.stringify({v:1,type:'message',agent:'pm',to:'user',text:'PARTIAL_USAGE_OK'});res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{delta:{content}}],usage:{prompt_tokens:20}})+'\n\ndata: [DONE]\n\n');});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const j=sessionJournal();j.bind('pm','Leader');const agent=new HttpConvAgent({id:'pm',role:'Leader',sessionManaged:true,providerCfg:{provider:'openai',model:'fixture',apiKey:'fixture',baseUrl:`http://127.0.0.1:${(server.address() as any).port}/custom`,exactBaseUrl:true,streamUsage:false,billing:{mode:'api',inputUsdPerMillion:1,outputUsdPerMillion:1}}});
 try{await agent.send('hello');assert.equal(Object.hasOwn(request,'stream_options'),false);const reservation=Object.values(j.budget()!.reservations)[0]!;assert.equal(reservation.settled,true);assert.equal(reservation.uncertain,true);assert.ok(j.budget()!.used.microUsd>20);}
 finally{agent.kill();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await waitForIndexing();process.chdir(cwd);}
});
