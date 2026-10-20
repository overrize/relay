import { SessionJournal, type Entry } from "./Journal.js";
import fs from "node:fs";
import path from "node:path";
import {digest} from "./Storage.js";

export interface AuditTotals { requests:number; tokens:number; microUsd:number; pending:number; uncertain:number; unpriced:number }
export interface AuditGroup extends AuditTotals { key:string; model?:string; provider?:string; transport?:string; billing?:string; conversation?:string; task?:string; revision?:number }
export interface AuditRow { seq:number; at:number; kind:string; id:string; agent:string; conversation:string; revision:number; task?:string; model?:string; provider?:string; transport?:string; billing?:string; tokens?:number; microUsd?:number; inputTokens?:number; outputTokens?:number; inputRate?:number; outputRate?:number; pricingKnown?:boolean; state:string; reason?:string; requestId?:string; httpStatus?:number }
export interface AuditFilter { model?:string; task?:string; before?:number; limit?:number }
const zero=():AuditTotals=>({requests:0,tokens:0,microUsd:0,pending:0,uncertain:0,unpriced:0});
/** Export only reason categories, never prompts, command output or provider diagnostics. */
export function auditReason(value:unknown):string {
  const s=String(value??"");
  const code=/\b(?:SUBSCRIPTION_[A-Z_]+|SESSION_BUDGET_EXHAUSTED|MODEL_ROUTE)\b/.exec(s)?.[0];if(code)return code;
  if(/AbortError|cancel|pause/i.test(s))return "cancelled";
  if(/supersed|requirement/i.test(s))return "requirement-superseded";
  if(/restart|interrupt|owner-lost/i.test(s))return "interrupted";
  if(/quota|rate.limit|\b429\b/i.test(s))return "quota-or-rate-limit";
  if(/timeout|deadline|timed.out/i.test(s))return "timeout";
  if(/budget|request.*exhaust/i.test(s))return "task-budget-exhausted";
  if(/conflict/i.test(s))return "workspace-conflict";
  if(/check.*pass|independent-review|accepted/i.test(s))return "acceptance";
  if(/login|auth|\b40[13]\b/i.test(s))return "authentication-or-access";
  return "unspecified";
}
export async function auditReport(root=process.cwd(), filter:AuditFilter={}) {
  if(filter.before!==undefined&&(!Number.isSafeInteger(filter.before)||filter.before<1))throw new Error("Audit before must be a positive sequence");
  if(filter.limit!==undefined&&(!Number.isSafeInteger(filter.limit)||filter.limit<1||filter.limit>200))throw new Error("Audit limit must be 1..200");
  const floorFile=path.join(root,".spawn","budget-floor.json");let floor:{requests:number;tokens:number;microUsd:number}|undefined;
  if(fs.existsSync(floorFile)){const {digest:actual,...body}=JSON.parse(fs.readFileSync(floorFile,"utf8"));if(body.version!==1||digest(body)!==actual)throw new Error("Audit spending floor integrity failure");floor=body.used;}
  const j=new SessionJournal(root), totals=zero(), models=new Map<string,AuditGroup>(),tasks=new Map<string,AuditGroup>();
  const pending=new Map<string,{row:AuditRow;model:AuditGroup;task:AuditGroup}>(),seen=new Set<string>(),agentTasks=new Map<string,string>();
  const rows:AuditRow[]=[],limit=filter.limit??40;let matched=0,queryCount=0;
  const remember=(row:AuditRow)=>{if((filter.model&&row.model!==filter.model)||(filter.task&&row.task!==filter.task)||(filter.before&&row.seq>=filter.before))return;matched++;rows.push(row);if(rows.length>limit)rows.shift();};
  const group=(map:Map<string,AuditGroup>,key:string,fields:Partial<AuditGroup>)=>{let g=map.get(key);if(!g){g={key,...zero(),...fields};map.set(key,g);}return g;};
  const boundary=await j.visitHistory((e:Entry)=>{
    if(e.kind==="task.attempt")agentTasks.set(e.data.agent,e.data.id);
    if(e.kind==="agent.bound"&&e.data.workId)agentTasks.set(e.agent,e.data.workId);
    const base={seq:e.seq,at:e.ts,agent:e.agent,conversation:e.conversation,revision:e.revision};
    if(e.kind==="budget.reserved"&&!seen.has(e.data.id)){
      seen.add(e.data.id);const r=e.data.reservation,task=r.taskId??agentTasks.get(e.agent)??`unassigned:${e.conversation}:${e.revision}`;
      const row:AuditRow={...base,id:e.data.id,kind:"request",task,model:r.model??"unknown",provider:r.provider??"unknown",transport:r.transport??"unknown",billing:r.billingMode??"api",tokens:r.tokens,microUsd:r.microUsd,inputRate:r.inputRate,outputRate:r.outputRate,pricingKnown:r.pricingKnown===true,state:"pending"};
      const m=group(models,JSON.stringify([row.provider,row.model,row.transport,row.billing]),{model:row.model,provider:row.provider,transport:row.transport,billing:row.billing});
      const t=group(tasks,JSON.stringify([e.conversation,e.revision,task]),{conversation:e.conversation,revision:e.revision,task});
      for(const g of [totals,m,t]){g.requests++;g.tokens+=r.tokens;g.microUsd+=r.microUsd;g.pending++;if(row.billing!=="subscription"&&r.pricingKnown!==true)g.unpriced++;}
      pending.set(e.data.id,{row,model:m,task:t});remember({...row});
    }
    if(e.kind==="budget.settled"){
      const p=pending.get(e.data.id);if(!p)return;pending.delete(e.data.id);
      for(const g of [totals,p.model,p.task]){g.tokens+=e.data.tokens-p.row.tokens!;g.microUsd+=e.data.microUsd-p.row.microUsd!;g.pending--;if(e.data.uncertain)g.uncertain++;}
      remember({...p.row,...base,kind:"settlement",tokens:e.data.tokens,microUsd:e.data.microUsd,inputTokens:e.data.inputTokens,outputTokens:e.data.outputTokens,state:e.data.uncertain?"uncertain":"measured",...(e.data.stopReason?{reason:auditReason(e.data.stopReason)}:{})});
    }
    if(e.kind==="budget.floor"){
      for(const p of pending.values())for(const g of [totals,p.model,p.task]){g.pending--;g.uncertain++;}
      pending.clear();remember({...base,id:e.id,kind:"budget-floor",state:"retained",reason:"restored-spending-floor"});
    }
    if(e.kind==="model.request_failed"){
      remember({...base,id:e.id,kind:"request-failed",task:e.data.taskId??agentTasks.get(e.agent),model:e.data.model,provider:e.data.provider,transport:e.data.transport,billing:e.data.billing,state:"failed",reason:auditReason(e.data.reason),requestId:e.data.requestId});
    }
    if(e.kind==="usage.queried") {queryCount++;remember({...base,id:e.data.id,kind:"quota",provider:e.data.provider,state:e.data.state,reason:e.data.code,httpStatus:e.data.httpStatus});}
    if(e.kind==="task.state"&&e.data.patch?.status)remember({...base,id:e.id,kind:"task-state",task:e.data.id,state:e.data.patch.status,reason:auditReason(e.data.patch.reason)});
    if(e.kind==="requirement.changed")remember({...base,id:e.id,kind:"requirement",state:"changed",reason:"requirement-superseded"});
    if(e.kind==="session.recovered"||e.kind==="model.budget_resumed")remember({...base,id:e.id,kind:e.kind,state:"recorded",reason:e.kind==="session.recovered"?"interrupted":"explicit-user-resume"});
    if(e.kind==="runtime.event"&&["agent.done","agent.error","error","unit.handup"].includes(e.data.type))remember({...base,id:e.id,kind:e.data.type,task:agentTasks.get(e.agent),state:e.data.type==="agent.done"?(e.data.success?"reported-complete":"stopped"):"reported",reason:auditReason(`${e.data.code??""} ${e.data.reason??""} ${e.data.detail??""}`)});
  });
  // Old-backup restore can retain a spending floor without the later request
  // details. Expose that gap instead of inventing a model/task attribution.
  const floorGap={requests:Math.max(0,Math.max(boundary.budget?.used.requests??0,floor?.requests??0)-totals.requests),tokens:Math.max(0,Math.max(boundary.budget?.used.tokens??0,floor?.tokens??0)-totals.tokens),microUsd:Math.max(0,Math.max(boundary.budget?.used.microUsd??0,floor?.microUsd??0)-totals.microUsd)};
  return {version:1,...boundary,budget:undefined,totals,byModel:[...models.values()],byTask:[...tasks.values()],quotaQueries:queryCount,floorGap,rows:rows.reverse(),nextBefore:matched>limit?rows.at(-1)?.seq:undefined,note:"Totals cover retained request events across all models/tasks; filters and before apply only to detail rows. API USD is a configured estimate. Pending/unknown bills keep reservations; subscription USD is not a vendor invoice. Historical attribution may be unknown."};
}
export function formatAudit(report:Awaited<ReturnType<typeof auditReport>>) {
  const fmt=(g:AuditTotals)=>`${g.requests} 请求 / ${g.tokens} Token / $${(g.microUsd/1e6).toFixed(6)} API估算 / ${g.pending} 未结算 / ${g.uncertain} 不确定 / ${g.unpriced} 未定价`;
  return [`长期审计 · 截止 seq=${report.seq}`,fmt(report.totals),`额度查询 ${report.quotaQueries} 次；未归属账本差额 ${report.floorGap.requests} 请求 / ${report.floorGap.tokens} Token / $${(report.floorGap.microUsd/1e6).toFixed(6)}`,
    "按模型（累计）：",...report.byModel.map(g=>`${g.provider}/${g.model} · ${g.transport} · ${g.billing}：${fmt(g)}`),
    "按任务（累计，未分配任务的 PM/旧调用单独列出）：",...report.byTask.map(g=>`${g.conversation}@${g.revision}/${g.task}：${fmt(g)}`),
    "最近明细（UTC）：",...report.rows.map(r=>`#${r.seq} ${new Date(r.at).toISOString()} ${r.kind} ${r.agent} ${r.task??""} ${r.state} ${r.reason??""}${r.httpStatus?` HTTP ${r.httpStatus}`:""}${r.tokens===undefined?"":` ${r.tokens} Token / $${((r.microUsd??0)/1e6).toFixed(6)}`}${r.requestId?` request=${r.requestId}`:` id=${r.id}`}`),
    ...(report.nextBefore?[`更多：/audit before=${report.nextBefore}`]:[]),"总计含预留；价格是调用时配置估价。筛选仅作用于明细；--json 可查看价格和关联 ID。"].join("\n");
}
