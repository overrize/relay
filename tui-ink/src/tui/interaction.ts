import fs from 'node:fs';import path from 'node:path';import {configPath,type ProviderConfig} from '../config.js';
export const PRODUCT_NAME='Relay';
export function uiPreferences(){try{const p=JSON.parse(fs.readFileSync(path.join(path.dirname(configPath()),'relay-ui.json'),'utf8'));return {favorites:Array.isArray(p.favorites)?p.favorites.filter((v:unknown)=>typeof v==='string').slice(0,500):[] as string[]};}catch{return {favorites:[] as string[]};}}
export function toggleFavorite(name:string){const p=uiPreferences(),favorites=p.favorites.includes(name)?p.favorites.filter((v:string)=>v!==name):[...p.favorites,name];const file=path.join(path.dirname(configPath()),'relay-ui.json');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify({favorites}),{mode:0o600});return favorites;}
export function configuredModels(models:Record<string,ProviderConfig>){return Object.keys(models).filter(n=>!!models[n]!.apiKey||(models[n]!.transport!==undefined&&models[n]!.transport!=='http'));}
export function cycleModel(models:Record<string,ProviderConfig>,current:string,direction:1|-1,favorites:string[]){const ready=configuredModels(models),scoped=ready.filter(n=>favorites.includes(n)),choices=scoped.length?scoped:ready;if(!choices.length)return undefined;const i=choices.indexOf(current);return choices[(i<0?(direction===1?0:choices.length-1):(i+direction+choices.length)%choices.length)];}
const levels=['low','medium','high','max'] as const;
export async function nextReasoning(model:ProviderConfig,fetcher=fetch){
 if(model.provider!=='openai'||model.transport&&model.transport!=='http')return undefined;
 const url=new URL(model.baseUrl??'https://api.openai.com');if(url.username||url.password||url.search||url.hash)throw Error('invalid-endpoint');url.pathname=url.pathname.replace(/\/$/,'')+(model.exactBaseUrl||url.pathname.replace(/\/$/,'').endsWith('/v1')?'/models':'/v1/models');
 const r=await fetcher(url,{headers:{Authorization:`Bearer ${model.apiKey}`},redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('model-capabilities-unavailable');
 const {jsonBounded}=await import('../models/catalog.js');const body=await jsonBounded(r),metadata=body?.data?.find((m:any)=>m.id===model.model),supported=metadata?.effort?.supported_levels?.filter((v:unknown)=>levels.includes(v as any));if(!Array.isArray(supported)||!supported.length)return undefined;
 const current=model.reasoningEffort??metadata.effort.default_level,index=supported.indexOf(current);return supported[(index+1)%supported.length] as typeof levels[number];
}
