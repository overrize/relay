import {openRouterOAuth} from "../subscriptions/openrouterOAuth.js";
import React,{useEffect,useRef,useState} from "react";
import {Box,Text,useInput} from "ink";
import TextInput from "ink-text-input";
import {terminalPaste} from './TerminalPaste.js';
import {keyHint} from './Keybindings.js';
import {providerDirectorySource} from '../models/ProviderDirectory.js';
import {LoginFlow} from "./loginFlow.js";
import {officialSubscriptionLogin} from "../subscriptions/login.js";

export function LoginWizard({onDone,onCancel}:{onDone:(message:string)=>void;onCancel:()=>void}){
  const [flow]=useState(()=>new LoginFlow()),[,render]=useState(0),[value,setValue]=useState(""),[selected,setSelected]=useState(0),[error,setError]=useState(""),[instructions,setInstructions]=useState(""),[search,setSearch]=useState(""),[loading,setLoading]=useState(false);
  const alive=useRef(true),abort=useRef<AbortController>();const view=flow.view();
  const searching=view.stage==="models"||view.stage==="provider";
  useEffect(()=>{const paste=(text:string)=>{const clean=text.replace(/[\x00-\x1f\x7f]/g,'');if(searching){setSearch(v=>v+clean);setSelected(0);}else if(['key','endpoint','model','alias','region','profile','project'].includes(view.stage))setValue(v=>v+clean);};terminalPaste.on('paste',paste);return()=>{terminalPaste.off('paste',paste);};},[view.stage,searching]);
  const indices=view.options.map((_,i)=>i).filter(i=>!searching||(view.stage==="models"&&i>=flow.catalog.models.length)||view.options[i]!.toLowerCase().includes(search.toLowerCase()));
  const selectedIndex=Math.min(selected,Math.max(0,indices.length-1)),start=Math.max(0,Math.min(selectedIndex-3,indices.length-7));
  const cancel=()=>{alive.current=false;abort.current?.abort();flow.dispose();setValue("");onCancel();};
  useEffect(()=>()=>{alive.current=false;abort.current?.abort();flow.dispose();},[flow]);
  const changed=()=>{setValue("");setSearch("");setSelected(0);setError("");render(n=>n+1);};
  const reload=()=>{abort.current?.abort();const control=new AbortController();abort.current=control;setLoading(true);void flow.refreshModels(control.signal).then(()=>{if(alive.current&&!control.signal.aborted&&flow.stage==="models"){setSelected(0);render(n=>n+1);}}).finally(()=>{if(alive.current&&!control.signal.aborted)setLoading(false);});return control;};
  useEffect(()=>{if(view.stage!=="models")return;const control=reload();return()=>control.abort();},[flow,view.stage]);
  const choose=(index:number)=>{
    try{const action=flow.choose(index);changed();
      if(action==="cancel")cancel();
      if(action==="save"){const message=flow.finish();onDone(message);}
      if(action==="models")reload();
      if(action==="login"||action==="check"){
        abort.current=new AbortController();setInstructions("");
        const notify=(text:string)=>{if(alive.current)setInstructions(text);};
        const task=flow.native?(flow.provider.nativeAuth==="openrouter"?openRouterOAuth(notify,abort.current.signal):import("../adapters/cloud.js").then(({checkCloud})=>checkCloud(flow.nativeConfig(),abort.current!.signal))):officialSubscriptionLogin(flow.provider.authProvider??flow.provider.id,action==="login",text=>{if(alive.current)setInstructions(text);},abort.current.signal);
        void task.then(key=>{if(alive.current&&!abort.current?.signal.aborted){setInstructions("");flow.authenticated(typeof key==="string"?key:undefined);changed();}}).catch(()=>{if(alive.current){setInstructions("");flow.authFailed();changed();setError("认证未成功；AWS 检查 profile / SSO，GCP 检查 ADC，OAuth 检查浏览器授权。未保存模型配置。");}});
      }
    }catch{setError("未保存配置；检查选项、配置目录权限后重试。");}
  };
  useInput((_char,key)=>{if(key.escape||(key.ctrl&&_char==="c")){cancel();return;}if(!view.options.length||!indices.length)return;if(key.upArrow){setSelected(n=>(n+indices.length-1)%indices.length);return;}if(key.downArrow){setSelected(n=>(n+1)%indices.length);return;}if(key.return)choose(indices[selectedIndex]!);});
  return <Box flexDirection="column" borderStyle="single" borderColor="blue" borderLeft={false} borderRight={false} paddingX={1} paddingY={1} flexShrink={0}>
    <Text bold color="magenta">{view.title}</Text>
    {view.stage==='provider'?<Text dimColor>目录覆盖 {providerDirectorySource.count} 个 OmO 内置供应商 · {providerDirectorySource.version} · 预置名称不代表账号权限</Text>:null}
    {!['mode','provider'].includes(view.stage)?<Text dimColor>{view.summary.join(" | ")}</Text>:null}
    {searching?<Box><Text>&gt; </Text><TextInput value={search} onChange={text=>{setSearch(text);setSelected(0);}} onSubmit={()=>{}} placeholder={view.stage==="models"?"搜索模型名称…":"搜索供应商…"}/></Box>:null}
    {indices.slice(start,start+7).map(i=><Text key={`${i}-${view.options[i]}`} color={indices[selectedIndex]===i?"magenta":undefined}>{indices[selectedIndex]===i?"→ ":"  "}{view.options[i]}</Text>)}
    {searching?<Text dimColor>({indices.length?selectedIndex+1:0}/{indices.length}){view.stage==="models"&&loading?" · 正在读取账号目录，预置列表仍可选":""}</Text>:null}
    {view.stage==="busy"?<Text>{instructions||(flow.native?"正在处理原生认证…（后台 PM 继续运行）":"正在检查官方客户端…（后台 PM 继续运行）")}</Text>:!view.options.length?<TextInput key={view.stage} value={value} onChange={setValue} mask={view.secret?"*":undefined} placeholder={view.secret?"输入 API Key":view.defaultValue||view.title} onSubmit={input=>{try{flow.submit(input);changed();}catch(e){setError(e instanceof Error?e.message:"参数无效");}}}/>:null}
    {error?<Text color="red">{error}</Text>:null}
    <Text dimColor>{keyHint('tui.select.up')} / {keyHint('tui.select.down')} 选择　{keyHint('tui.select.confirm')} 确认　{keyHint('tui.select.cancel')} / {keyHint('app.clear')} 取消</Text>
  </Box>;
}
