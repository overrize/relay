import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http2';
import fs from 'node:fs';
import path from 'node:path';
import {openRouterOAuth} from '../subscriptions/openrouterOAuth.js';
import {callCloud,vertexEndpoint,cancellable} from '../adapters/cloud.js';
import {HttpConvAgent} from '../adapters/httpAgent.js';
import {LoginFlow} from '../tui/loginFlow.js';
import {validateBillingConfig,type ProviderConfig} from '../config.js';
import {getCursorAnchorSequence,setCursorAnchor,cursorAnchoredFrame} from '../runtime/CursorAnchor.js';
import {MultilineEditor} from '../tui/MultilineEditor.js';
import React from 'react';
import {render} from 'ink';
import {PassThrough} from 'node:stream';
import {stripVTControlCharacters} from 'node:util';
import {modelPriceEndpoint,priceEndpoint} from '../session/Pricing.js';
const env={...process.env};fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/auth20-'));process.env.SPAWN_CONFIG_DIR=path.join(root,'config');
after(()=>{process.env={...env};fs.rmSync(root,{recursive:true,force:true});});
const vertex:ProviderConfig={provider:'openai',model:'gemini-2.5-flash',apiKey:'',transport:'vertex',cloud:{region:'global',project:'relay-fixture'},billing:{mode:'api'}};

