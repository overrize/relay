import {randomUUID} from 'node:crypto';
import {agents,secretaries,killedAgents,killAgent,shutdownRuntime} from './SessionRuntime.js';
import {startLeaderAgent} from './AgentHandlers.js';
import {replaceAgentForResume} from './OrchestratorRuntime.js';
import {getState,subscribe,ensureAgent,userMessage,applyEvent,markPendingInput,updateAgentInfo} from '../store.js';
import {sessionJournal} from '../session/Journal.js';
import {registerRuntimeOwner} from '../session/RuntimeOwner.js';
import {startHttpServer} from '../server/httpServer.js';
import type {Server} from 'node:http';
import {loadConfig,getAgentProviderConfig,selectSessionModel,saveAgentModel} from '../config.js';
import {resolveModelRoute} from '../models/routing.js';
import {budgetReport} from '../session/Budget.js';
import {workItems} from '../session/Tasks.js';
import {interruptSession} from '../session/Control.js';
import {waitForIndexing} from '../session/SearchIndex.js';
import {backgroundAuditReport} from '../session/BackgroundAudit.js';
import type {AuditFilter} from '../session/Audit.js';
import {transcriptPage,closeTranscriptReaders} from '../session/Transcript.js';

export class SessionController {
 private started=false;private stopping?:Promise<void>;private server?:Server;private root=process.cwd();private communicationAttach=false;
 private reads=new Set<Promise<unknown>>();
 private read<T>(job:Promise<T>):Promise<T>{this.reads.add(job);void job.finally(()=>this.reads.delete(job)).catch(()=>{});return job;}
 audit(filter:AuditFilter={}){this.ready();return this.read(backgroundAuditReport(this.root,filter));}
 transcript(before?:number){this.ready();return this.read(transcriptPage(this.root,before));}
 private model(){const cfg=loadConfig();try{return agents.get('pm')?.cfg.providerCfg.model??resolveModelRoute(cfg,'leader','pm').candidates[0]!.config.model;}catch{return getAgentProviderConfig(cfg,'leader').model;}}
 start(options:{http?:boolean}={}){
  if(this.started)return;registerRuntimeOwner(this.root);this.started=true;
  ensureAgent({id:'pm',name:'pm',role:'Leader',state:'idle',model:this.model()});
  if(options.http){
   this.server=startHttpServer({enabled:process.env.SERVER_ENABLED!=='false',port:Number(process.env.SERVER_PORT??3001),onMessage:(text,id)=>{this.send(text,{inputId:id,echo:false});}})??undefined;
   this.server?.on('error',()=>applyEvent({v:1,type:'message',agent:'pm',to:'user',text:'HTTP 服务未启动，请检查端口占用；本地会话可继续，/detach 暂不可用。'}));
  }
 }
 private ready(){if(!this.started||this.stopping)throw new Error('SESSION_NOT_RUNNING');if(process.cwd()!==this.root)throw new Error('SESSION_WORKSPACE_CHANGED');}
 modelChoices(){this.ready();return Object.entries(loadConfig().models).filter(([,c])=>!!c.apiKey||(c.transport??'http')!=='http').map(([name,c])=>({name,model:c.model,billing:c.billing?.mode??'api'}));}
 selectModel(name:string,scope:'session'|'default',role:'leader'|'worker'='leader'){
  this.ready();if(!(scope==='default'?saveAgentModel(role,name):selectSessionModel(role,name)))throw new Error('MODEL_NOT_CONFIGURED');
  const config=getAgentProviderConfig(loadConfig(),role);
  if(role==='leader'){const agent=agents.get('pm');agent?.once('modelChanged',(model:string)=>updateAgentInfo('pm',{model}));agent?.selectModel({name,config});}
  return `${role==='leader'?'PM':'Worker'} → ${config.model}（${scope==='default'?'已保存默认':'仅本次使用'}）；进行中的请求保持原模型，后续请求生效。`;
 }
 send(text:string,options:{target?:string;inputId?:string;echo?:boolean;kind?:'query'|'change'|'continue'|'constraint'}={}){
  this.ready();if(!text.trim())throw new Error('EMPTY_INPUT');const id=options.inputId??randomUUID(),target=options.target??'pm';
  if(target==='pm'&&!agents.has('pm')){
   killedAgents.delete('pm');
   const existed=sessionJournal().binding('pm');
   if(existed){startLeaderAgent({id:'pm',resumedMemoryId:'pm',promptFile:'pm',deferInitial:true});this.communicationAttach=true;}
   else startLeaderAgent({id:'pm',firstMessage:text,inputId:id,promptFile:'pm'});
   if(!agents.has('pm'))throw new Error('SESSION_START_REJECTED');
   if(!existed){if(options.echo!==false)userMessage(target,text);return id;}
  }
  const agent=agents.get(target);if(!agent)throw new Error('SESSION_AGENT_NOT_AVAILABLE');
  killedAgents.delete(target);
  const journal=sessionJournal(),prior=journal.current(target)?.inputs.some(i=>i.id===id);
  const directive=/^\/(revise|goal|constraint)\s/i.exec(text),kind=options.kind??(directive?(directive[1]!.toLowerCase()==='constraint'?'constraint':'change'):/^(继续|接着做|continue|resume)[。！!\s]*$/i.test(text.trim())?'continue':'query');
  if(!prior)markPendingInput(target);
  agent.receiveUserInput(text,id,kind);if(kind!=='query')this.communicationAttach=false;
  if(options.echo!==false&&!prior)userMessage(target,text);return id;
 }
 revise(goal:string,inputId?:string){if(!goal.trim())throw new Error('EMPTY_GOAL');return this.send(goal,{inputId,kind:'change'});}
 continue(){this.ready();if(this.communicationAttach||(!agents.has('pm')&&sessionJournal().binding('pm')))return this.resume();return this.send('继续',{kind:'continue'});}
 detach(){this.ready();if(!this.server?.listening)throw new Error('DETACH_REQUIRES_HTTP');this.server.ref();return {pid:process.pid,address:this.server.address()};}
 resume(){
  this.ready();const j=sessionJournal();if(!j.binding('pm'))throw new Error('SESSION_NOT_FOUND');
  if(agents.has('pm')){
   if(!killedAgents.has('pm')&&!this.communicationAttach)throw new Error('会话已连接；用 /continue 继续，或 /interrupt 后再 /resume。');
   replaceAgentForResume('pm',{agents,secretaries,killedAgents});
  }
  startLeaderAgent({id:'pm',resumedMemoryId:'pm',promptFile:'pm'});
  this.communicationAttach=false;
  if(!agents.has('pm'))throw new Error('SESSION_RESUME_REJECTED');
 }
 interrupt(){
  this.ready();interruptSession('pm');
  killAgent('pm','user interrupted');applyEvent({v:1,type:'message',agent:'pm',to:'user',text:'执行已停止；/resume 恢复前会核对当前状态，/revise 设置新目标。'});
 }
 snapshot(){
  this.ready();const j=sessionJournal(),current=j.current('pm'),state=getState();
  const activeTools=Object.entries(current?.tools??{}).filter(([,t])=>t.status==='pending'&&t.revision===current?.revision).map(([id,t])=>({id,agent:t.agent,name:t.name}));
  return structuredClone({revision:current?.revision??0,goal:current?.goal??'',inputs:current?.inputs??[],activeTools,agents:[...state.agents.values()].map(a=>({...a,activity:activeTools.some(t=>t.agent===a.id)?'tool-running':killedAgents.has(a.id)?'stopped':a.state==='run'?'model-running':state.pendingInputAgents.has(a.id)?'queued':a.state})),messages:(state.messagesByAgent.get('pm')??[]).slice(-150),history:j.history('pm').slice(-20),tasks:workItems(),budget:budgetReport(),recoverable:!!j.binding('pm')&&(!agents.has('pm')||this.communicationAttach),model:this.model()});
 }
 subscribe(listener:(snapshot:ReturnType<SessionController['snapshot']>)=>void){this.ready();const deliver=()=>{if(!this.stopping)try{listener(this.snapshot());}catch{process.stderr.write('[session-ui] subscriber failed\n');}};const off=subscribe(deliver);deliver();return off;}
 async shutdown(){if(this.stopping)return this.stopping;this.stopping=(async()=>{this.server?.closeAllConnections();if(this.server)await new Promise<void>(r=>this.server!.close(()=>r()));await shutdownRuntime();await closeTranscriptReaders(this.root);await Promise.allSettled([...this.reads]);await waitForIndexing();})();return this.stopping;}
}
export const sessionController=new SessionController();
