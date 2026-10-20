import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { writeSnapshot } from "../memory/atomic.js";

export type UsageProvider = "claude" | "codex" | "copilot";
export interface UsageWindow { label: string; scope?: string; usedPercent?: number; remainingPercent?: number; resetsAt?: number; remaining?: number; limit?: number; unlimited?: boolean; unit?: string }
export interface UsageAttempt { id: string; at: number; durationMs: number; state: UsageSnapshot["state"]; code?: string; httpStatus?: number }
export interface UsageSnapshot { provider: UsageProvider; state: "fresh" | "unknown" | "stale" | "error"; windows: UsageWindow[]; checkedAt: number; observedAt?: number; retryAt?: number; accountKey?: string; errorCode?: string; httpStatus?: number; attempts?: UsageAttempt[] }
export class UsageError extends Error { constructor(public code: string, public retryAfterMs = 60000, public httpStatus?: number) { super(code); } }
export const usageSources: Record<UsageProvider,string> = {claude:"Claude usage endpoint",codex:"Codex app-server account/rateLimits/read",copilot:"Copilot SDK account.getQuota"};
const inflight = new Map<string,Promise<UsageSnapshot>>();
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");
export function copilotHome() { return path.resolve(process.env.SPAWN_COPILOT_HOME ?? path.join(process.cwd(),".spawn","accounts","copilot")); }
export function usageIdentity(provider: UsageProvider): string {
  try {
    if(provider === "claude") { const home=process.env.CLAUDE_CONFIG_DIR??path.join(os.homedir(),".claude");const auth=JSON.parse(fs.readFileSync(path.join(home,".credentials.json"),"utf8"));return fingerprint(String(auth.claudeAiOauth?.accessToken??home)); }
    if(provider === "codex") { const home=process.env.CODEX_HOME??path.join(os.homedir(),".codex");const auth=JSON.parse(fs.readFileSync(path.join(home,"auth.json"),"utf8"));return fingerprint(String(auth.tokens?.account_id??home)); }
  } catch { /* A missing login is a query result, not a reason to expose credential data. */ }
  const home=copilotHome(), revision=["config.json","accounts.json","hosts.json"].map(name=>{try{const s=fs.statSync(path.join(home,name));return `${name}:${s.mtimeMs}:${s.size}`;}catch{return name;}}).join("|");
  return fingerprint(provider === "copilot" ? home+revision : `${provider}:${process.env.CODEX_HOME??process.env.CLAUDE_CONFIG_DIR??os.homedir()}`);
}
function cacheFile(provider: UsageProvider, identity: string) { return path.join(path.resolve(process.env.SPAWN_USAGE_CACHE_DIR??path.join(process.cwd(),".spawn","usage-cache")),`${provider}-${fingerprint(identity)}.json`); }
function read(file: string, provider: UsageProvider): UsageSnapshot | undefined {
  try { const value=JSON.parse(fs.readFileSync(file,"utf8")); if(value.provider!==provider || !Array.isArray(value.windows) || !Number.isFinite(value.checkedAt)) return; return value; } catch { return; }
}
export function cachedUsage(provider: UsageProvider, now=Date.now()): UsageSnapshot {
  const value=read(cacheFile(provider,usageIdentity(provider)),provider);
  if(!value)return {provider,state:"unknown",windows:[],checkedAt:0};
  return value.state === "fresh" && now-(value.observedAt??0)>90000 ? {...value,state:"stale"} : value;
}
export function usageExhausted(value: UsageSnapshot, now=Date.now(),model?:string): boolean {
  const windows=value.provider==="codex"?value.windows.filter(w=>w.label.startsWith("codex:")):value.provider==="copilot"&&value.windows.some(w=>w.label==="premium_interactions")?value.windows.filter(w=>w.label==="premium_interactions"):value.windows;
  const applicable=windows.filter(w=>{if(!w.scope)return true;if(!model)return false;const family=/sonnet|opus|haiku/.exec(w.scope.toLowerCase())?.[0];return family?model.toLowerCase().includes(family):model.toLowerCase().replace(/[^a-z0-9]/g,"")===w.scope.toLowerCase().replace(/[^a-z0-9]/g,"");});
  return value.state === "fresh" && value.observedAt!==undefined && now-value.observedAt>=0 && now-value.observedAt<=90000 && applicable.some(w=>!w.unlimited && w.remainingPercent===0 && (w.resetsAt===undefined||w.resetsAt>now));
}
export async function refreshUsage(provider: UsageProvider, options: {force?:boolean; now?:()=>number; identity?:string; fetch?:()=>Promise<UsageWindow[]>} = {}):Promise<UsageSnapshot> {
  const now=options.now??Date.now, identity=options.identity??usageIdentity(provider), file=cacheFile(provider,identity), before=read(file,provider), time=now();
  if(before && ((before.retryAt??0)>time || time-before.checkedAt<(options.force?5000:90000))) return before.state === "fresh" && time-(before.observedAt??0)>90000 ? {...before,state:"stale"}:before;
  const running=inflight.get(file);if(running)return running;
  const work=(async()=>{
    fs.mkdirSync(path.dirname(file),{recursive:true});const lock=file+".lock",nonce=randomUUID();let held=false;
    try {
      try { fs.writeFileSync(lock,nonce,{flag:"wx",mode:0o600});held=true; }
      catch(e:any){if(e.code!=="EEXIST")throw e;if(time-fs.statSync(lock).mtimeMs>30000){fs.unlinkSync(lock);fs.writeFileSync(lock,nonce,{flag:"wx",mode:0o600});held=true;}else return before?{...before,state:before.state==="fresh"?"stale":before.state}:{provider,state:"unknown" as const,windows:[],checkedAt:time,errorCode:"query-in-progress"};}
      const fetcher=options.fetch??(async()=>{const {fetchUsage}=await import("./usageProviders.js");return fetchUsage(provider);});
      let result:UsageSnapshot;
      try {const windows=await fetcher();result={provider,state:windows.length?"fresh":"unknown",windows,checkedAt:now(),observedAt:now(),accountKey:identity,...(!windows.length?{errorCode:"no-quota-data"}:{})};}
      catch(error){const e=error instanceof UsageError?error:new UsageError("usage-unavailable");result={provider,state:before?.windows.length?"stale":"error",windows:before?.windows??[],observedAt:before?.observedAt,checkedAt:now(),retryAt:now()+Math.min(1800000,Math.max(5000,e.retryAfterMs)),accountKey:identity,errorCode:/^[a-z0-9-]{1,80}$/.test(e.code)?e.code:"usage-unavailable",...(Number.isInteger(e.httpStatus)&&e.httpStatus!>=100&&e.httpStatus!<=599?{httpStatus:e.httpStatus}:{})};}
      result.attempts=[...(before?.attempts??[]).slice(-9),{id:randomUUID(),at:result.checkedAt,durationMs:Math.max(0,result.checkedAt-time),state:result.state,...(result.errorCode?{code:result.errorCode}:{}),...(result.httpStatus?{httpStatus:result.httpStatus}:{})}];
      writeSnapshot(file,JSON.stringify(result));return result;
    } finally {if(held)try{if(fs.readFileSync(lock,"utf8")===nonce)fs.unlinkSync(lock);}catch{}}
  })();
  inflight.set(file,work);try{return await work;}finally{inflight.delete(file);}
}
const finite=(n:unknown): n is number=>typeof n==="number"&&Number.isFinite(n);
const percent=(n:unknown):n is number=>finite(n)&&n>=0&&n<=100;
const instant=(n:unknown)=>typeof n==="string"&&Number.isFinite(Date.parse(n))?Date.parse(n):undefined;
export function parseUsage(provider: UsageProvider, data: any): UsageWindow[] {
  const result:UsageWindow[]=[];
  if(provider==="claude"){
    for(const row of Array.isArray(data?.limits)?data.limits:[])if(percent(row?.percent))result.push({label:row.kind==="session"?"5h":String(row.kind??"window").slice(0,64),...(row.kind==="weekly_scoped"?{scope:String(row.scope?.model?.id??row.scope?.model?.display_name??"unknown").slice(0,80)}:{}),usedPercent:row.percent,remainingPercent:100-row.percent,resetsAt:instant(row.resets_at)});
    if(!result.length)for(const key of ["five_hour","seven_day","seven_day_sonnet","seven_day_opus"])if(percent(data?.[key]?.utilization))result.push({label:key,...(key.endsWith("sonnet")?{scope:"sonnet"}:key.endsWith("opus")?{scope:"opus"}:{}),usedPercent:data[key].utilization,remainingPercent:100-data[key].utilization,resetsAt:instant(data[key].resets_at)});
  }else if(provider==="codex"){
    const buckets=data?.rateLimitsByLimitId?Object.entries(data.rateLimitsByLimitId):[["codex",data?.rateLimits]];
    for(const [id,bucket] of buckets as Array<[string,any]>)for(const key of ["primary","secondary"]) {const row=bucket?.[key];if(percent(row?.usedPercent))result.push({label:`${id}:${key}`,usedPercent:row.usedPercent,remainingPercent:100-row.usedPercent,resetsAt:finite(row.resetsAt)?row.resetsAt*1000:undefined});}
  }else{
    for(const [label,row] of Object.entries(data?.quotaSnapshots??{}) as Array<[string,any]>) {
      if(row?.isUnlimitedEntitlement===true){result.push({label,unlimited:true,unit:label.includes("credit")?"credits":"requests"});continue;}
      if(percent(row?.remainingPercentage)) result.push({label,remainingPercent:row.remainingPercentage,usedPercent:100-row.remainingPercentage,resetsAt:instant(row.resetDate),remaining:finite(row.entitlementRequests)&&finite(row.usedRequests)?Math.max(0,row.entitlementRequests-row.usedRequests):undefined,limit:finite(row.entitlementRequests)?row.entitlementRequests:undefined,unit:label.includes("credit")?"credits":"requests"});
    }
  }
  return result;
}
