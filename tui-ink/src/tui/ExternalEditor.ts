import fs from 'node:fs';
import path from 'node:path';
import {spawn,type ChildProcess} from 'node:child_process';
import {configPath} from '../config.js';

export const terminalOwnership={external:false};
let activeChild:ChildProcess|undefined;
export function cancelExternalEditor(){activeChild?.kill();}
export function splitEditorCommand(command:string):string[]{
 const result:string[]=[];let part='',quote='',started=false;
 for(let i=0;i<command.length;i++){
  const c=command[i]!;
  if(c==='\\'&&quote&&command[i+1]===quote){part+=quote;i++;started=true;continue;}
  if(c==='"'||c==="'"){if(!quote){quote=c;started=true;continue;}if(quote===c){quote='';continue;}}
  if(!quote&&/\s/.test(c)){if(started){result.push(part);part='';started=false;}continue;}
  part+=c;started=true;
 }
 if(quote)throw Error('编辑器命令中的引号未闭合');if(started)result.push(part);
 if(!result[0]||result.some(v=>/[\r\n\x00]/.test(v)))throw Error('编辑器命令无效');return result;
}
export function editorCommand():string[]{
 const file=path.join(path.dirname(configPath()),'editor.json');
 if(fs.existsSync(file)){
  const value=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  if(!Array.isArray(value.command)||!value.command.length||value.command.some((v:unknown)=>typeof v!=='string'||/[\r\n\x00]/.test(v as string))||!value.command[0])throw Error('editor.json 的 command 必须为非空参数数组');return value.command;
 }
 const configured=process.env.VISUAL||process.env.EDITOR;
 if(!configured)throw Error('请配置 editor.json 的 command，或设置 VISUAL / EDITOR（GUI 编辑器请使用 --wait）');
 return splitEditorCommand(configured);
}
export interface EditorResult {status:'complete'|'failed';content?:string;recoveryPath?:string;reason?:string}
export async function editExternally(content:string,options:{root?:string;command?:string[];suspend?:()=>void;resume?:()=>void;validate?:(content:string)=>void}={}):Promise<EditorResult>{
 const command=options.command??editorCommand();
 const parent=path.join(options.root??process.cwd(),'.spawn','editor-drafts');fs.mkdirSync(parent,{recursive:true,mode:0o700});
 const directory=fs.mkdtempSync(path.join(parent,'draft-')),file=path.join(directory,'prompt.md');fs.writeFileSync(file,content,{encoding:'utf8',mode:0o600});
 let suspended=false;
 try{
  suspended=true;options.suspend?.();
  const outcome=await new Promise<{code:number|null;launched:boolean}>(resolve=>{
   // No shell expansion: quoted paths and --wait are independent arguments.
   const child=spawn(command[0]!,[...command.slice(1),file],{stdio:'inherit',shell:false,windowsHide:false});activeChild=child;
   child.once('error',()=>resolve({code:null,launched:false}));child.once('close',code=>resolve({code,launched:true}));
  });
  if(!outcome.launched||outcome.code!==0)return {status:'failed',recoveryPath:file,reason:outcome.launched?'编辑器未正常退出，草稿已保留':'编辑器启动失败；Windows 请指定可执行文件（例如 Code.exe --wait），不要使用 .cmd 包装器'};
  const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.size>1_000_000)return {status:'failed',recoveryPath:file,reason:'编辑结果不是普通文件或超过 1 MB，原草稿保持不变'};
  const text=fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n');
  try{options.validate?.(text);}catch{return {status:'failed',recoveryPath:file,reason:'编辑结果校验失败，原文件未改写；请修正恢复文件后重试'};}
  fs.unlinkSync(file);try{fs.rmdirSync(directory);}catch{/* Editors may leave swap/backup files; never delete those. */}
  return {status:'complete',content:text};
 }catch{return {status:'failed',recoveryPath:file,reason:'读取编辑结果失败，原草稿与恢复文件均保留'};}
 finally{activeChild=undefined;if(suspended)options.resume?.();}
}
