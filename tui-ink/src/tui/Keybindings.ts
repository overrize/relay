import fs from 'node:fs';
import path from 'node:path';
import {configPath} from '../config.js';

export type KeyScope='compose'|'agents'|'model'|'login'|'history';
type Definition={keys:string[]; canonical:string; scopes:KeyScope[]; label:string};
const compose:KeyScope[]=['compose','agents'],select:KeyScope[]=['model','login','history'],all=[...compose,...select];
const def=(keys:string[],canonical:string,scopes:KeyScope[],label:string):Definition=>({keys,canonical,scopes,label});
export const KEY_ACTIONS={
 'app.clear':def(['ctrl+c'],'\x03',all,'清空输入 / 取消窗口'),
 'app.exit':def(['ctrl+d'],'\x04',compose,'空输入时退出'),
 'app.interrupt':def(['escape'],'\x1b',compose,'关闭菜单 / 中断当前任务'),
 'app.model.select':def(['ctrl+l'],'\x0c',compose,'选择模型'),
 'app.model.cycleForward':def(['ctrl+p'],'\x10',compose,'下一个模型'),
 'app.model.cycleBackward':def(['alt+p'],'\x1bp',compose,'上一个模型'),
 'app.history.search':def(['ctrl+r'],'\x12',compose,'跨会话历史搜索'),
 'app.editor.external':def(['ctrl+g'],'\x07',compose,'外部编辑器'),
 'app.agents.toggle':def(['ctrl+b'],'\x02',compose,'Agent 列表'),
 'app.tools.expand':def(['ctrl+o'],'\x0f',compose,'展开工具输出'),
 'app.thinking.toggle':def(['ctrl+t'],'\x14',compose,'展开推理内容'),
 'app.thinking.cycle':def(['shift+tab'],'\x1b[Z',compose,'推理强度'),
 'app.viewport.up':def(['pageup'],'\x1b[5~',compose,'历史向上翻页'),
 'app.viewport.down':def(['pagedown'],'\x1b[6~',compose,'历史向下翻页'),
 'app.viewport.end':def(['alt+end'],'\x1b[1;3F',compose,'回到最新输出'),
 'app.panel.previous':def(['alt+up'],'\x1b[1;3A',compose,'面板上一条'),
 'app.panel.next':def(['alt+down'],'\x1b[1;3B',compose,'面板下一条'),
 'app.panel.more':def(['alt+n'],'\x1bn',compose,'加载更早记录'),
 'app.panel.refresh':def(['f5'],'\x1b[15~',compose,'刷新当前面板'),
 'tui.input.submit':def(['enter'],'\r',compose,'发送消息'),
 'tui.input.newline':def(['alt+enter','ctrl+j','shift+enter'],'\n',compose,'换行'),
 'tui.editor.left':def(['left'],'\x1b[D',compose,'光标左移'),
 'tui.editor.right':def(['right'],'\x1b[C',compose,'光标右移'),
 'tui.editor.up':def(['up'],'\x1b[A',compose,'光标上移 / 菜单上一项'),
 'tui.editor.down':def(['down'],'\x1b[B',compose,'光标下移 / 菜单下一项'),
 'tui.editor.home':def(['home','ctrl+a'],'\x01',compose,'行首'),
 'tui.editor.end':def(['end','ctrl+e'],'\x05',compose,'行尾'),
 'tui.editor.backspace':def(['backspace'],'\x08',compose,'向前删除'),
 'tui.editor.delete':def(['delete'],'\x1b[3~',compose,'向后删除'),
 'tui.editor.undo':def(['ctrl+z'],'\x1a',compose,'撤销'),
 'tui.editor.redo':def(['ctrl+y'],'\x19',compose,'重做'),
 'tui.editor.deleteToStart':def(['ctrl+u'],'\x15',compose,'删除到行首'),
 'tui.editor.deleteToEnd':def(['ctrl+k'],'\x0b',compose,'删除到行尾'),
 'tui.editor.deleteWord':def(['ctrl+w'],'\x17',compose,'删除前一个词'),
 'tui.editor.complete':def(['tab'],'\t',compose,'补全 / 切换 Agent'),
 'tui.select.up':def(['up'],'\x1b[A',select,'上一项'),
 'tui.select.down':def(['down'],'\x1b[B',select,'下一项'),
 'tui.select.confirm':def(['enter'],'\r',select,'确认选项'),
 'tui.select.cancel':def(['escape'],'\x1b',select,'取消选择'),
 'app.model.save':def(['ctrl+s'],'\x13',['model'],'保存默认模型'),
 'app.model.favorite':def(['ctrl+f'],'\x06',['model'],'收藏模型'),
 'app.model.role':def(['tab'],'\t',['model'],'切换模型用途'),
} as const;
export type KeyAction=keyof typeof KEY_ACTIONS;
const aliases:Record<string,string>={esc:'escape',return:'enter',control:'ctrl',option:'alt'};
export function normalizeKey(raw:string){const key=raw.toLowerCase().split('+').map(s=>aliases[s.trim()]??s.trim()).join('+');return ({'ctrl+i':'tab','ctrl+m':'enter','ctrl+h':'backspace'} as Record<string,string>)[key]??key;}
export function keySequences(key:string):string[]{
 const viewport:Record<string,string[]>={pageup:['\x1b[5~'],pagedown:['\x1b[6~'],'alt+end':['\x1b[1;3F'],'alt+up':['\x1b[1;3A'],'alt+down':['\x1b[1;3B']};if(viewport[key])return viewport[key]!;
 const plain:Record<string,string[]>={escape:['\x1b'],enter:['\r'],tab:['\t'],backspace:['\x08','\x7f'],delete:['\x1b[3~'],up:['\x1b[A','\x1bOA'],down:['\x1b[B','\x1bOB'],left:['\x1b[D','\x1bOD'],right:['\x1b[C','\x1bOC'],home:['\x1b[H','\x1bOH','\x1b[1~'],end:['\x1b[F','\x1bOF','\x1b[4~'],'shift+tab':['\x1b[Z'],'alt+enter':['\x1b\r'],'shift+enter':['\x1b[13;2u','\x1b[27;2;13~']};
 if(plain[key])return plain[key]!;
 if(/^ctrl\+[a-z]$/.test(key))return [String.fromCharCode(key.charCodeAt(5)-96)];
 if(/^alt\+[a-z0-9]$/.test(key))return ['\x1b'+key.at(-1)];
 if(/^f(?:[1-9]|1[0-2])$/.test(key)){const n=Number(key.slice(1));return n<5?['\x1bO'+String.fromCharCode(79+n),'\x1b['+(10+n)+'~']:['\x1b['+[15,17,18,19,20,21,23,24][n-5]+'~'];}
 throw Error(`不支持的按键：${key}`);
}
export class Keybindings {
 private bindings:Record<string,string[]>={};
 private tokens=new Map<string,string>();
 constructor(){this.configure({});}
 configure(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('快捷键配置必须是 JSON 对象');
  const bindings:Record<string,string[]>={};
  for(const [id,value] of Object.entries(raw)){
   if(!Object.hasOwn(KEY_ACTIONS,id))throw Error(`未知快捷键动作：${id}`);
   const list=typeof value==='string'?[value]:value;if(!Array.isArray(list)||list.some(v=>typeof v!=='string'))throw Error(`快捷键 ${id} 需要字符串或字符串数组`);
   bindings[id]=[...new Set((list as string[]).map(normalizeKey))];for(const key of bindings[id]!)keySequences(key);
  }
  const effective=Object.fromEntries(Object.entries(KEY_ACTIONS).map(([id,d])=>[id,bindings[id]??d.keys]));
  const owners=new Map<string,string>();
  for(const [id,d] of Object.entries(KEY_ACTIONS))for(const key of effective[id]!)for(const scope of d.scopes){const owner=owners.get(scope+':'+key);if(owner&&owner!==id)throw Error(`快捷键冲突：${key}（${scope}）被 ${owner} 和 ${id} 同时使用；请取消其中一项绑定`);owners.set(scope+':'+key,id);}
  const tokens=new Map<string,string>();
  // Recognize disabled defaults too, so old control keys cannot leak into text.
  for(const key of new Set([...Object.values(KEY_ACTIONS).flatMap(d=>d.keys),...Object.values(effective).flat()]))for(const sequence of keySequences(key))tokens.set(sequence,key);
  this.bindings=effective;this.tokens=tokens;
 }
 reload(file=keybindingsPath()){this.configure(fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')):{});}
 keys(id:KeyAction){return this.bindings[id]??[];}
 hint(id:KeyAction){return this.keys(id).join(' / ')||'未绑定';}
 report(){return Object.entries(KEY_ACTIONS).map(([id,d])=>`${id}: ${this.bindings[id]!.join(', ')||'[]'} — ${d.label}`).join('\n');}
 resolve(bytes:Buffer,scope:KeyScope,final=false):{length:number;output:Buffer;pending?:boolean}|undefined{
  if(bytes[0]!==0x1b&&bytes[0]!==0x7f&&bytes[0]!>=0x20)return;
  const text=bytes.subarray(0,64).toString('latin1'),sequences=[...this.tokens.keys()];
  if(!final&&sequences.some(s=>s.length>text.length&&s.startsWith(text)))return {length:0,output:Buffer.alloc(0),pending:true};
  const sequence=sequences.filter(s=>text.startsWith(s)).sort((a,b)=>b.length-a.length)[0];if(!sequence)return;
  const key=this.tokens.get(sequence)!;
  const action=Object.entries(KEY_ACTIONS).find(([id,d])=>d.scopes.includes(scope)&&this.bindings[id]!.includes(key));
  // Unbound navigation remains available to text-entry fields inside selectors.
  const editorKey=select.includes(scope)&&['backspace','delete','left','right','home','end'].includes(key);
  return {length:sequence.length,output:Buffer.from(action?.[1].canonical??(editorKey?sequence:''),'latin1')};
 }
}
export function keybindingsPath(){return path.join(path.dirname(configPath()),'keybindings.json');}
export const keybindings=new Keybindings();
export const keyHint=(id:KeyAction)=>keybindings.keys(id).map(key=>key.split('+').map(part=>({ctrl:'Ctrl',alt:'Alt',shift:'Shift',enter:'Enter',escape:'Esc',up:'↑',down:'↓',left:'←',right:'→',tab:'Tab',home:'Home',end:'End',backspace:'Backspace',delete:'Delete'} as Record<string,string>)[part]??part.toUpperCase()).join('+')).join(' / ')||'未绑定';
