import {Transform} from 'node:stream';
import {terminalPaste} from './TerminalPaste.js';
/** Decode paste framing before shortcuts, including fragmented Windows input. */
export class ShortcutInput extends Transform {
 private pending=Buffer.alloc(0);private paste:Buffer[]|null=null;private pasteBytes=0;private timer?:ReturnType<typeof setTimeout>;
 constructor(private shortcut:(code:number)=>void,private mouse?:(button:number,column:number)=>void,private resolveKey?:(bytes:Buffer,final?:boolean)=>{length:number;output:Buffer;pending?:boolean}|undefined){super();}
 private forward(bytes:Buffer){
  if(bytes.equals(Buffer.from('\x1bp'))){this.shortcut(0x80);return;}
  if(bytes.length===1&&[0x02,0x03,0x04,0x07,0x0c,0x0f,0x10,0x12,0x14].includes(bytes[0]!)){this.shortcut(bytes[0]!);return;}
  if(bytes.length)this.push(bytes);
 }
 override _transform(chunk:Buffer|string,_encoding:BufferEncoding,done:(error?:Error|null)=>void){
  void (async()=>{
  clearTimeout(this.timer);
  let bytes=Buffer.concat([this.pending,Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)]);this.pending=Buffer.alloc(0);
  const begin=Buffer.from('\x1b[200~'),end=Buffer.from('\x1b[201~'),out:number[]=[];
  const special=[['\x1b\r','\n'],['\x1b[13;2u','\n'],['\x1b[27;2;13~','\n'],['\x1b[H','\x01'],['\x1bOH','\x01'],['\x1b[1~','\x01'],['\x1b[F','\x05'],['\x1bOF','\x05'],['\x1b[4~','\x05']] as const;
  const flush=()=>{if(out.length){this.push(Buffer.from(out));out.length=0;}};
  while(bytes.length){
   if(this.paste){
    const at=bytes.indexOf(end),take=at<0?Math.max(0,bytes.length-end.length+1):at;
    if(this.pasteBytes+take<=1_000_000){this.paste.push(bytes.subarray(0,take));this.pasteBytes+=take;}
    if(at<0){this.pending=bytes.subarray(take);break;}
    flush();const text=Buffer.concat(this.paste).toString('utf8');this.paste=null;this.pasteBytes=0;bytes=bytes.subarray(at+end.length);
    // Let Ink consume preceding keys before replacing editor state with pasted text.
    await new Promise<void>(resolve=>setImmediate(resolve));terminalPaste.emit('paste',text);await new Promise<void>(resolve=>setImmediate(resolve));continue;
   }
   if(bytes.length<begin.length&&begin.subarray(0,bytes.length).equals(bytes)){this.pending=bytes;break;}
   if(bytes.subarray(0,begin.length).equals(begin)){flush();this.paste=[];bytes=bytes.subarray(begin.length);continue;}
   const sequence=bytes[0]===0x1b?bytes.subarray(0,128).toString('latin1'):'',sgr=/^\x1b\[<(\d+);(\d+);\d+([Mm])/.exec(sequence);
   if(sgr){flush();if(sgr[3]==='M')this.mouse?.(Number(sgr[1]),Number(sgr[2]));bytes=bytes.subarray(sgr[0].length);continue;}
   if(/^\x1b\[<[\d;]*$/.test(sequence)&&bytes.length<64){this.pending=bytes;break;}
   if(sequence.startsWith('\x1b[M')){if(bytes.length<6){this.pending=bytes;break;}flush();this.mouse?.(bytes[3]!-32,bytes[4]!-32);bytes=bytes.subarray(6);continue;}
   const resolved=this.resolveKey?.(bytes);
   if(resolved){if(resolved.pending){this.pending=bytes;break;}flush();this.forward(resolved.output);bytes=bytes.subarray(resolved.length);continue;}
   const mapped=special.find(([sequence])=>bytes.subarray(0,Buffer.byteLength(sequence)).equals(Buffer.from(sequence)));
   if(mapped){out.push(...Buffer.from(mapped[1]));bytes=bytes.subarray(Buffer.byteLength(mapped[0]));continue;}
   if(bytes.length>1&&special.some(([sequence])=>bytes.length<Buffer.byteLength(sequence)&&Buffer.from(sequence).subarray(0,bytes.length).equals(bytes))){this.pending=bytes;break;}
   const b=bytes[0]!;
   if(b===0x1b&&bytes[1]===0x70){flush();this.shortcut(0x80);bytes=bytes.subarray(2);continue;}
   if([0x03,0x04,0x07,0x0c,0x0f,0x10,0x12,0x14].includes(b)){flush();this.shortcut(b);}else out.push(b===0x7f?0x08:b);
   bytes=bytes.subarray(1);
  }
  flush();
  if(!this.paste&&this.pending.length===1&&this.pending[0]===0x1b){this.timer=setTimeout(()=>{const bytes=this.pending;this.pending=Buffer.alloc(0);const resolved=this.resolveKey?.(bytes,true);this.forward(resolved?.output??bytes);},35);this.timer.unref();}
  })().then(()=>done(),done);
 }
 override _flush(done:(error?:Error|null)=>void){clearTimeout(this.timer);if(!this.paste&&this.pending.length)this.push(this.pending);this.pending=Buffer.alloc(0);this.paste=null;done();}
 override _destroy(error:Error|null,done:(error?:Error|null)=>void){clearTimeout(this.timer);done(error);}
}
