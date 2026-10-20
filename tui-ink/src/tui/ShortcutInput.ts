import {Transform} from 'node:stream';
/** Keep shortcut bytes out of text editors; preserve byte boundaries for IME/paste. */
export class ShortcutInput extends Transform {
 private escape=false;private timer?:ReturnType<typeof setTimeout>;
 constructor(private shortcut:(code:number)=>void){super();}
 override _transform(chunk:Buffer|string,_encoding:BufferEncoding,done:(error?:Error|null)=>void){
  let bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
  if(this.escape){clearTimeout(this.timer);this.escape=false;bytes=Buffer.concat([Buffer.from([0x1b]),bytes]);}
  if(bytes.at(-1)===0x1b){bytes=bytes.subarray(0,-1);this.escape=true;this.timer=setTimeout(()=>{this.escape=false;this.push(Buffer.from([0x1b]));},35);this.timer.unref();}
  const out:number[]=[];
  for(let i=0;i<bytes.length;i++){const b=bytes[i]!;if(b===0x1b&&bytes[i+1]===0x70){this.shortcut(0x80);i++;}else if([0x03,0x04,0x07,0x0c,0x0f,0x10,0x14].includes(b))this.shortcut(b);else out.push(b);}
  if(out.length)this.push(Buffer.from(out));done();
 }
 override _flush(done:(error?:Error|null)=>void){clearTimeout(this.timer);if(this.escape)this.push(Buffer.from([0x1b]));this.escape=false;done();}
 override _destroy(error:Error|null,done:(error?:Error|null)=>void){clearTimeout(this.timer);done(error);}
}
