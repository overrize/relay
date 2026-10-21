import snapshot from './providerSnapshot.json' with {type:'json'};
export interface LoginProvider {
 id:string;sourceId:string;label:string;protocol:'openai'|'anthropic';endpoint:string;
 subscription:boolean;authProvider?:'codex'|'claude'|'copilot';gatewayOnly?:boolean;plan?:boolean;exactBaseUrl?:boolean;
 streamUsage?:boolean;
}
const legacy:LoginProvider[]=[
 {id:'codex',sourceId:'openai',label:'OpenAI / Codex',protocol:'openai',endpoint:'https://api.openai.com/v1',subscription:true,authProvider:'codex'},
 {id:'claude',sourceId:'anthropic',label:'Anthropic / Claude',protocol:'anthropic',endpoint:'https://api.anthropic.com',subscription:true,authProvider:'claude'},
 {id:'copilot',sourceId:'github-copilot',label:'GitHub Copilot',protocol:'openai',endpoint:'',subscription:true,authProvider:'copilot'},
 {id:'custom',sourceId:'custom',label:'自定义 OpenAI 兼容 API',protocol:'openai',endpoint:'',subscription:false},
 {id:'deepseek',sourceId:'deepseek',label:'DeepSeek API',protocol:'openai',endpoint:'https://api.deepseek.com/v1',subscription:false},
 {id:'kimi',sourceId:'moonshotai-cn',label:'Kimi / Moonshot API',protocol:'openai',endpoint:'https://api.moonshot.cn/v1',subscription:false},
];
const used=new Set(legacy.map(p=>p.sourceId));
// Official OpenAI-compatible surfaces, verified 2026-10-21; OAuth remains separate.
const compatibility:Record<string,string>={google:'https://generativelanguage.googleapis.com/v1beta/openai',mistral:'https://api.mistral.ai/v1',ollama:'https://ollama.com/v1',xai:'https://api.x.ai/v1'};
export const loginProviders:LoginProvider[]=[...legacy,...snapshot.providers.filter(p=>!used.has(p.id)).map(p=>({
 id:p.id,sourceId:p.id,label:p.label,protocol:p.protocol as 'openai'|'anthropic',endpoint:p.endpoint,
 subscription:p.plan||p.oauth,plan:p.plan,gatewayOnly:p.gatewayOnly&&!compatibility[p.id],
 ...(compatibility[p.id]?{protocol:'openai' as const,endpoint:compatibility[p.id]}:{}),
 ...(p.id==='mistral'?{streamUsage:false}:{}),
 ...(p.id==='chatgpt-subscription'?{authProvider:'codex' as const}:{}),
 // OpenAI-compatible services may use /v2 or /api without an additional /v1.
 exactBaseUrl:!!compatibility[p.id]||p.protocol==='openai'&&!p.gatewayOnly,
})).sort((a,b)=>a.label.localeCompare(b.label))];
export const providerDirectorySource={source:snapshot.source,version:snapshot.version,url:snapshot.sourceUrl,count:snapshot.providers.length};
export function providerInfo(id:string){return loginProviders.find(p=>p.id===id);}
export function directoryModels(id:string){return snapshot.providers.find(p=>p.id===(providerInfo(id)?.sourceId??id))?.models??[];}
