import {Container,Editor,SelectList,Text,TuiMainScreen,CombinedAutocompleteProvider,matchesKey,type Terminal,type SelectListTheme} from '@code-yeongyu/senpi-tui';

const accent=(text:string)=>`\x1b[35m${text}\x1b[39m`;
const muted=(text:string)=>`\x1b[90m${text}\x1b[39m`;
const selectTheme:SelectListTheme={selectedPrefix:accent,selectedText:accent,description:muted,scrollInfo:muted,noMatch:muted};
const commands=[{name:'models',description:'模型选择与草稿恢复验证'},{name:'background',description:'模拟后台状态更新，继续编辑输入'},{name:'help',description:'查看本阶段的验证范围'},{name:'exit',description:'退出验证版'}];

/**
 * Interaction-only migration spike, deliberately unable to call providers or tools.
 * Uses OmO's pinned terminal toolkit, not Relay's Ink input/output shims.
 */
export class NativeWorkbench {
 readonly tui:TuiMainScreen;
 readonly editor:Editor;
 private transcript=new Container();
 private dock=new Container();
 private footer=new Text('',1,0);
 private menu?:SelectList;
 private ticks=0;
 private ticker?:ReturnType<typeof setInterval>;
 private activeModel:string;
 private started=false;
 private closed=false;
 private readonly removeInputListener:()=>void;

 constructor(private terminal:Terminal,private models:string[],private onExit=()=>{},logDirectory?:string){
  this.activeModel=models[0]??'未配置';
  this.tui=new TuiMainScreen(terminal,true,logDirectory);
  this.editor=new Editor(this.tui,{borderColor:muted,selectList:selectTheme},{paddingX:2});
  this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands,process.cwd(),null));
  this.editor.onSubmit=text=>{this.editor.setText('');this.submit(text);};
  this.dock.addChild(this.editor);
  this.tui.addChild(new Text(accent('Relay · OmO 交互迁移验证版'),1,0));
  this.tui.addChild(new Text('仅验证输入与渲染；不调用模型、不执行工具、不保存配置。/help 查看范围。',1,0));
  this.tui.addChild(this.transcript);this.tui.addChild(this.dock);this.tui.addChild(this.footer);
  this.tui.setFocus(this.editor);this.updateFooter();
  this.removeInputListener=this.tui.addInputListener(data=>{
   if(matchesKey(data,'ctrl+c')){this.close();return {consume:true};}
   if(this.menu&&matchesKey(data,'esc')){this.closeModels();return {consume:true};}
   if(!this.menu&&matchesKey(data,'ctrl+l')){this.openModels();return {consume:true};}
   return undefined;
  });
 }
 start(){if(this.closed)throw new Error('Workbench is closed');if(!this.started){this.started=true;this.tui.start();this.terminal.write('\x1b[6 q');}}
 close(){if(this.closed)return;this.closed=true;if(this.ticker)clearInterval(this.ticker);this.removeInputListener();if(this.started){this.tui.stop();this.terminal.write('\x1b[0 q');}this.onExit();}
 private updateFooter(){this.footer.setText(muted(`验证模型：${this.activeModel} · 后台事件 ${this.ticks} · Enter 发送 · Alt+Enter 换行 · Ctrl+L 模型 · Ctrl+C 退出`));this.tui.requestRender();}
 private append(text:string){this.transcript.addChild(new Text(text,1,0));this.tui.requestRender();}
 submit(text:string){
  if(this.closed||!text.trim())return;
  if(text==='/exit'){this.close();return;}
  if(text==='/models'){this.openModels();return;}
  if(text==='/background'){this.simulateBackground();return;}
  if(text==='/help'){
   this.append('验证：中文/emoji、多行与粘贴、斜杠菜单方向键、模型列表、取消后草稿恢复、后台更新时输入保持。\n尚未接入：真实 PM、认证、执行、跨会话历史及预算。正式 Relay 使用原启动命令。');return;
  }
  if(text.startsWith('/')){this.append('未接入的命令；本验证版支持 /models /background /help /exit。');return;}
  this.editor.addToHistory(text);
  this.append(`你：${text}\n[交互回显，非模型回复] 输入已完整接收。`);
 }
 openModels(){
  if(this.closed||this.menu)return;
  this.menu=new SelectList(this.models.map(model=>({value:model,label:model,description:'仅验证版本次选择；不保存默认、不影响正式 PM'})),7,selectTheme);
  this.menu.onSelect=item=>{this.activeModel=item.value;this.closeModels();};
  this.menu.onCancel=()=>this.closeModels();
  this.dock.clear();this.dock.addChild(new Text(accent('选择模型 · ↑↓ / Enter · Esc 返回草稿'),1,0));this.dock.addChild(this.menu);this.tui.setFocus(this.menu);this.tui.requestRender();
 }
 closeModels(){if(!this.menu)return;this.menu=undefined;this.dock.clear();this.dock.addChild(this.editor);this.tui.setFocus(this.editor);this.updateFooter();}
 simulateBackground(){
  if(this.closed)return;if(this.ticker)clearInterval(this.ticker);
  this.append('[模拟后台事件] 接下来每 250ms 更新状态；可以继续输入、移动光标或打开模型列表。');
  let count=0;this.ticker=setInterval(()=>{this.ticks++;this.updateFooter();if(++count===20){clearInterval(this.ticker);this.ticker=undefined;}},250);
 }
}
