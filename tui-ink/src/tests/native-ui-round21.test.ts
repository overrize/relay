import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeWorkbench} from '../tui/native/Workbench.js';
import {stripTerminalSequences,visibleWidth,type Terminal} from '@code-yeongyu/senpi-tui';

class TestTerminal implements Terminal {
 columns=80;rows=24;kittyProtocolActive=false;output='';stops=0;input:(data:string)=>void=()=>{};resize:()=>void=()=>{};
 start(onInput:(data:string)=>void,onResize:()=>void){this.input=onInput;this.resize=onResize;}
 stop(){this.stops++;this.input=()=>{};}
 async drainInput(){}
 write(data:string){this.output+=data;}
 moveBy(lines:number){this.write(`\x1b[${lines<0?-lines:lines}${lines<0?'A':'B'}`);}
 hideCursor(){this.write('\x1b[?25l');}showCursor(){this.write('\x1b[?25h');}
 clearLine(){this.write('\x1b[2K');}clearFromCursor(){this.write('\x1b[J');}clearScreen(){this.write('\x1b[2J');}
 setTitle(_title:string){}setProgress(_active:boolean){}
}
const pause=()=>new Promise(r=>setTimeout(r,40));
test('OmO toolkit editor handles Chinese, emoji, newline and bracketed paste without Relay raw-input shims',async()=>{
 const term=new TestTerminal(),w=new NativeWorkbench(term,['model-a','model-b']);w.start();
 try{
  term.input('我需要🙂');term.input('\x1b[D');term.input('中文');assert.equal(w.editor.getText(),'我需要中文🙂');
  term.input('\x1b\r');term.input('\x1b[200~second\n第三行\x1b[201~');assert.equal(w.editor.getText(),'我需要中文\nsecond\n第三行🙂');
  w.tui.renderNow();assert.match(stripTerminalSequences(term.output),/交互迁移验证版/);
 }finally{w.close();}await pause();assert.equal(term.stops,1);
});
test('model menu owns focus and arrows while closing restores the exact unsent draft',async()=>{
 const term=new TestTerminal(),w=new NativeWorkbench(term,['model-a','model-b']);w.start();
 try{term.input('未发送\n草稿🙂');term.input('\x1b[D');const draft=w.editor.getText(),cursor=w.editor.getCursor();term.input('\x0c');term.input('\x1b[B');term.input('\r');w.tui.renderNow();assert.equal(w.editor.getText(),draft);assert.deepEqual(w.editor.getCursor(),cursor);assert.match(stripTerminalSequences(term.output),/model-b/);term.input('\x0c');term.input('\x1b');assert.equal(w.editor.getText(),draft);assert.deepEqual(w.editor.getCursor(),cursor);}finally{w.close();}await pause();
});
test('background render and terminal resize preserve draft and selection focus',async()=>{
 const term=new TestTerminal(),w=new NativeWorkbench(term,['model-a','model-b']);w.start();
 try{term.input('draft🙂');w.simulateBackground();term.input('\x0c');term.input('\x1b[B');await new Promise(r=>setTimeout(r,310));term.columns=40;term.rows=16;term.resize();term.input('\r');assert.equal(w.editor.getText(),'draft🙂');w.tui.renderNow();assert.match(stripTerminalSequences(term.output),/model-b/);for(const line of w.tui.render(40))assert.ok(visibleWidth(line)<=40);}finally{w.close();}await pause();
});
test('slash completion navigates with arrows and exit releases the terminal exactly once',async()=>{
 const term=new TestTerminal();let exited=0;const w=new NativeWorkbench(term,['model-a'],()=>exited++);w.start();
 try{term.input('/');await pause();term.input('\x1b[B');term.input('\t');assert.ok(w.editor.getText().startsWith('/'));term.input('\x03');w.close();assert.equal(exited,1);assert.equal(term.stops,1);assert.throws(()=>w.start(),/closed/);}finally{w.close();}await pause();
});
