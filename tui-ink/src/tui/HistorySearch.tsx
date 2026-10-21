import React,{useEffect,useState} from 'react';
import {Box,Text,useInput} from 'ink';
import TextInput from 'ink-text-input';
import {searchPrompts} from './PromptHistory.js';
import {terminalPaste} from './TerminalPaste.js';
import {keyHint} from './Keybindings.js';

export function HistorySearch({onSelect,onCancel}:{onSelect:(text:string)=>void;onCancel:()=>void}) {
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(0);
  useEffect(()=>{const paste=(text:string)=>{setQuery(v=>v+text.replace(/[\x00-\x1f\x7f]/g,''));setSelected(0);};terminalPaste.on('paste',paste);return()=>{terminalPaste.off('paste',paste);};},[]);
  let records:ReturnType<typeof searchPrompts>=[],error='';
  try{records=searchPrompts(query);}catch{error='历史记录不可读；当前草稿保留，请检查配置目录权限。';}
  const index=Math.min(selected,Math.max(0,records.length-1)),start=Math.max(0,index-3);
  useInput((char,key)=>{
    if(key.escape||key.ctrl&&char==='c'){onCancel();return;}
    if(key.upArrow){setSelected(n=>records.length?(n+records.length-1)%records.length:0);return;}
    if(key.downArrow){setSelected(n=>records.length?(n+1)%records.length:0);return;}
    if(key.return&&records[index])onSelect(records[index]!.text);
  });
  return <Box flexDirection="column" borderStyle="single" borderColor="blue" borderLeft={false} borderRight={false} paddingX={1}>
    <Text bold color="magenta">跨会话历史搜索 · {keyHint('app.history.search')}</Text>
    <Box><Text>&gt; </Text><TextInput value={query} onChange={v=>{setQuery(v);setSelected(0);}} onSubmit={()=>{}} placeholder="搜索曾输入的内容…"/></Box>
    {records.slice(start,start+6).map((r,i)=><Text key={r.id} color={i+start===index?'magenta':undefined} wrap="truncate-end">{i+start===index?'→ ':'  '}{r.text.replace(/\s+/g,' ')} · {r.created.slice(0,16)} · {r.cwd}</Text>)}
    {error?<Text color="yellow">{error}</Text>:!records.length?<Text dimColor>没有匹配的历史记录</Text>:null}
    <Text dimColor>{keyHint('tui.select.up')} / {keyHint('tui.select.down')} 选择 · {keyHint('tui.select.confirm')} 放回编辑器（不发送） · {keyHint('tui.select.cancel')} 保留草稿 · 最近 {records.length} 条</Text>
  </Box>;
}
