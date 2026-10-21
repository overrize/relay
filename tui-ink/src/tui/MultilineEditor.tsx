import React,{useEffect,useRef,useState} from 'react';
import {Box,Text,useInput} from 'ink';
import {terminalPaste} from './TerminalPaste.js';

const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
export function previousBoundary(text:string,cursor:number){return [...segmenter.segment(text.slice(0,cursor))].at(-1)?.index??0;}
export function nextBoundary(text:string,cursor:number){const part=[...segmenter.segment(text.slice(cursor))][0];return Math.min(text.length,cursor+(part?.segment.length??0));}
export function editorLines(value:string,width:number,measure:(s:string)=>number){
  const lines:{text:string;start:number;end:number}[]=[];let text='',start=0,offset=0;
  for(const {segment} of segmenter.segment(value)){
    if(segment==='\n'){lines.push({text,start,end:offset});offset++;start=offset;text='';continue;}
    if(text&&measure(text+segment)>width){lines.push({text,start,end:offset});start=offset;text='';}
    text+=segment;offset+=segment.length;
  }
  lines.push({text,start,end:offset});return lines;
}

/** Controlled multiline composer. Enter sends; Alt+Enter / Ctrl+J insert a line. */
export function MultilineEditor({value,onChange,onSubmit,placeholder,menuActive=false,focused=true,onCursor,width=70,measure=(s:string)=>Array.from(s).length}:{value:string;onChange:(v:string)=>void;onSubmit:(v:string)=>void;placeholder?:string;menuActive?:boolean;focused?:boolean;onCursor?:(cursor:number)=>void;width?:number;measure?:(s:string)=>number}) {
  const [cursor,setCursor]=useState(value.length),seen=useRef(value),undo=useRef<{text:string;cursor:number}[]>([]),redo=useRef<{text:string;cursor:number}[]>([]);
  const position=seen.current===value?Math.min(cursor,value.length):value.length;
  const current=useRef({text:value,cursor:position});current.current={text:value,cursor:position};
  const all=editorLines(value,width,measure),active=all.reduce((last,line,i)=>line.start<=position?i:last,0),max=Math.max(2,Math.min(8,Math.floor((process.stdout.rows??24)/3))),start=Math.max(0,active-max+1);
  useEffect(()=>{onCursor?.(position);},[value,position,onCursor]);
  useEffect(()=>{if(seen.current!==value){seen.current=value;setCursor(value.length);undo.current=[];redo.current=[];}},[value]);
  const change=(text:string,next:number,record=true)=>{if(record){undo.current.push({...current.current});if(undo.current.length>100)undo.current.shift();redo.current=[];}seen.current=text;onChange(text);setCursor(next);current.current={text,cursor:next};};
  const insert=(text:string)=>{const normalized=text.replace(/\r\n?/g,'\n').replace(/\t/g,'    ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');const {text:existing,cursor:at}=current.current;change(existing.slice(0,at)+normalized+existing.slice(at),at+normalized.length);};
  useEffect(()=>{if(!focused)return;terminalPaste.on('paste',insert);return()=>{terminalPaste.off('paste',insert);};});
  useInput((text,key)=>{
    if(key.escape||key.tab||key.pageDown||key.pageUp)return;
    if(key.ctrl){
      if(text==='j'){insert('\n');return;}
      if(text==='a'){setCursor(value.slice(0,position).lastIndexOf('\n')+1);return;}
      if(text==='e'){const n=value.indexOf('\n',position);setCursor(n<0?value.length:n);return;}
      if(text==='z'||text==='y'){
        const source=text==='z'?undo:redo,target=text==='z'?redo:undo,item=source.current.pop();
        if(item){target.current.push({text:value,cursor:position});change(item.text,item.cursor,false);}return;
      }
      if(text==='u'){const start=value.slice(0,position).lastIndexOf('\n')+1;change(value.slice(0,start)+value.slice(position),start);return;}
      if(text==='w'){const prefix=value.slice(0,position).replace(/\s*\S+\s*$/u,'');change(prefix+value.slice(position),prefix.length);return;}
      if(text==='k'){const end=value.indexOf('\n',position);change(value.slice(0,position)+value.slice(end<0?value.length:end),position);return;}
      return;
    }
    if(key.return){if(key.meta||key.shift)insert('\n');else onSubmit(value);return;}
    if(text==='\n'){insert('\n');return;}
    if(key.leftArrow){setCursor(previousBoundary(value,position));return;}
    if(key.rightArrow){setCursor(nextBoundary(value,position));return;}
    if(key.upArrow||key.downArrow){
      if(menuActive)return;
      const target=all[active+(key.upArrow?-1:1)];
      if(target){const col=measure(value.slice(all[active]!.start,position));let next=target.start;for(const {segment} of segmenter.segment(target.text)){if(measure(value.slice(target.start,next)+segment)>col)break;next+=segment.length;}setCursor(next);}return;
    }
    // Ink does not expose Home/End as key flags.
    if(text==='[H'||text==='OH'||text==='[1~'){setCursor(value.lastIndexOf('\n',position-1)+1);return;}
    if(text==='[F'||text==='OF'||text==='[4~'){const n=value.indexOf('\n',position);setCursor(n<0?value.length:n);return;}
    if(key.delete){change(value.slice(0,position)+value.slice(nextBoundary(value,position)),position);return;}
    if(key.backspace){const before=previousBoundary(value,position);change(value.slice(0,before)+value.slice(position),before);return;}
    if(key.meta)return;
    if(text)insert(text);
  },{isActive:focused});
  return <Box flexDirection="column" flexGrow={1}>
    {!value?<Text dimColor>{placeholder??'输入消息…'}{focused?'▏':''}</Text>:all.slice(start,start+max).map((line,i)=>{
      const before=value.slice(line.start,position),after=value.slice(position,line.end),at=[...segmenter.segment(after)][0]?.segment??' ';
      return <Text key={start+i} wrap="truncate-end">{start+i===active?<>{before}<Text inverse>{at}</Text>{after.slice(at.trim()?at.length:after.startsWith(' ')?1:0)}</>:line.text||' '}</Text>;
    })}
    {all.length>max?<Text dimColor>行 {active+1}/{all.length} · ↑↓ 移动</Text>:null}
  </Box>;
}
