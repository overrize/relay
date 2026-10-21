import {Input,Text,matchesKey,stripTerminalSequences,type Component} from '@code-yeongyu/senpi-tui';
import {LoginFlow} from '../loginFlow.js';
import {officialSubscriptionLogin} from '../../subscriptions/login.js';
import {openRouterOAuth} from '../../subscriptions/openrouterOAuth.js';
import {searchPrompts} from '../PromptHistory.js';
import type {KeyScope} from '../Keybindings.js';
import {toggleFavorite,uiPreferences} from '../interaction.js';

/** A single focus owner. The chat Editor is never replaced or reset by a modal. */
export class NativeWorkflow implements Component {
 scope:KeyScope='login';
 private input=new Input({prompt:'> '});private title='';private detail='';private options:{label:string;value:string}[]=[];private selected=0;private searchable=false;private secret=false;private busy=false;private disposed=false;
 private choose:(value:string)=>void=()=>{};private submitValue:(value:string)=>void=()=>{};private onSearch?:(value:string)=>void;
 private abort?:AbortController;private flow?:LoginFlow;private generation=0;
 private changeModelRole?:()=>void;private favoriteModel?:()=>void;
 constructor(private renderRequest:()=>void,private done:(message?:string)=>void,private keyHints:()=>string=()=> '↑↓ 选择 · Enter 确认 · Esc 取消'){}
 get focused(){return this.input.focused;}set focused(value:boolean){this.input.focused=value;}
 invalidate(){this.input.invalidate();}
 private show(title:string,options:{label:string;value:string}[],choose:(value:string)=>void,settings:{search?:boolean;detail?:string;secret?:boolean;submit?:(value:string)=>void;onSearch?:(value:string)=>void}={}){
  this.title=title;this.options=options;this.choose=choose;this.selected=0;this.searchable=!!settings.search;this.secret=!!settings.secret;this.detail=settings.detail??'';this.submitValue=settings.submit??(()=>{});this.onSearch=settings.onSearch;
  this.input.setValue('');this.input.onSubmit=value=>{if(!this.options.length&&!this.searchable&&!this.busy)this.submitValue(value);};this.renderRequest();
 }
 private filtered(){const q=this.searchable&&!this.onSearch?this.input.getValue().toLowerCase():'';return this.options.filter(o=>o.label.toLowerCase().includes(q));}
 handleInput(data:string){
  if(matchesKey(data,'esc')||matchesKey(data,'ctrl+c')){this.dispose();this.done();return;}
  if(this.busy)return;
  if(this.scope==='model'&&matchesKey(data,'tab')){this.changeModelRole?.();this.renderRequest();return;}
  if(this.scope==='model'&&matchesKey(data,'ctrl+f')){try{this.favoriteModel?.();}catch{this.detail='收藏保存失败；请检查配置目录。';}this.renderRequest();return;}
  if(this.scope==='model'&&matchesKey(data,'ctrl+s')){if(this.title==='模型使用范围')this.choose('default');else this.detail='先选择角色和模型，再保存默认。';this.renderRequest();return;}
  try{
   const items=this.filtered();
   if(matchesKey(data,'up')||matchesKey(data,'down')){if(items.length)this.selected=(this.selected+(matchesKey(data,'up')?-1:1)+items.length)%items.length;}
   else if(matchesKey(data,'enter')&&items.length)this.choose(items[Math.min(this.selected,items.length-1)]!.value);
   else if(this.searchable||!this.options.length){this.input.handleInput(data);if(this.searchable){this.selected=0;this.onSearch?.(this.input.getValue());}}
  }catch{this.detail='操作未完成；配置未确认保存，请检查输入或重试。';}
  this.renderRequest();
 }
 render(width:number){
  const lines=new Text(`\x1b[35m${this.title}\x1b[39m\n${stripTerminalSequences(this.detail)}`,1,0).render(width);
  if(!this.busy&&(this.searchable||!this.options.length)){
   let input=this.input.render(width);
   if(this.secret)input=input.map(line=>line.split(/(\x1b_pi:c\x07|\x1b\[[0-9;]*m)/g).map((part,i)=>i%2?part:part.replace(/[^ ]/gu,'*')).join(''));
   lines.push(...input);
  }
  const items=this.filtered();this.selected=Math.min(this.selected,Math.max(0,items.length-1));const start=Math.max(0,this.selected-3);
  for(let i=start;i<Math.min(items.length,start+7);i++)lines.push(...new Text(`${i===this.selected?'→':' '} ${stripTerminalSequences(items[i]!.label)}`,1,0).render(width));
  lines.push(...new Text(`${this.keyHints()}${this.searchable?` · ${items.length?this.selected+1:0}/${items.length}`:''}`,1,0).render(width));return lines;
 }
 history(restore:(text:string)=>void){
  this.scope='history';
  const load=(q:string)=>{const rows=searchPrompts(q,50);this.options=rows.map(r=>({label:`${r.created.slice(0,16)} · ${r.cwd} · ${r.text.replace(/\s+/g,' ').slice(0,180)}`,value:r.text}));};
  this.show('跨会话历史 · 选中后仅填回草稿',[],value=>{restore(value);this.done();},{search:true,onSearch:load});load('');this.renderRequest();
 }
 models(choices:{name:string;model:string;billing:string}[],select:(name:string,scope:'session'|'default',role:'leader'|'worker')=>string){
  this.scope='model';
  const chooseRole=(role:string)=>{
   this.changeModelRole=()=>chooseRole(role==='leader'?'worker':'leader');
   this.favoriteModel=()=>{if(!this.title.startsWith('选择已配置模型'))return;const row=this.filtered()[this.selected];if(!row)return;const favorites=toggleFavorite(row.value);this.options=this.options.map(o=>({...o,label:`${favorites.includes(o.value)?'★ ':''}${o.label.replace(/^★ /,'')}`}));};
   const favorites=uiPreferences().favorites;
   this.show(`选择已配置模型 · ${role==='leader'?'PM':'Worker'}`,choices.map(c=>({label:`${favorites.includes(c.name)?'★ ':''}${c.model} · ${c.name} · ${c.billing}`,value:c.name})),name=>{
    this.show('模型使用范围',[{label:'仅本次使用（重启恢复默认）',value:'session'},{label:'保存默认（重启后继续使用）',value:'default'}],scope=>this.done(select(name,scope as 'session'|'default',role as 'leader'|'worker')));
   },{search:true,detail:choices.length?'':'暂无可用模型；Esc 后 /login 配置。'});
  };
  this.changeModelRole=()=>{this.selected=(this.selected+1)%2;};this.show('选择角色',[{label:'PM',value:'leader'},{label:'Worker（后续新任务）',value:'worker'}],chooseRole);
 }
 login(flow=new LoginFlow()) {this.flow=flow;this.loginView();}
 private loginView(){
  if(this.disposed)return;const flow=this.flow!,v=flow.view();this.busy=v.stage==='busy';
  this.show(v.title,v.options.map((label,i)=>({label,value:String(i)})),value=>{
   const action=flow.choose(Number(value));
   if(action==='cancel'){this.dispose();this.done();return;}
   if(action==='save'){const message=flow.finish();this.dispose();this.done(message);return;}
   this.loginView();
   if(action==='login'||action==='check')this.authenticate(action==='login');
   else if(action==='models')this.refresh();
  },{search:v.stage==='provider'||v.stage==='models',secret:v.secret,detail:v.summary.join('\n')+(v.defaultValue?`\n默认：${v.defaultValue}`:''),submit:value=>{flow.submit(value);this.loginView();}});
  if(v.stage==='models')this.refresh();
 }
 private refresh(){
  this.abort?.abort();const control=new AbortController(),generation=++this.generation;this.abort=control;
  void this.flow!.refreshModels(control.signal).then(()=>{if(!this.disposed&&!control.signal.aborted&&generation===this.generation&&this.flow!.stage==='models'){
   // Updating the account catalog must not overwrite an in-progress search or focus.
   this.options=this.flow!.view().options.map((label,i)=>({label,value:String(i)}));this.detail=this.flow!.view().summary.join('\n');this.renderRequest();
  }}).catch(()=>{if(!this.disposed&&!control.signal.aborted){this.detail='账号目录不可用；仍可选择预置模型，账号权限尚未验证。';this.renderRequest();}});
 }
 private authenticate(login:boolean){
  this.abort?.abort();const control=new AbortController();this.abort=control;const flow=this.flow!;
  const notify=(text:string)=>{if(!this.disposed&&!control.signal.aborted){this.detail=stripTerminalSequences(text).slice(-4096);this.renderRequest();}};
  const task=flow.native?(flow.provider.nativeAuth==='openrouter'?openRouterOAuth(notify,control.signal):import('../../adapters/cloud.js').then(({checkCloud})=>checkCloud(flow.nativeConfig(),control.signal))):officialSubscriptionLogin(flow.provider.authProvider??flow.provider.id,login,notify,control.signal);
  void task.then(key=>{if(!this.disposed&&!control.signal.aborted){flow.authenticated(typeof key==='string'?key:undefined);this.loginView();}}).catch(()=>{if(!this.disposed&&!control.signal.aborted){flow.authFailed();this.loginView();this.detail='认证未成功，未保存配置；检查官方客户端、浏览器授权或云凭据。';this.renderRequest();}});
 }
 dispose(){this.disposed=true;this.abort?.abort();this.flow?.dispose();this.input.setValue('');this.options=[];this.detail='';}
}
