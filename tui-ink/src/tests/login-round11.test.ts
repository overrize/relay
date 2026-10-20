import {test,beforeEach,afterEach} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {LoginFlow} from "../tui/loginFlow.js";
import {configPath,loadConfig,saveLoginModel,resolveModelConfigInput} from "../config.js";
import {officialSubscriptionLogin} from "../subscriptions/login.js";
import {buildCommands} from "../tui/commands.js";
import {runCopilot} from "../subscriptions/copilotBridge.js";
import {preparedCatalog,discoverModels} from "../models/catalog.js";
import React from "react";
import {render} from "ink";
import {PassThrough} from "node:stream";
import {LoginWizard} from "../tui/LoginWizard.js";
import {displayedPmModel,modelAssignmentSummary} from "../tui/modelLabels.js";
const original=process.cwd(),env={...process.env},scratch=fs.mkdtempSync(path.join(os.tmpdir(),"spawn-login11-"));
beforeEach(()=>{process.chdir(fs.mkdtempSync(path.join(scratch,"case-")));delete process.env.SPAWN_CONFIG_DIR;});
afterEach(()=>{process.chdir(original);process.env={...env};});
function custom(){const flow=new LoginFlow();flow.choose(1);flow.choose(2);flow.submit("https://fixture.example/v1");flow.submit("fixture-private-key");flow.catalog={models:[{id:"fixture-model",label:"Fixture model"}],source:"account"};flow.choose(0);flow.alias="configured";flow.choose(0);return flow;}
test("API wizard masks secrets in its view and saves role/routing together in the workspace",()=>{
  const flow=custom();assert.equal(flow.stage,"confirm");assert.doesNotMatch(JSON.stringify(flow.view()),/fixture-private-key/);assert.doesNotMatch(JSON.stringify(flow),/fixture-private-key/);flow.finish();
  const cfg=loadConfig();assert.equal(cfg.models.configured!.apiKey,"fixture-private-key");assert.equal(cfg.agents.worker.model,"configured");assert.deepEqual(cfg.routing!.profiles!.implement,["configured"]);assert.ok(configPath().startsWith(process.cwd()));
});
test("cancelling the wizard does not persist a key or start any model",()=>{
  const flow=custom();flow.dispose();assert.equal(fs.existsSync(configPath()),false);assert.throws(()=>flow.finish(),/incomplete|不完整/);
});
test("provider modes prevent a Copilot API key being presented as subscription",()=>{
  const flow=new LoginFlow();assert.deepEqual(flow.view().options,["账号登录（订阅）","API Key"]);flow.choose(1);assert.ok(flow.view().options.every(s=>!s.includes("Copilot")));const subscription=new LoginFlow();subscription.choose(0);subscription.choose(2);assert.equal(subscription.choose(0),"check");subscription.authFailed();assert.equal(subscription.stage,"subscription");assert.equal(fs.existsSync(configPath()),false);
});
test("subscription authentication is required before model configuration",()=>{
  const flow=new LoginFlow();flow.choose(0);flow.choose(0);assert.equal(flow.choose(1),"login");flow.authenticated();flow.catalog={models:[{id:"fixture-sub",label:"Fixture subscription"}],source:"account"};flow.choose(0);flow.alias="sub-model";flow.choose(1);flow.finish();const c=loadConfig();assert.equal(c.models["sub-model"]!.transport,"codex-cli");assert.equal(c.models["sub-model"]!.apiKey,"");assert.deepEqual(c.routing!.profiles!.pm,["sub-model"]);
});
test("endpoint validation rejects accidental credentials in URL",()=>{
  const flow=new LoginFlow();flow.choose(1);flow.choose(2);for(const value of ["file:///C:/secret","https://user:pass@host/v1","https://host/v1?api_key=secret"])assert.throws(()=>flow.submit(value));assert.equal(flow.stage,"endpoint");
});
test("explicit all-role assignment replaces ranked profiles while register-only preserves routes",()=>{
  saveLoginModel("first",resolveModelConfigInput("codex-subscription","fixture")!,"all");const before=loadConfig();saveLoginModel("second",resolveModelConfigInput("copilot-subscription","fixture")!,"register");assert.deepEqual(loadConfig().routing,before.routing);assert.equal(loadConfig().agents.leader.model,"first");
});
test("safe login command takes no credentials as arguments",()=>{
  let opened=0;const messages:string[]=[];const commands=buildCommands({startLogin:()=>opened++,emitCommandMessage:(text:string)=>messages.push(text)} as any);const cmd=commands.find(c=>c.name==="login")!;cmd.handler([]);assert.equal(opened,1);cmd.handler(["private-key"]);assert.equal(opened,1);assert.doesNotMatch(messages.join(""),/private-key/);
});
test("official Codex device login has no API credential fallback and verifies subscription status",async()=>{
  const calls:any[]=[];process.env.OPENAI_API_KEY="private-api";const run=async(_c:string,options:any)=>{calls.push(options);return Buffer.from(options.invocation.args.includes("status")?"Logged in using ChatGPT\n":"");};
  await officialSubscriptionLogin("codex",true,()=>{},new AbortController().signal,run as any);assert.deepEqual(calls[0].invocation.args,["login","--device-auth"]);assert.equal(calls[0].env.OPENAI_API_KEY,undefined);assert.equal(calls.length,2);
});
test("API-key login and cancelled auth cannot be accepted as subscription",async()=>{
  await assert.rejects(officialSubscriptionLogin("codex",false,()=>{},new AbortController().signal,(async()=>Buffer.from("Logged in using an API key")) as any),/subscription/);
  const control=new AbortController();control.abort();let calls=0;await assert.rejects(officialSubscriptionLogin("codex",false,()=>{},control.signal,(async()=>{calls++;return Buffer.from("");}) as any));assert.equal(calls,0);
});
test("Copilot auth-only verification performs no quota query or inference",async()=>{
  let stopped=false;const client={start:async()=>{},getAuthStatus:async()=>({isAuthenticated:false}),stop:async()=>{stopped=true;}};assert.deepEqual(await runCopilot({operation:"auth"},client as any),{authenticated:false});assert.equal(stopped,true);
});
test("DeepSeek login presents prepared model names without requiring a model ID",()=>{
  const flow=new LoginFlow();flow.choose(1);flow.choose(3);assert.equal(flow.stage,"key");flow.submit("fixture");assert.equal(flow.stage,"models");assert.ok(flow.view().options.includes("deepseek-flash"));assert.ok(flow.view().options.includes("deepseek-v4-pro"));flow.choose(0);assert.equal(flow.stage,"target");assert.equal(flow.model,flow.catalog.models[0]!.id);
});
test("account API model discovery uses the configured endpoint and key without inference",async()=>{
  let target="",auth="";const fetcher=async(url:any,options:any)=>{target=String(url);auth=options.headers.Authorization;assert.equal(options.redirect,"error");return new Response(JSON.stringify({data:[{id:"gateway-model",name:"Gateway Model"},{id:"gateway-model"}]}));};
  const result=await discoverModels("custom","api","https://gateway.example/v1","fixture-secret",new AbortController().signal,fetcher as any);assert.equal(target,"https://gateway.example/v1/models");assert.equal(auth,"Bearer fixture-secret");assert.deepEqual(result.models,[{id:"gateway-model",label:"Gateway Model"}]);assert.equal(result.source,"account");assert.doesNotMatch(JSON.stringify(result),/fixture-secret/);
});
test("failed or empty model APIs preserve prepared choices with an honest source",async()=>{
  const signal=new AbortController().signal;for(const status of [401,403,404,429]){const result=await discoverModels("deepseek","api","https://api.example/v1","fixture",signal,(async()=>new Response("private diagnostic",{status})) as any);assert.equal(result.source,"prepared");assert.equal(result.reason,`models-http-${status}`);assert.ok(result.models.length>0);assert.doesNotMatch(JSON.stringify(result),/private diagnostic/);}
  const empty=await discoverModels("custom","api","https://api.example/v1","fixture",signal,(async()=>new Response('{"data":[]}')) as any);assert.equal(empty.reason,"empty-model-catalog");
});
test("Anthropic paginated model discovery preserves the key only in its header",async()=>{
  let calls=0;const fetcher=async(url:any,options:any)=>{calls++;assert.equal(options.headers["x-api-key"],"fixture");if(calls===2)assert.equal(new URL(url).searchParams.get("after_id"),"first");return new Response(JSON.stringify(calls===1?{data:[{id:"first"}],has_more:true,last_id:"first"}:{data:[{id:"second"}],has_more:false}));};
  const result=await discoverModels("claude","api","https://api.example","fixture",new AbortController().signal,fetcher as any);assert.deepEqual(result.models.map(m=>m.id),["first","second"]);assert.equal(calls,2);
});
test("subscription model discovery is read-only and refuses hidden API inheritance",async()=>{
  process.env.OPENAI_API_KEY="secret";let invocation:any;const run=async(_c:string,options:any)=>{invocation=options;return Buffer.from(JSON.stringify({models:[{id:"subscription-model",name:"Subscription Model"}]}));};
  const result=await discoverModels("codex","subscription","","",new AbortController().signal,fetch,run as any);assert.equal(invocation.env.OPENAI_API_KEY,undefined);assert.equal(JSON.parse(invocation.invocation.input).operation,"models");assert.equal(result.models[0]!.id,"subscription-model");assert.equal(result.source,"account");
});
test("Claude subscription catalog is prepared without probing Claude",async()=>{
  let calls=0;const result=await discoverModels("claude","subscription","","",new AbortController().signal,(async()=>{calls++;throw Error();}) as any);assert.equal(calls,0);assert.equal(result.source,"prepared");assert.equal(result.reason,"claude-catalog-not-probed");assert.ok(preparedCatalog("copilot","subscription").models.length>0);
});
test("rendered wizard uses arrows, searchable providers and Enter rather than numeric shortcuts",async()=>{
  const input=new PassThrough(),output=new PassThrough();Object.assign(input,{isTTY:true,setRawMode:()=>{},ref:()=>{},unref:()=>{}});Object.assign(output,{isTTY:true,columns:110,rows:35});
  let frames="",cancelled=0;output.on("data",chunk=>{frames+=chunk.toString();});
  const widget=render(React.createElement(LoginWizard,{onDone:()=>assert.fail("No key was configured"),onCancel:()=>cancelled++}),{stdin:input as any,stdout:output as any,stderr:output as any,exitOnCtrlC:false,patchConsole:false});
  const pause=()=>new Promise(r=>setTimeout(r,40));
  try{await pause();input.write("2");await pause();assert.equal(frames.includes("搜索供应商"),false);input.write("\x1b[B");await pause();input.write("\r");await pause();assert.match(frames,/搜索供应商/);input.write("deepseek");await pause();input.write("\r");await pause();assert.match(frames,/API Key（隐藏输入/);assert.doesNotMatch(frames,/1\. 账号登录/);input.write("\x1b");await pause();assert.equal(cancelled,1);}finally{widget.unmount();input.end();output.end();}
});
test("PM labels use the configured PM route before startup and actual model after startup",()=>{
  const cfg=loadConfig();cfg.models.kimi={provider:"openai",model:"kimi-k3",apiKey:"fixture"};cfg.agents.leader.model="kimi";cfg.routing={profiles:{pm:["kimi"]}};
  assert.equal(displayedPmModel(cfg),"kimi-k3");assert.match(modelAssignmentSummary(cfg),/PM=kimi-k3/);assert.equal(displayedPmModel(cfg,{provider:"anthropic",model:"claude-current",apiKey:"fixture"}),"claude-current");
});
