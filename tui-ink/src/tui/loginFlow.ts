import { configPath, loadConfig, resolveModelConfigInput, saveLoginModel, type ProviderConfig } from "../config.js";
import {preparedCatalog,discoverModels,type ModelCatalog} from "../models/catalog.js";
import {modelAssignmentSummary} from "./modelLabels.js";
export const loginProviders=[
  {id:"codex",label:"OpenAI / Codex",protocol:"openai",endpoint:"https://api.openai.com/v1",subscription:true},
  {id:"claude",label:"Anthropic / Claude",protocol:"anthropic",endpoint:"https://api.anthropic.com",subscription:true},
  {id:"copilot",label:"GitHub Copilot",protocol:"openai",endpoint:"",subscription:true},
  {id:"custom",label:"自定义 OpenAI 兼容 API",protocol:"openai",endpoint:"",subscription:false},
  {id:"deepseek",label:"DeepSeek API",protocol:"openai",endpoint:"https://api.deepseek.com/v1",subscription:false},
  {id:"kimi",label:"Kimi / Moonshot API",protocol:"openai",endpoint:"https://api.moonshot.cn/v1",subscription:false},
] as const;
type Stage="provider"|"mode"|"subscription"|"busy"|"endpoint"|"key"|"models"|"model"|"alias"|"target"|"confirm"|"done";
export class LoginFlow {
  stage:Stage="mode";providerIndex=0;mode:"api"|"subscription"="api";endpoint="";model="";alias="";target:"register"|"worker"|"pm"|"all"="worker";
  #key="";
  catalog:ModelCatalog=preparedCatalog("custom","api");
  constructor(private save=saveLoginModel){}
  get provider(){return loginProviders[this.providerIndex]!;}
  get availableProviders(){return loginProviders.map((provider,index)=>({provider,index})).filter(({provider})=>this.mode==="subscription"?provider.subscription:provider.id!=="copilot");}
  view(){
    const titles:Record<Stage,string>={provider:"选择供应商",mode:"选择接入方式",subscription:"官方订阅认证",busy:"等待官方登录/认证检查，Esc 可取消",endpoint:"API Base URL（可保留厂商默认值）",key:"API Key（隐藏输入，不进入聊天历史）",models:"选择模型 · 输入搜索，↑↓ 选择，Enter 确认",model:"高级：手动输入模型 ID",alias:"本地模型名称",target:"选择用途",confirm:"确认保存",done:"配置已保存"};
    const registered=Object.values(loadConfig().models);
    const options=this.stage==="provider"?this.availableProviders.map(({provider:p})=>{const configured=registered.some(m=>this.mode==="subscription"?m.transport===`${p.id=== "copilot"?"copilot-sdk":`${p.id}-cli`}`:(m.transport??"http")==="http"&&m.baseUrl?.replace(/\/$/,"")===p.endpoint.replace(/\/$/,""));return `${p.label} · ${configured?"已配置":"未配置"}`;}):this.stage==="mode"?["账号登录（订阅）","API Key"]:this.stage==="subscription"?["检查已登录的官方客户端","启动官方浏览器/设备登录"]:this.stage==="models"?[...this.catalog.models.map(m=>m.label===m.id?m.id:`${m.label} · ${m.id}`),"刷新账号模型列表","手动输入模型 ID（高级）"]:this.stage==="target"?["Worker / implement","PM","所有角色与定位","仅注册，稍后 /route 分配"]:this.stage==="confirm"?["确认保存","取消"]:[];
    const summary=[`${this.provider.label} · ${this.mode} · ${this.model||"尚未选模型"}`,...(this.stage==="confirm"?[`名称 ${this.alias}${loadConfig().models[this.alias]?"（将覆盖同名配置）":""}；用途 ${this.target}`,`保存位置 ${configPath()}`,"API 仅配置，不发起付费验证；当前运行的 agent 继续使用原配置。"]:[])];
    if(this.stage==="models")summary.push(this.catalog.source==="account"?"来源：账号接口返回的模型目录（未发起推理）":`来源：预置目录；账号权限未验证${this.catalog.reason?` · ${this.catalog.reason}`:""}`);
    return {stage:this.stage,title:titles[this.stage],options,secret:this.stage==="key",defaultValue:this.stage==="endpoint"?this.endpoint:this.stage==="alias"?this.alias:"",summary};
  }
  choose(index:number):"check"|"login"|"save"|"cancel"|"models"|undefined {
    if(!Number.isInteger(index)||index<0||index>=this.view().options.length)throw new Error("请选择有效选项");
    if(this.stage==="mode"){this.mode=index===0?"subscription":"api";this.stage="provider";}
    else if(this.stage==="provider"){this.providerIndex=this.availableProviders[index]!.index;this.endpoint=this.provider.endpoint;this.stage=this.mode==="subscription"?"subscription":this.provider.id==="custom"?"endpoint":"key";}
    else if(this.stage==="subscription"){this.stage="busy";return index===0?"check":"login";}
    else if(this.stage==="models"){if(index===this.catalog.models.length)return "models";if(index===this.catalog.models.length+1){this.stage="model";return;}this.selectModel(this.catalog.models[index]!.id);}
    else if(this.stage==="target"){this.target=(["worker","pm","all","register"] as const)[index]!;this.stage="confirm";}
    else if(this.stage==="confirm")return index===0?"save":"cancel";
  }
  submit(raw:string){
    if(this.stage==="key"){if(!raw.trim()||/[\r\n]/.test(raw))throw new Error("请输入单行 API Key");this.#key=raw.trim();this.catalog=preparedCatalog(this.provider.id,this.mode);this.stage="models";return;}
    const value=raw.trim()||this.view().defaultValue;
    if(this.stage==="endpoint"){let url:URL;try{url=new URL(value);}catch{throw new Error("请输入有效 HTTP(S) API 地址");}if(!["https:","http:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error("API 地址不能包含凭据、查询参数或片段");this.endpoint=value.replace(/\/$/,"");this.stage="key";}
    else if(this.stage==="model"){if(!value||value.length>160||/[\r\n]/.test(value))throw new Error("请输入有效模型 ID");this.selectModel(value);}
    else if(this.stage==="alias"){if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(value)||["__proto__","prototype","constructor"].includes(value))throw new Error("名称须为 1..80 位字母、数字、点、横线或下划线");this.alias=value;this.stage="target";}
  }
  private selectModel(value:string){this.model=value;this.alias=`${this.provider.id}-${this.mode}-${value}`.replace(/[^a-zA-Z0-9_.-]/g,"-").slice(0,80);this.stage="target";}
  async refreshModels(signal:AbortSignal){const value=await discoverModels(this.provider.id,this.mode,this.endpoint,this.#key,signal);if(!signal.aborted&&this.stage==="models")this.catalog=value;}
  authenticated(){if(this.stage==="busy"){this.catalog=preparedCatalog(this.provider.id,this.mode);this.stage="models";}}
  authFailed(){if(this.stage==="busy")this.stage="subscription";}
  finish(){
    if(this.stage!=="confirm")throw new Error("请先确认配置");
    const model:ProviderConfig=this.mode==="subscription"?resolveModelConfigInput(`${this.provider.id}-subscription`,this.model)!:{provider:this.provider.protocol,model:this.model,apiKey:this.#key,baseUrl:this.endpoint,transport:"http",billing:{mode:"api"}};
    if(!model||(this.mode==="api"&&!this.#key))throw new Error("配置不完整");this.save(this.alias,model,this.target);this.#key="";this.stage="done";
    return `模型 ${this.alias} 已保存（${this.mode}）。当前配置：${modelAssignmentSummary(loadConfig())}。尚未运行的角色立即更新显示；已运行的 agent 保持实际模型，新配置在新启动/恢复时生效。/account 查看，/audit 追溯消耗。`;
  }
  dispose(){this.#key="";}
}
