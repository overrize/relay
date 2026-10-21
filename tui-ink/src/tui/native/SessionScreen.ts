import {Container,Editor,Text,TuiAltScreen,ScrollView,VStack,CombinedAutocompleteProvider,matchesKey,stripTerminalSequences,type Terminal,type SelectListTheme} from '@code-yeongyu/senpi-tui';
import type {SessionController} from '../../runtime/SessionController.js';
import {NativeWorkflow} from './Workflow.js';
import {rememberPrompt} from '../PromptHistory.js';
import {editExternally,cancelExternalEditor,terminalOwnership} from '../ExternalEditor.js';
import {NativeKeys} from './NativeKeys.js';
import {taskPanel,budgetPanel,auditPanel,parseAuditFilter,readableHistory} from './Panels.js';
import type {AuditFilter,auditReport} from '../../session/Audit.js';
type Port=Pick<SessionController,'send'|'revise'|'continue'|'resume'|'interrupt'|'snapshot'|'subscribe'|'shutdown'|'detach'|'modelChoices'|'selectModel'|'audit'|'transcript'>;
const muted=(s:string)=>`\x1b[90m${s}\x1b[39m`,accent=(s:string)=>`\x1b[35m${s}\x1b[39m`;
const selectList:SelectListTheme={selectedPrefix:accent,selectedText:accent,description:muted,scrollInfo:muted,noMatch:muted};
const commands=[{name:'login',description:'登录供应商 / API Key'},{name:'model',description:'选择模型 · 仅本次 / 保存默认'},{name:'history',description:'跨会话历史搜索 · Ctrl+R'},{name:'editor',description:'外部编辑器 · Ctrl+G'},{name:'revise',description:'明确变更目标，取消旧版本任务',requiresArgs:true},{name:'resume',description:'恢复持久会话与当前目标'},{name:'continue',description:'明确继续当前目标'},{name:'interrupt',description:'停止执行，保留当前目标'},{name:'audit',description:'长期审计面板'},{name:'chat',description:'返回聊天'},{name:'older',description:'加载更早会话历史'},{name:'keys',description:'重载自定义键位'},{name:'status',description:'查看当前状态'},{name:'tasks',description:'查看任务与停止原因'},{name:'budget',description:'查看预算'},{name:'detach',description:'断开界面，进程内后台继续运行'},{name:'exit',description:'停止本进程任务并退出，保留恢复记录'}];
export class SessionScreen {
 readonly tui:TuiAltScreen;readonly editor:Editor;readonly keys=new NativeKeys();readonly viewport:ScrollView;
 private transcript=new Text('',1,0);private stateLine=new Text('',1,0);private footer=new Text('',1,0);private notice=new Text('',1,0);
 private unsubscribe?:()=>void;private removeInput?:()=>void;private closed=false;private started=false;
 private dock=new Container();private workflow?:NativeWorkflow;private editing=false;private editorTask?:Promise<void>;
 private panel?:'tasks'|'budget'|'audit'|'keys';private panelIndex=0;private auditResult?:Awaited<ReturnType<typeof auditReport>>;private auditFilter:AuditFilter={limit:40};private readGeneration=0;private loading=false;
 private archiveRows:Awaited<ReturnType<SessionController['transcript']>>['rows']=[];private olderBefore?:number;private historyLoaded=false;private archiveThroughAt=0;private historyLoading=false;private expandedTools=false;
 constructor(private terminal:Terminal,private controller:Port,private onClose:(mode:'shutdown'|'detach')=>void=()=>{},logDirectory?:string){
  this.tui=new TuiAltScreen(terminal,true,logDirectory,{mouse:true,scrollToEndIndicator:()=>`↓ 最新 · ${this.keys.hint('app.viewport.end')}`});
  this.editor=new Editor(this.tui,{borderColor:muted,selectList},{paddingX:2});
  this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands,process.cwd(),null));
  this.editor.onSubmit=(text,details)=>{if(this.submit(text))this.editor.setText('');else this.editor.setText(details?.rawText??text);};
  this.dock.addChild(this.editor);this.viewport=new ScrollView(this.transcript,{follow:'end',primary:true,scrollbar:'auto',overscroll:'contain'});
  this.tui.setLayoutRoot(new VStack([
   {component:new Text(accent('Relay · Native · 真实 PM'),1,0),shrink:1,minSize:0,maxSize:1},
   {component:this.viewport,basis:0,grow:1,shrink:1,minSize:1},
   {component:this.stateLine,shrink:1,minSize:0,maxSize:2},
   {component:this.notice,shrink:1,minSize:0,maxSize:2},
   {component:this.dock,shrink:1,minSize:3},
   {component:this.footer,shrink:1,minSize:0,maxSize:2}
  ]));this.tui.setFocus(this.editor);
 }
 start(){if(this.closed)throw new Error('SCREEN_CLOSED');if(this.started)return;this.started=true;
  this.keys.install();try{this.keys.reload();}catch(error){this.notice.setText(`快捷键配置无效，使用默认键位：${error instanceof Error?error.message:''}`);}
  this.unsubscribe=this.controller.subscribe(snapshot=>this.update(snapshot));
  this.removeInput=this.tui.addInputListener(data=>this.handleInput(data));
  this.tui.start();this.terminal.write('\x1b[6 q');
 }
 private handleInput(raw:string){
  const key=this.keys.translate(raw,this.workflow?.scope??'compose'),action=key.action,data=key.data;
  if(this.workflow)return {data};
  const consumed={consume:true};
  if(action==='app.history.search'){this.openWorkflow('history');return consumed;}
  if(action==='app.model.select'){this.openWorkflow('model');return consumed;}
  if(action==='app.editor.external'){void this.externalEditor();return consumed;}
  if(action==='app.clear'){if(this.editor.getText()){this.editor.setText('');this.tui.requestRender();}else void this.close();return consumed;}
  if(action==='app.exit'){if(!this.editor.getText())void this.close();return consumed;}
  if(action==='app.interrupt'&&!this.editor.isShowingAutocomplete()){
   if(this.panel){this.panel=undefined;this.readGeneration++;this.update(this.controller.snapshot());this.viewport.scrollToEnd();}else this.controller.interrupt();return consumed;
  }
  if(action==='app.viewport.up'||action==='app.viewport.down'){this.viewport.scrollBy((action==='app.viewport.up'?-1:1)*Math.max(1,this.viewport.viewportHeight-2));return consumed;}
  if(action==='app.viewport.end'){this.viewport.scrollToEnd();return consumed;}
  if(action==='app.panel.previous'||action==='app.panel.next'){this.panelIndex=Math.max(0,this.panelIndex+(action==='app.panel.previous'?-1:1));this.update(this.controller.snapshot());this.viewport.scrollTo(0,{disableFollow:true});return consumed;}
  if(action==='app.panel.more'){if(this.panel==='audit')void this.loadAudit(true);else if(!this.panel)void this.loadOlder();return consumed;}
  if(action==='app.panel.refresh'){if(this.panel==='audit')void this.loadAudit();else this.update(this.controller.snapshot());return consumed;}
  if(action==='app.agents.toggle'){this.openPanel('tasks');return consumed;}
  if(action==='app.tools.expand'){this.expandedTools=!this.expandedTools;this.update(this.controller.snapshot());return consumed;}
  if(action==='app.model.cycleForward'||action==='app.model.cycleBackward'){
   const choices=this.controller.modelChoices(),current=this.controller.snapshot().model,i=choices.findIndex(c=>c.model===current),next=choices[(i+(action==='app.model.cycleForward'?1:-1)+choices.length)%choices.length];
   if(next){this.notice.setText(this.controller.selectModel(next.name,'session'));this.update(this.controller.snapshot());}return consumed;
  }
  if(action==='app.thinking.cycle'||action==='app.thinking.toggle'){this.notice.setText('当前接入未提供可调整的推理能力；未修改模型或分工策略。');this.tui.requestRender();return consumed;}
  if(action==='tui.editor.redo'){this.notice.setText('当前原生编辑器不提供重做；撤销可用，未插入其他文本。');this.tui.requestRender();return consumed;}
  return {data};
 }
 openPanel(kind:'tasks'|'budget'|'audit'|'keys',args=''){
  if(kind==='audit')this.auditFilter=parseAuditFilter(args);this.readGeneration++;this.loading=false;this.panel=kind;this.panelIndex=0;this.update(this.controller.snapshot());this.viewport.scrollTo(0,{disableFollow:true});if(kind==='audit')void this.loadAudit();
 }
 private async loadAudit(more=false){
  if(this.loading||this.panel!=='audit')return;if(more&&!this.auditResult?.nextBefore)return;
  const generation=++this.readGeneration;this.loading=true;if(more)this.auditFilter={...this.auditFilter,before:this.auditResult!.nextBefore};this.auditResult=undefined;
  this.transcript.setText('审计面板 · 正在后台校验与读取；PM 继续运行。');this.tui.requestRender();
  try{const result=await this.controller.audit(this.auditFilter);if(this.closed||generation!==this.readGeneration)return;this.auditResult=result;this.panelIndex=0;this.update(this.controller.snapshot());this.viewport.scrollTo(0,{disableFollow:true});}
  catch{if(!this.closed&&generation===this.readGeneration){this.transcript.setText('审计读取失败：请检查历史完整性或并发写入；不显示部分统计。刷新后重试。');this.tui.requestRender();}}
  finally{if(generation===this.readGeneration)this.loading=false;}
 }
 async loadOlder(){
  if(this.closed||this.panel||this.historyLoading||(this.historyLoaded&&!this.olderBefore))return;this.historyLoading=true;
  try{const page=await this.controller.transcript(this.olderBefore);if(this.closed)return;if(!this.historyLoaded)this.archiveThroughAt=page.throughAt;this.archiveRows=[...page.rows,...this.archiveRows];this.olderBefore=page.nextBefore;this.historyLoaded=true;this.update(this.controller.snapshot());this.tui.renderNow();if(!this.panel)this.viewport.scrollTo(0,{disableFollow:true});this.notice.setText(`已加载历史 ${this.archiveRows.length} 条${page.nextBefore?'；可继续加载更早记录':'；已到保留历史开头'}`);this.tui.requestRender();}
  catch{if(!this.closed){this.notice.setText('历史读取失败；请检查归档完整性后重试。');this.tui.requestRender();}}finally{this.historyLoading=false;}
 }
 openWorkflow(kind:'login'|'model'|'history'){
  if(this.closed||this.editing||this.workflow)return;
  const workflow=new NativeWorkflow(()=>this.tui.requestRender(),message=>{
   workflow.dispose();this.workflow=undefined;this.dock.clear();this.dock.addChild(this.editor);this.tui.setFocus(this.editor);if(message)this.notice.setText(message);this.update(this.controller.snapshot());
  },()=>`${this.keys.hint('tui.select.up')}/${this.keys.hint('tui.select.down')} 选择 · ${this.keys.hint('tui.select.confirm')} 确认 · ${this.keys.hint('tui.select.cancel')} 取消`);
  this.workflow=workflow;this.dock.clear();this.dock.addChild(workflow);this.tui.setFocus(workflow);
  try{if(kind==='login')workflow.login();else if(kind==='model')workflow.models(this.controller.modelChoices(),(name,scope,role)=>this.controller.selectModel(name,scope,role));else workflow.history(text=>this.editor.setText(text));}
  catch{workflow.dispose();this.workflow=undefined;this.dock.clear();this.dock.addChild(this.editor);this.tui.setFocus(this.editor);this.notice.setText('无法读取配置或历史；草稿保留。');this.tui.requestRender();}
 }
 async externalEditor(){
  if(this.closed||this.workflow||this.editing)return;this.editing=true;const original=this.editor.getExpandedText();
  this.editorTask=(async()=>{try{
   const result=await editExternally(original,{suspend:()=>{terminalOwnership.external=true;this.tui.stop();this.terminal.write('\x1b[0 q');},resume:()=>{terminalOwnership.external=false;if(!this.closed){this.tui.start();this.terminal.write('\x1b[6 q');this.tui.setFocus(this.editor);}}});
   if(!this.closed){if(result.status==='complete')this.editor.setText(result.content??original);this.notice.setText(result.status==='complete'?'编辑完成，尚未发送。':`${result.reason} · 恢复文件：${result.recoveryPath}`);}
  }catch{if(!this.closed)this.notice.setText('请配置 editor.json 或 VISUAL / EDITOR；草稿保留。');}
  finally{this.editing=false;if(!this.closed)this.tui.requestRender(true);}})();await this.editorTask;
 }
 private update(s:ReturnType<SessionController['snapshot']>){
  const max=this.expandedTools?24000:6000;
  const messages=s.messages.filter(m=>!this.historyLoaded||m.ts>this.archiveThroughAt).map(m=>`${m.agent==='user'?'你':m.agent}：${stripTerminalSequences(m.text).slice(-max)}`);
  if(!this.historyLoaded&&!messages.length&&s.history.length)messages.push(...s.history.slice(-20).map(m=>`[恢复历史 ${m.role}] ${stripTerminalSequences(readableHistory(m.content)).slice(-max)}`));
  if(this.panel==='tasks'){this.panelIndex=Math.min(this.panelIndex,Math.max(0,s.tasks.length-1));this.transcript.setText(stripTerminalSequences(taskPanel(s,this.panelIndex)));}
  else if(this.panel==='budget')this.transcript.setText(stripTerminalSequences(budgetPanel(s)));
  else if(this.panel==='keys')this.transcript.setText('自定义快捷键 · keybindings.json · /keys 重新读取\n'+this.keys.bindings.report());
  else if(this.panel==='audit'){if(this.auditResult){this.panelIndex=Math.min(this.panelIndex,Math.max(0,this.auditResult.rows.length-1));this.transcript.setText(stripTerminalSequences(auditPanel(this.auditResult,this.panelIndex)));}}
  else this.transcript.setText([...this.archiveRows.map(r=>`[历史 #${r.seq} · v${r.revision}] ${r.role}：${stripTerminalSequences(readableHistory(r.text)).slice(-max)}`),...messages].join('\n\n'));
  const active=s.agents.filter(a=>a.activity==='model-running'||a.activity==='tool-running').map(a=>`${a.id} (${a.activity==='tool-running'?'工具执行中':'模型响应中'})`).join(', ')||'无';
  const pending=s.inputs.filter(i=>i.status==='pending').length,started=s.inputs.filter(i=>i.status==='started').length;
  const stateText=`执行中：${active} · 输入处理中 ${started} / 排队 ${pending}${s.recoverable?' · /resume 恢复':''}\n目标 v${s.revision}：${stripTerminalSequences(s.goal).replace(/\s+/g,' ').slice(0,160)||'等待首条任务'}`;
  this.stateLine.setText(stateText);
  const panelHints=`${this.keys.hint('app.interrupt')} 返回 · ${this.keys.hint('app.panel.previous')}/${this.keys.hint('app.panel.next')} 选择 · ${this.keys.hint('app.panel.refresh')} 刷新`;
  this.footer.setText(muted(`${s.model} · ${this.keys.hint('tui.input.submit')} 沟通 · ${this.keys.hint('app.viewport.up')}/${this.keys.hint('app.viewport.down')} 滚动 · ${this.keys.hint('app.panel.more')} 更早 · ${this.panel?panelHints:'/tasks /audit /budget · /revise 改目标'}`));if(!this.editing)this.tui.requestRender();
 }
 submit(text:string):boolean{
  if(this.closed||!text.trim())return false;
  try{
   const command=/^\/(\w+)(?:\s+([\s\S]*))?$/.exec(text.trim());
   if(command){const [,name,args]=command;
    if(name==='login'||name==='model'||name==='models'||name==='history'){this.openWorkflow(name==='models'?'model':name);return true;}
    else if(name==='editor'){void this.externalEditor();return true;}
    else if(name==='revise')this.controller.revise(args??'');
    else if(name==='resume')this.controller.resume();else if(name==='continue')this.controller.continue();else if(name==='interrupt')this.controller.interrupt();
    else if(name==='tasks'||name==='budget'||name==='audit'){this.openPanel(name,args);return true;}
    else if(name==='chat'){this.panel=undefined;this.readGeneration++;this.update(this.controller.snapshot());this.viewport.scrollToEnd();return true;}
    else if(name==='older'){void this.loadOlder();return true;}
    else if(name==='keys'){this.keys.reload();this.openPanel('keys');return true;}
    else if(name==='status'){const s=this.controller.snapshot();this.notice.setText(`目标 v${s.revision} · ${s.goal} · 可恢复 ${s.recoverable}`);}
    else if(name==='exit'||name==='detach'){void this.close(name==='exit'?'shutdown':'detach');return true;}
    else throw new Error('未知命令；输入 / 后用方向键查看可用命令。');
   }else this.controller.send(text);
   if(!['status','tasks','budget'].includes(command?.[1]??''))this.notice.setText('');this.editor.addToHistory(text);try{rememberPrompt(text);}catch{this.notice.setText('输入已接收，但历史保存失败；请检查配置目录。');}this.tui.requestRender();return true;
  }catch(error){this.notice.setText(error instanceof Error?error.message:'提交失败；草稿保留');this.tui.requestRender();return false;}
 }
 async close(mode:'shutdown'|'detach'='shutdown'){
  if(this.closed){if(mode==='shutdown')await this.controller.shutdown();return;}
  if(mode==='detach')try{this.controller.detach();}catch(error){this.notice.setText(error instanceof Error?error.message:'无法断开');this.tui.requestRender();return;}
  this.closed=true;this.workflow?.dispose();this.unsubscribe?.();this.removeInput?.();if(this.editing){cancelExternalEditor();await this.editorTask;}if(this.started&&!terminalOwnership.external){this.tui.stop();this.terminal.write('\x1b[0 q');}
  if(mode==='shutdown')await this.controller.shutdown();this.onClose(mode);
 }
}