test('OpenRouter PKCE uses a random loopback callback, rejects stray requests and exchanges only once',async()=>{
 let exchanges=0;const control=new AbortController();let callback:Promise<void>|undefined;
 const key=await openRouterOAuth(message=>{callback=(async()=>{
  const authorization=new URL(message.slice(message.indexOf('https://')));assert.equal(authorization.origin,'https://openrouter.ai');assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');assert.equal(authorization.searchParams.get('code_challenge')!.length,43);
  const target=new URL(authorization.searchParams.get('callback_url')!);assert.equal(target.hostname,'127.0.0.1');assert.equal((await fetch(new URL('/wrong',target))).status,400);target.searchParams.set('code','fixture-code');assert.equal((await fetch(target)).status,200);
 })();},control.signal,(async(url,options)=>{exchanges++;assert.equal(url,'https://openrouter.ai/api/v1/auth/keys');assert.equal(options!.redirect,'error');const body=JSON.parse(options!.body as string);assert.equal(body.code,'fixture-code');assert.equal(body.code_verifier.length,43);return Response.json({key:'fixture-oauth-key'});}) as typeof fetch);
 await callback;assert.equal(key,'fixture-oauth-key');assert.equal(exchanges,1);
});
test('OAuth and pending ADC cancellation finish promptly without saving credentials',async()=>{
 const control=new AbortController();await assert.rejects(openRouterOAuth(()=>control.abort(),control.signal),/cancelled/);
 const abort=new AbortController();const pending=cancellable(new Promise(()=>{}),abort.signal);abort.abort();await assert.rejects(pending,/cancelled/);
});
test('native login preserves cloud references and OpenRouter metered billing',()=>{
 for(const id of ['amazon-bedrock','google-vertex','openrouter']){
  let saved:ProviderConfig|undefined;const f=new LoginFlow((_name,cfg)=>{saved=cfg;});f.choose(0);f.choose(f.availableProviders.findIndex(p=>p.provider.id===id));
  if(id!=='openrouter'){assert.equal(f.stage,'region');f.submit('');f.submit(id==='google-vertex'?'relay-fixture':'');}
  assert.equal(f.stage,'subscription');assert.equal(f.choose(0),'login');f.authenticated(id==='openrouter'?'fixture-key':undefined);assert.equal(f.stage,'models');assert.ok(f.catalog.models.length);f.choose(0);f.choose(3);f.finish();assert.equal(saved!.billing!.mode,'api');assert.equal(saved!.apiKey,id==='openrouter'?'fixture-key':'');assert.equal(saved!.transport,id==='amazon-bedrock'?'bedrock':id==='google-vertex'?'vertex':undefined);
 }
});
test('cloud config rejects embedded credentials, endpoints and invalid project/region',()=>{
 validateBillingConfig(vertex);for(const patch of [{apiKey:'secret'},{baseUrl:'https://evil.example'},{billing:{mode:'subscription'}},{cloud:{region:'us/evil',project:'relay-fixture'}},{cloud:{region:'global',project:'../evil'}}])assert.throws(()=>validateBillingConfig({...vertex,...patch} as ProviderConfig));
 assert.equal(vertexEndpoint(vertex),'https://aiplatform.googleapis.com/v1/projects/relay-fixture/locations/global/endpoints/openapi/chat/completions');
 assert.notEqual(modelPriceEndpoint(vertex),priceEndpoint('openai'));assert.notEqual(modelPriceEndpoint(vertex),modelPriceEndpoint({...vertex,cloud:{region:'us-central1',project:'relay-fixture'}}));assert.notEqual(modelPriceEndpoint(vertex),modelPriceEndpoint({...vertex,cloud:{region:'global',project:'other-project'}}));
});
test('Bedrock SDK signs a real HTTP request and the normal agent receives the normalized reply',async()=>{
 let received:any;const server=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;received={headers:req.headers,path:req.url,body:JSON.parse(raw)};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({output:{message:{role:'assistant',content:[{text:'{"type":"message","text":"cloud-ok"}'}]}},usage:{inputTokens:12,outputTokens:8},stopReason:'end_turn',metrics:{latencyMs:1}}));});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 const old={...process.env};Object.assign(process.env,{AWS_ACCESS_KEY_ID:'fixture-access',AWS_SECRET_ACCESS_KEY:'fixture-secret',AWS_SESSION_TOKEN:'fixture-session',AWS_ENDPOINT_URL_BEDROCK_RUNTIME:`http://127.0.0.1:${(server.address() as any).port}`});delete process.env.AWS_PROFILE;
 const agent=new HttpConvAgent({id:'pm',role:'Leader',providerCfg:{provider:'openai',model:'amazon.nova-lite-v1:0',apiKey:'',transport:'bedrock',cloud:{region:'us-east-1'},billing:{mode:'api'}}});let text='';agent.on('event',e=>{if(e.type==='message')text=e.text;});
 try{await agent.send('hello');assert.equal(text,'cloud-ok');assert.match(received.headers.authorization,/AWS4-HMAC-SHA256/);assert.match(received.headers.authorization,/us-east-1\/bedrock\/aws4_request/);assert.equal(received.headers['x-amz-security-token'],'fixture-session');assert.equal(received.body.messages[0].content[0].text,'hello');assert.ok(received.body.inferenceConfig.maxTokens>0);}finally{agent.kill();process.env={...old};await new Promise<void>(r=>server.close(()=>r()));}
});
test('Vertex refreshes credentials per call, preserves measured usage and redacts failures',async()=>{
 let token=0;const deps={token:async()=>`fixture-${++token}`,fetcher:(async(url,options)=>{assert.equal(url,vertexEndpoint(vertex));assert.equal((options!.headers as any).Authorization,`Bearer fixture-${token}`);const body=JSON.parse(options!.body as string);assert.equal(body.model,'google/gemini-2.5-flash');assert.equal(body.max_tokens,55);return Response.json({choices:[{message:{content:'hello'}}],usage:{prompt_tokens:4,completion_tokens:3}});}) as typeof fetch};
 for(let i=0;i<2;i++){const r=await callCloud(vertex,'system',[{role:'user',content:'hi'}],55,undefined,deps);assert.equal(r.text,'hello');assert.equal(r.promptTokens,4);assert.equal(r.completionTokens,3);}assert.equal(token,2);
 await assert.rejects(callCloud(vertex,'',[],1,undefined,{token:async()=>{throw new Error('secret refresh token');}}),e=>e instanceof Error&&!e.message.includes('secret')&&e.message.includes('ADC'));
});
test('native caret is a visible bar and restores Ink position before the next frame',()=>{
 setCursorAnchor({enabled:true,focused:true,row:20,col:4});assert.equal(getCursorAnchorSequence(),'\x1b[20;4H\x1b[6 q\x1b[?25h');
 assert.equal(cursorAnchoredFrame('first'),'first\x1b7'+getCursorAnchorSequence());assert.equal(cursorAnchoredFrame('second'),'\x1b8second\x1b7'+getCursorAnchorSequence());
 setCursorAnchor({focused:false});assert.equal(getCursorAnchorSequence(),'\x1b[?25l');
});
test('real composer keeps Chinese/emoji text intact when moving and inserting inside it without reverse blocks',async()=>{
 const input=new PassThrough(),output=new PassThrough();Object.assign(input,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});Object.assign(output,{isTTY:true,columns:80,rows:24});let frames='',value='我需要🙂';output.on('data',c=>frames+=c.toString());const positions:number[]=[];
 function Composer(){const [text,setText]=React.useState(value);return React.createElement(MultilineEditor,{value:text,onChange:(s:string)=>{value=s;setText(s);},onSubmit:()=>{},onCursor:(p:number)=>positions.push(p)});}
 const widget=render(React.createElement(Composer),{stdin:input as any,stdout:output as any,stderr:output as any,debug:true,patchConsole:false,exitOnCtrlC:false});
 const until=async(check:()=>boolean)=>{const limit=Date.now()+5000;while(!check()){assert.ok(Date.now()<limit,'composer timeout');await new Promise(r=>setTimeout(r,10));}};
 const send=async(key:string)=>{await until(()=>input.listenerCount('readable')>0);await new Promise(r=>setImmediate(r));input.write(key);await until(()=>input.readableLength===0);await new Promise(r=>setTimeout(r,25));};
 try{await until(()=>positions.length>0);await send('\x1b[D');await until(()=>positions.at(-1)===3);await send('中文');await until(()=>value==='我需要中文🙂');assert.ok(stripVTControlCharacters(frames).includes('我需要中文🙂'));assert.doesNotMatch(frames,/\x1b\[7m/);}finally{widget.unmount();input.destroy();output.destroy();}
});
