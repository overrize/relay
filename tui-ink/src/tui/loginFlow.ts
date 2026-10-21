import { configPath, loadConfig, resolveModelConfigInput, saveLoginModel, type ProviderConfig } from "../config.js";
import {preparedCatalog,discoverModels,type ModelCatalog} from "../models/catalog.js";
import {modelAssignmentSummary} from "./modelLabels.js";
import {loginProviders} from '../models/ProviderDirectory.js';
export {loginProviders} from '../models/ProviderDirectory.js';
type Stage="region"|"profile"|"project"|"provider"|"mode"|"unsupported"|"subscription"|"busy"|"endpoint"|"key"|"models"|"model"|"alias"|"target"|"confirm"|"done";
export class LoginFlow {
  stage:Stage="mode";providerIndex=0;mode:"api"|"subscription"="api";endpoint="";model="";alias="";target:"register"|"worker"|"pm"|"all"="worker";
  #key="";
  gateway=false;
  cloud?:ProviderConfig["cloud"];
  native=false;
  catalog:ModelCatalog=preparedCatalog("custom","api");
  constructor(private save=saveLoginModel){}
  get provider(){return loginProviders[this.providerIndex]!;}
  get availableProviders(){return loginProviders.map((provider,index)=>({provider,index})).filter(({provider})=>this.mode==="subscription"?provider.subscription:provider.id!=="copilot"&&provider.id!=="chatgpt-subscription");}
  view(){
    const titles:Record<Stage,string>={region:"云区域（如 us-east-1 / us-central1 / global）",profile:"AWS profile（留空使用默认凭据链）",project:"GCP project ID",provider:"选择供应商",mode:"选择接入方式",unsupported:"该供应商的原生协议或 OAuth 尚未接入",subscription:"官方订阅认证",busy:"等待官方登录/认证检查，Esc 可取消",endpoint:"API Base URL（可保留厂商默认值）",key:"API Key（隐藏输入，不进入聊天历史）",models:"选择模型 · 输入搜索，↑↓ 选择，Enter 确认",model:"高级：手动输入模型 ID",alias:"本地模型名称",target:"选择用途",confirm:"确认保存",done:"配置已保存"};
    const registered=Object.values(loadConfig().models);
    const options=this.stage==="provider"?this.availableProviders.map(({provider:p})=>{const configured=registered.some(m=>p.nativeAuth&&m.catalogProvider===p.sourceId?!!m.apiKey||m.transport===p.nativeAuth:this.mode==="subscription"&&!p.plan?m.transport===`${p.authProvider=== "copilot"?"copilot-sdk":`${p.authProvider}-cli`}`:!!m.apiKey&&(m.transport??"http")==="http"&&(m.catalogProvider===p.sourceId||!!p.endpoint&&m.baseUrl?.replace(/\/$/,"")===p.endpoint.replace(/\/$/,"")));return `${p.label} · ${configured?"已配置":"未配置"}${p.gatewayOnly&&!p.authProvider?" · 需要兼容网关":p.plan?" · 套餐密钥":""}`;}):this.stage==="mode"?["账号登录 / OAuth / 云身份（按供应商计费）","API Key"]:this.stage==="subscription"?this.native?[this.provider.nativeAuth==="openrouter"?"开始 OpenRouter 浏览器 OAuth（API 计费）":"检查云凭据（不验证模型权限）"]:["检查已登录的官方客户端","启动官方浏览器/设备登录"]:this.stage==="unsupported"?[this.provider.gatewayOnly?"使用自备 OpenAI 兼容网关（API 计费，非订阅认证）":"改用该供应商 API Key（API 计费，非订阅认证）","返回接入方式"]:this.stage==="models"?[...this.catalog.models.map(m=>m.label===m.id?m.id:`${m.label} · ${m.id}`),"刷新账号模型列表","手动输入模型 ID（高级）"]:this.stage==="target"?["Worker / implement","PM","所有角色与定位","仅注册，稍后 /route 分配"]:this.stage==="confirm"?["确认保存","取消"]:[];
    const summary=[`${this.provider.label} · ${this.native?(this.provider.nativeAuth==="openrouter"?"OAuth / API 计费":"云身份 / API 计费"):this.mode} · ${this.model||"尚未选模型"}`,...(this.stage==="confirm"?[`名称 ${this.alias}${loadConfig().models[this.alias]?"（将覆盖同名配置）":""}；用途 ${this.target}`,`保存位置 ${configPath()}`,"API 仅配置，不发起付费验证；当前运行的 agent 继续使用原配置。"]:[])];
    if(this.native)summary.push(this.provider.nativeAuth==="openrouter"?"OAuth 授权生成 API Key；按 OpenRouter 账户额度扣费":"云身份按 API 计费；凭据检查不代表 IAM 或模型权限可用");
    if(this.stage==="subscription"&&this.native&&this.provider.nativeAuth!=="openrouter")summary.push(this.provider.nativeAuth==="bedrock"?"先在终端运行 aws sso login --profile <profile>，或配置环境 / 工作负载身份":"先在终端运行 gcloud auth application-default login，或配置 GOOGLE_APPLICATION_CREDENTIALS / 工作负载身份");
    if(this.stage==="models")summary.push(this.catalog.source==="account"?"来源：账号接口返回的模型目录（未发起推理）":`来源：预置目录；账号权限未验证${this.catalog.reason?` · ${this.catalog.reason}`:""}`);
    return {stage:this.stage,title:this.native&&this.stage==="subscription"?"原生账号 / 云身份认证":titles[this.stage],options,secret:this.stage==="key",defaultValue:this.stage==="region"?(this.provider.nativeAuth==="bedrock"?"us-east-1":"us-central1"):this.stage==="endpoint"?this.endpoint:this.stage==="alias"?this.alias:"",summary};
  }
  choose(index:number):"check"|"login"|"save"|"cancel"|"models"|undefined {
    if(!Number.isInteger(index)||index<0||index>=this.view().options.length)throw new Error("请选择有效选项");
    if(this.stage==="mode"){this.mode=index===0?"subscription":"api";this.stage="provider";}
    else if(this.stage==="provider"){this.providerIndex=this.availableProviders[index]!.index;this.endpoint=this.provider.endpoint;this.gateway=false;this.native=!!this.provider.nativeAuth&&(this.mode==="subscription"||this.provider.nativeAuth!=="openrouter");this.cloud=undefined;this.stage=this.native?(this.provider.nativeAuth==="openrouter"?"subscription":"region"):this.mode==="subscription"&&this.provider.authProvider?"subscription":(this.provider.gatewayOnly||this.mode==="subscription"&&!this.provider.plan)?"unsupported":!this.endpoint?"endpoint":"key";}
    else if(this.stage==="unsupported"){if(index===1){this.stage="mode";return;}this.mode="api";if(!this.provider.gatewayOnly&&this.provider.endpoint){this.gateway=false;this.endpoint=this.provider.endpoint;this.stage="key";}else{this.gateway=true;this.endpoint="";this.stage="endpoint";}}
    else if(this.stage==="subscription"){this.stage="busy";return this.native?"login":index===0?"check":"login";}
    else if(this.stage==="models"){if(index===this.catalog.models.length)return "models";if(index===this.catalog.models.length+1){this.stage="model";return;}this.selectModel(this.catalog.models[index]!.id);}
    else if(this.stage==="target"){this.target=(["worker","pm","all","register"] as const)[index]!;this.stage="confirm";}
    else if(this.stage==="confirm")return index===0?"save":"cancel";
  }
  submit(raw:string){
    if(this.stage==="region"){const region=raw.trim()||this.view().defaultValue;if(!/^[-a-z0-9]{1,64}$/.test(region))throw new Error("区域格式无效");this.cloud={region};this.stage=this.provider.nativeAuth==="bedrock"?"profile":"project";return;}
    if(this.stage==="profile"){const profile=raw.trim();if(profile&&!/^[-\w.@]{1,128}$/.test(profile))throw new Error("profile 格式无效");if(profile)this.cloud!.profile=profile;this.stage="subscription";return;}
    if(this.stage==="project"){const project=raw.trim();if(!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project))throw new Error("请输入 GCP project ID");this.cloud!.project=project;this.stage="subscription";return;}
    if(this.stage==="key"){if(!raw.trim()||/[\r\n]/.test(raw))throw new Error("请输入单行 API Key");this.#key=raw.trim();this.catalog=preparedCatalog(this.provider.id,this.mode);this.stage="models";return;}
    const value=raw.trim()||this.view().defaultValue;
    if(this.stage==="endpoint"){let url:URL;try{url=new URL(value);}catch{throw new Error("请输入有效 HTTP(S) API 地址");}if(!["https:","http:"].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error("API 地址不能包含凭据、查询参数或片段");this.endpoint=value.replace(/\/$/,"");this.stage="key";}
    else if(this.stage==="model"){if(!value||value.length>160||/[\r\n]/.test(value))throw new Error("请输入有效模型 ID");this.selectModel(value);}
    else if(this.stage==="alias"){if(!/^[a-zA-Z0-9_.-]{1,80}$/.test(value)||["__proto__","prototype","constructor"].includes(value))throw new Error("名称须为 1..80 位字母、数字、点、横线或下划线");this.alias=value;this.stage="target";}
  }
  private selectModel(value:string){this.model=value;this.alias=`${this.provider.id}-${this.mode}-${value}`.replace(/[^a-zA-Z0-9_.-]/g,"-").slice(0,80);this.stage="target";}
  async refreshModels(signal:AbortSignal){if(this.native&&this.provider.nativeAuth!=="openrouter"){this.catalog.reason="云模型目录为预置；尚未验证区域、IAM 和模型授权";return;}const value=await discoverModels(this.mode==="subscription"&&this.provider.authProvider?this.provider.authProvider:this.provider.id,this.mode==="subscription"&&this.provider.authProvider?"subscription":"api",this.endpoint,this.#key,signal,undefined,undefined,{protocol:this.gateway?"openai":this.provider.protocol,exactBaseUrl:!this.gateway&&this.provider.exactBaseUrl});if(!signal.aborted&&this.stage==="models")this.catalog=value;}
  nativeConfig():ProviderConfig{return {provider:"openai",model:this.model||"pending",apiKey:"",transport:this.provider.nativeAuth==="bedrock"?"bedrock":"vertex",cloud:this.cloud,billing:{mode:"api"},catalogProvider:this.provider.sourceId,capabilities:{nativeFC:false,structuredOutput:false}};}
  authenticated(key?:string){if(key)this.#key=key;if(this.stage==="busy"){this.catalog=preparedCatalog(this.provider.authProvider??this.provider.id,this.mode);if(this.native&&this.provider.nativeAuth==="vertex")this.catalog.models=this.catalog.models.filter(m=>/^(google\/)?gemini-/.test(m.id));this.stage="models";}}
  authFailed(){if(this.stage==="busy")this.stage="subscription";}
  finish(){
    if(this.stage!=="confirm")throw new Error("请先确认配置");
    const model:ProviderConfig=this.native?(this.provider.nativeAuth==="openrouter"?{provider:"openai",model:this.model,apiKey:this.#key,baseUrl:"https://openrouter.ai/api/v1",exactBaseUrl:true,catalogProvider:"openrouter",billing:{mode:"api"}}:this.nativeConfig()):this.mode==="subscription"&&this.provider.authProvider?resolveModelConfigInput(`${this.provider.authProvider}-subscription`,this.model)!:{provider:this.gateway?"openai":this.provider.protocol,model:this.model,apiKey:this.#key,baseUrl:this.endpoint,catalogProvider:this.provider.sourceId,streamUsage:this.gateway?undefined:this.provider.streamUsage,exactBaseUrl:!this.gateway&&this.provider.exactBaseUrl,transport:"http",billing:{mode:this.provider.plan&&!this.gateway?"subscription":"api"}};
    if(!model||((model.transport??"http")==="http"&&!this.#key))throw new Error("配置不完整");this.save(this.alias,model,this.target);this.#key="";this.stage="done";
    return `模型 ${this.alias} 已保存（${model.billing?.mode??this.mode}）。当前配置：${modelAssignmentSummary(loadConfig())}。尚未运行的角色立即更新显示；已运行的 agent 保持实际模型，新配置在新启动/恢复时生效。/account 查看，/audit 追溯消耗。`;
  }
  dispose(){this.#key="";}
}
