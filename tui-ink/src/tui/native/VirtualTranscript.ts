import {Text,truncateToWidth,type Component,type TuiMouseEvent} from '@code-yeongyu/senpi-tui';

interface Block {text:string;heights:Map<number,number>}
/** Only visible message blocks produce retained rendered lines. Height metadata
 * is reused across frames, and rendered block lines live in a bounded LRU. */
export class VirtualTranscript implements Component {
 private blocks:Block[]=[];private widths=new Map<string,Block>();private lines=new Map<Block,{width:number;lines:string[]}>();
 private offsets:number[]=[0];private measuredWidth=0;private dirty=true;private top=0;private height=1;private following=true;private total=0;
 readonly stats={measuredBlocks:0,renderedBlocks:0,visibleLines:0,cachedBlocks:0};
 constructor(private availableHeight:(width:number)=>number,private request:()=>void){}
 get scrollTop(){return this.top;}get viewportHeight(){return this.height;}get isFollowingEnd(){return this.following;}
 setText(text:string){this.setBlocks([text]);}
 setBlocks(texts:string[]){
  if(texts.length===this.blocks.length&&texts.every((t,i)=>this.blocks[i]!.text===t))return;
  const old=this.widths,current=new Map(this.blocks.map(b=>[b.text,b])),next=new Map<string,Block>();this.blocks=texts.filter(Boolean).map(text=>{const block=old.get(text)??current.get(text)??{text,heights:new Map<number,number>()};next.set(text,block);return block;});
  for(const [text,block] of next){old.delete(text);old.set(text,block);}while(old.size>2048)old.delete(old.keys().next().value!);
  for(const block of this.lines.keys())if(!next.has(block.text))this.lines.delete(block);this.dirty=true;
 }
 invalidate(){this.measuredWidth=0;this.dirty=true;this.lines.clear();for(const b of this.blocks)b.heights.clear();}
 private wrapped(block:Block,width:number){
  const cached=this.lines.get(block);if(cached?.width===width){this.lines.delete(block);this.lines.set(block,cached);return cached.lines;}
  const lines=new Text(block.text,1,0).render(width);this.stats.renderedBlocks++;this.lines.set(block,{width,lines});
  while(this.lines.size>24)this.lines.delete(this.lines.keys().next().value!);return lines;
 }
 private measure(width:number){
  if(this.dirty||this.measuredWidth!==width){this.offsets=[0];for(const b of this.blocks){let n=b.heights.get(width);if(n===undefined){n=this.wrapped(b,width).length+1;b.heights.set(width,n);this.stats.measuredBlocks++;while(b.heights.size>2)b.heights.delete(b.heights.keys().next().value!);}this.offsets.push(this.offsets.at(-1)!+n);}this.total=this.offsets.at(-1)!;this.measuredWidth=width;this.dirty=false;}
  this.height=Math.max(1,this.availableHeight(width));const max=Math.max(0,this.total-this.height);this.top=this.following?max:Math.min(max,this.top);
 }
 scrollTo(top:number,options:{disableFollow?:boolean}={}){this.top=Math.max(0,Math.min(Math.max(0,this.total-this.height),Math.floor(top)));this.following=!options.disableFollow&&this.top>=this.total-this.height;this.request();}
 scrollBy(delta:number){const before=this.top;this.scrollTo(this.top+delta);return this.top-before;}
 scrollToStart(){this.scrollTo(0,{disableFollow:true});}scrollToEnd(){this.following=true;this.top=Math.max(0,this.total-this.height);this.request();}
 handleMouse(event:TuiMouseEvent){if(event.type==='wheel'){this.scrollBy((event.wheelDelta??0)*(event.alt?5:1));return {handled:true,render:true};}return undefined;}
 render(width:number){
  this.measure(width);let low=0,high=this.blocks.length;while(low<high){const mid=(low+high)>>1;if(this.offsets[mid+1]!<=this.top)low=mid+1;else high=mid;}
  const result:string[]=[];let position=this.top;
  for(let i=low;i<this.blocks.length&&result.length<this.height;i++){
   const lines=this.wrapped(this.blocks[i]!,width),offset=Math.max(0,position-this.offsets[i]!);
   for(let row=offset;row<=lines.length&&result.length<this.height;row++){result.push(lines[row]??'');position++;}
  }
  while(result.length<this.height)result.push('');
  if(!this.following&&result.length)result[result.length-1]=truncateToWidth(` ↑ 历史位置 ${this.top+1}/${this.total} · Alt+End 最新`,width,'');
  this.stats.visibleLines=result.length;this.stats.cachedBlocks=this.lines.size;return result;
 }
}
