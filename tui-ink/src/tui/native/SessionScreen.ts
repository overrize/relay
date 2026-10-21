import {Container,Editor,Text,TuiMainScreen,CombinedAutocompleteProvider,matchesKey,stripTerminalSequences,type Terminal,type SelectListTheme} from '@code-yeongyu/senpi-tui';
import type {SessionController} from '../../runtime/SessionController.js';
type Port=Pick<SessionController,'send'|'revise'|'continue'|'resume'|'interrupt'|'snapshot'|'subscribe'|'shutdown'|'detach'>;
const muted=(s:string)=>`\x1b[90m${s}\x1b[39m`,accent=(s:string)=>`\x1b[35m${s}\x1b[39m`;
const selectList:SelectListTheme={selectedPrefix:accent,selectedText:accent,description:muted,scrollInfo:muted,noMatch:muted};
const commands=[{name:'revise',description:'明确变更目标，取消旧版本任务',requiresArgs:true},{name:'resume',description:'恢复持久会话与当前目标'},{name:'continue',description:'明确继续当前目标'},{name:'interrupt',description:'停止执行，保留当前目标'},{name:'status',description:'查看当前状态'},{name:'tasks',description:'查看任务与停止原因'},{name:'budget',description:'查看预算'},{name:'detach',description:'断开界面，进程内后台继续运行'},{name:'exit',description:'停止本进程任务并退出，保留恢复记录'}];
export class SessionScreen {
 readonly tui:TuiMainScreen;readonly editor:Editor;
 private transcript=new Text('',1,0);private stateLine=new Text('',1,0);private footer=new Text('',1,0);private notice=new Text('',1,0);
 private unsubscribe?:()=>void;private removeInput?:()=>void;private closed=false;private started=false;
 constructor(private terminal:Terminal,private controller:Port,private onClose:(mode:'shutdown'|'detach')=>void=()=>{},logDirectory?:string){
  this.tui=new TuiMainScreen(terminal,true,logDirectory);
  this.editor=new Editor(this.tui,{borderColor:muted,selectList},{paddingX:2});
  this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands,process.cwd(),null));
  this.editor.onSubmit=(text,details)=>{if(this.submit(text))this.editor.setText('');else this.editor.setText(details?.rawText??text);};
  this.tui.addChild(new Text(accent('Relay · Native · 真实 PM'),1,0));this.tui.addChild(this.transcript);this.tui.addChild(this.stateLine);this.tui.addChild(this.notice);this.tui.addChild(this.editor);this.tui.addChild(this.footer);this.tui.setFocus(this.editor);
 }
 start(){if(this.closed)throw new Error('SCREEN_CLOSED');if(this.started)return;this.started=true;
  this.unsubscribe=this.controller.subscribe(snapshot=>this.update(snapshot));
  this.removeInput=this.tui.addInputListener(data=>{if(matchesKey(data,'ctrl+c')){void this.close('shutdown');return {consume:true};}if(matchesKey(data,'esc')&&!this.editor.isShowingAutocomplete()){this.controller.interrupt();return {consume:true};}return undefined;});
  this.tui.start();this.terminal.write('\x1b[6 q');
 }
 private update(s:ReturnType<SessionController['snapshot']>){
  const messages=s.messages.slice(-60).map(m=>`${m.agent==='user'?'你':m.agent}：${stripTerminalSequences(m.text).slice(-6000)}`);
  if(!messages.length&&s.history.length)messages.push(...s.history.slice(-6).map(m=>`[恢复历史 ${m.role}] ${stripTerminalSequences(m.content).slice(-1200)}`));
  this.transcript.setText(messages.join('\n\n'));
  const active=s.agents.filter(a=>a.activity==='model-running'||a.activity==='tool-running').map(a=>`${a.id} (${a.activity==='tool-running'?'工具执行中':'模型响应中'})`).join(', ')||'无';
  const pending=s.inputs.filter(i=>i.status==='pending').length,started=s.inputs.filter(i=>i.status==='started').length;
  const stateText=`目标 v${s.revision}：${stripTerminalSequences(s.goal)||'等待首条任务'}\n执行中：${active} · 输入处理中 ${started} / 排队 ${pending}${s.recoverable?' · 发现可恢复会话：/resume':''}`;
  const inputLines=s.inputs.filter(i=>i.status==='pending'||i.status==='started').slice(-4).map(i=>`${i.status==='started'?'处理中':'排队'}：${stripTerminalSequences(i.text).slice(0,160)}`);
  const taskLines=s.tasks.slice(-4).map(t=>`任务 ${t.latestAgent}：${t.status}${t.reason?' · '+stripTerminalSequences(t.reason).slice(0,180):''}`);
  this.stateLine.setText([stateText,...inputLines,...taskLines].join('\n'));
  this.footer.setText(muted(`${s.model} · Enter 沟通 · Alt+Enter 换行 · /revise 修改目标 · Esc 停止 · /exit 停止并退出`));this.tui.requestRender();
 }
 submit(text:string):boolean{
  if(this.closed||!text.trim())return false;
  try{
   const command=/^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
   if(command){const [,name,args]=command;
    if(name==='revise')this.controller.revise(args??'');
    else if(name==='resume')this.controller.resume();else if(name==='continue')this.controller.continue();else if(name==='interrupt')this.controller.interrupt();
    else if(name==='status'||name==='tasks'||name==='budget'){const s=this.controller.snapshot();this.notice.setText(JSON.stringify(name==='tasks'?s.tasks:name==='budget'?s.budget:{goal:s.goal,revision:s.revision,inputs:s.inputs,agents:s.agents},null,2));}
    else if(name==='exit'||name==='detach'){void this.close(name==='exit'?'shutdown':'detach');return true;}
    else throw new Error('该命令尚未迁移；阶段三会补上登录、模型配置、历史搜索和外部编辑器。');
   }else this.controller.send(text);
   if(!['status','tasks','budget'].includes(command?.[1]??''))this.notice.setText('');this.editor.addToHistory(text);this.tui.requestRender();return true;
  }catch(error){this.notice.setText(error instanceof Error?error.message:'提交失败；草稿保留');this.tui.requestRender();return false;}
 }
 async close(mode:'shutdown'|'detach'='shutdown'){
  if(this.closed){if(mode==='shutdown')await this.controller.shutdown();return;}
  if(mode==='detach')try{this.controller.detach();}catch(error){this.notice.setText(error instanceof Error?error.message:'无法断开');this.tui.requestRender();return;}
  this.closed=true;this.unsubscribe?.();this.removeInput?.();if(this.started){this.tui.stop();this.terminal.write('\x1b[0 q');}
  if(mode==='shutdown')await this.controller.shutdown();this.onClose(mode);
 }
}
