import type {SessionController} from '../../runtime/SessionController.js';
import type {AuditFilter,auditReport} from '../../session/Audit.js';
type Snapshot=ReturnType<SessionController['snapshot']>;
export function readableHistory(text:string){
 return text.split('\n').map(line=>{try{const e=JSON.parse(line);if(e.type==='message'||e.type==='step')return String(e.text??'');if(e.type==='spawn')return `派发 ${e.child} · ${e.role}：${e.goal}`;if(e.type==='tool.call')return `工具 ${e.name}：${JSON.stringify(e.args)}`;if(e.type==='todo.set')return `任务清单：${(e.items??[]).map((i:any)=>`${i.state} ${i.text}`).join('；')}`;if(e.type==='agent.done')return `执行结束：${e.reason??e.success}`;}catch{/* Plain model text is displayed verbatim. */}return line;}).join('\n');
}
export function parseAuditFilter(args=''):AuditFilter{
 const filter:AuditFilter={limit:40};for(const token of args.split(/\s+/).filter(Boolean)){
  const match=/^(model|task|before|limit)=(.+)$/.exec(token);if(!match)throw Error('用法：/audit [model=ID task=ID before=序号 limit=1..200]');
  const [,key,value]=match;if(key==='model'||key==='task')filter[key]=value;else{const n=Number(value);if(!Number.isSafeInteger(n)||n<1||(key==='limit'&&n>200))throw Error('审计游标或数量无效');if(key==='before')filter.before=n;else filter.limit=n;}
 }return filter;
}
export function taskPanel(s:Snapshot,index=0){
 const tasks=s.tasks,task=tasks[Math.min(index,Math.max(0,tasks.length-1))];
 return [`任务面板 · 目标 v${s.revision} · ${tasks.length} 项`,`当前目标：${s.goal||'尚无任务'}`,...s.agents.map(a=>`Agent ${a.id} · ${a.activity} · ${a.model??''}`),
  ...(task?[`\n选中 ${task.id} · v${task.revision} · ${task.profile} · ${task.status}`,`目标：${task.goal}`,`停止/等待原因：${task.reason||'尚无停止原因'}`,`执行 ${task.latestAgent} · 已尝试 ${task.attempts.length}/${task.maxAttempts}`,`请求 ${task.usedRequests}/${task.maxRequests} · 工具 ${task.usedTools}/${task.maxTools} · 轮次 ${task.usedTurns}/${task.maxTurns}`,`验收：${task.verdict?`${task.verdict.passed?'通过':'未通过'} · ${task.verdict.details.join('；')}`:'尚未验收'}`,`操作记录：${Object.values(task.operations).map(o=>`${o.agent}/${o.name} ${o.status}${o.ok===false?' 失败':''}`).join('；')||'无'}`]:['\n尚无 Worker 任务；PM 可直接执行。']),
  '\n任务列表：',...tasks.map((t,i)=>`${i===index?'→':' '} ${t.id} · v${t.revision} · ${t.latestAgent} · ${t.status} · ${t.goal.slice(0,160)}`)].join('\n');
}
export function budgetPanel(s:Snapshot){
 const b=s.budget;if(!('used' in b))return `预算面板\n${'error' in b?b.error:b.note}`;
 const used=b.used,limits=b.limits;
 return ['会话统一预算 · 累计使用（包含未结算预留）',...(['requests','tools','tokens'] as const).map(k=>`${k}：${used[k]} / ${limits[k]} · 剩余 ${Math.max(0,limits[k]-used[k])}`),
 `已配置金额预算：${limits.microUsd>0?'$'+(limits.microUsd/1e6).toFixed(6):'未设置金额上限；仍受请求/工具/Token 预算限制'}`,
 `调用时 API 费用估算：$${(used.microUsd/1e6).toFixed(6)}${b.unpricedApiRequests?' + 未知费用':''}`,
 `调用时未定价：${b.unpricedApiRequests} · 未结算/不确定：${b.pendingOrUncertain}`,
 ...(['api','subscription'] as const).map(mode=>`${mode}：${b.byBilling?.[mode].requests??0} 请求 / ${b.byBilling?.[mode].tokens??0} Token${mode==='subscription'?' · 套餐余额需厂商查询，不能据此推算剩余额度':''}`),
 '\n停止/限制记录：',...s.tasks.filter(t=>t.status!=='running').map(t=>`${t.latestAgent} · ${t.status} · ${t.reason||'无原因'}`),
 'API 金额是估算而非账单；未知费用不等于免费。预算按工作区持久累计，重启与切换目标不重置。'].join('\n');
}
export function auditPanel(report:Awaited<ReturnType<typeof auditReport>>,index=0){
 const t=report.totals,row=report.rows[Math.min(index,Math.max(0,report.rows.length-1))];
 return [`长期审计 · 截止 #${report.seq}`,`${t.requests} 请求 · ${t.tokens} Token · $${(t.microUsd/1e6).toFixed(6)} 已配置估算${t.unpriced?' + 未知费用':''}`,`未定价 ${t.unpriced} · 待结算 ${t.pending} · 不确定 ${t.uncertain}`,`后补估算 $${(report.pricing.microUsd/1e6).toFixed(6)}；仍缺价 ${report.pricing.unresolved}，未实测 ${report.pricing.unmeasured}；不改写历史费用快照。`,
 '\n按模型累计：',...report.byModel.map(g=>`${g.provider}/${g.model} · ${g.billing} · ${g.requests} 请求 / ${g.tokens} Token / $${(g.microUsd/1e6).toFixed(6)}${g.unpriced?' + 未知':''}`),
 '\n按任务累计：',...report.byTask.map(g=>`${g.conversation}@${g.revision}/${g.task} · ${g.requests} 请求 / ${g.tokens} Token`),
 ...(row?[`\n选中 #${row.seq} · ${row.kind} · ${row.state}`,`模型 ${row.model??'未知'} · 任务 ${row.task??'未归属'} · v${row.revision}`,`原因 ${row.reason??'无'}${row.httpStatus?` · HTTP ${row.httpStatus}`:''}`,`关联 ${row.requestId??row.id} · ${new Date(row.at).toISOString()}`]:['\n暂无明细']),
 '\n当前页明细：',...report.rows.map((r,i)=>`${i===index?'→':' '} #${r.seq} ${r.agent} · ${r.model??''} · ${r.state} · ${r.reason??''}`),
 report.nextBefore?`还有更早明细：加载更多（before=${report.nextBefore}）`:'已到明细末尾',
 `索引 ${report.index.mode} · 本次访问 ${report.index.visited} 事件；筛选只作用于明细，累计统计仍覆盖全部保留调用。`].join('\n');
}
