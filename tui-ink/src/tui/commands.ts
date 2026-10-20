import {trustPriceTable,importPriceTable,revisePriceTable} from "../session/PriceImport.js";
import { cachedUsage, refreshUsage, type UsageProvider } from "../subscriptions/usage.js";
import { formatUsage, formatBudget, formatModelConfig } from "./accountStatus.js";
import { formatAudit, type AuditFilter } from "../session/Audit.js";
import {backgroundAuditReport as auditReport} from "../session/BackgroundAudit.js";
import {syncModelPrices,formatPriceStatus} from "../session/PriceSync.js";
import {recordPrice} from "../session/Pricing.js";
import { resolveModelRoute, type ModelProfile } from "../models/routing.js";
import { saveModelRouting } from "../config.js";
import { loadConfig as loadBillingConfig, saveModelConfig, validateBillingConfig } from "../config.js";
import { sessionJournal } from "../session/Journal.js";
import { listBackups } from "../session/Backup.js";
import { workItems } from "../session/Tasks.js";
import { taskMode, recordTaskCancellation } from "../runtime/TaskRecovery.js";
import { budgetReport, addSessionBudget } from "../session/Budget.js";
/**
 * commands.ts — the slash-command table, extracted from App() (spawn-1.0 M1-6e).
 * buildCommands(ctx) returns the CmdDef[]; cross-module deps are imported directly,
 * App-local state/handlers come in via ctx. Body kept verbatim. App-layer, no golden
 * coverage → smoke every command (docs/spawn-1.0/SMOKE-6e.md §2).
 */

import path from "node:path";
import fs from "node:fs";
import type { MutableRefObject } from "react";

import type { TuiEvent, LogLevel } from "../protocol.js";
import type { HttpConvAgent } from "../adapters/httpAgent.js";
import type { ProcessManager } from "../pm/ProcessManager.js";
import type { TaskScheduler } from "../runtime/TaskScheduler.js";
import type { SecretaryProxy } from "../memory/SecretaryProxy.js";
import type { LeaderOpts } from "../runtime/AgentRuntime.js";
import { EFFORT_LEVELS, type Effort, PALETTES } from "../ui.js";
import type { PaletteName } from "../config.js";
import { applyEvent, getState, selectAgent, setMinLevel, setTokenBudget, clearPendingRating, pruneAgents } from "../store.js";
import { savePalette, loadConfig, getAgentProviderConfig } from "../config.js";
import { loadMemory, loadMemoryByHash, listUnfinishedAgents, topFactsByWeight, loadSessions } from "../runtime/MemoryRuntime.js";
import { formatMetricsReport, getHealthMetricsStore } from "../runtime/ObservabilityRuntime.js";
import { logDiag } from "../runtime/ObservabilityRuntime.js";
import { replaceAgentForResume } from "../runtime/OrchestratorRuntime.js";
import { connectFeishu, isFeishuConnected, feishuSessionCount } from "../runtime/FeishuBridge.js";
import { runTestSuite } from "../runtime/DevHarness.js";
import { globalBus } from "../bus/Bus.js";
import { TestSuite } from "../tests/e2e/runner/TestSuite.js";
import { E2ESuite } from "../tests/e2e/runner/E2ESuite.js";

export interface CmdDef {
  name: string;
  desc: string;
  handler: (args: string[]) => void;
}

export interface CommandCtx {
  agents: Map<string, HttpConvAgent>;
  secretaries: Map<string, SecretaryProxy>;
  pm: ProcessManager;
  scheduledTasks: TaskScheduler;
  killedAgents: Set<string>;
  startLeaderAgent: (opts: LeaderOpts) => void;
  startWorker: (ev: Extract<TuiEvent, { type: "spawn" }>, opts?: { resumedMemoryId?: string; firstMessage?: string }) => void;
  pmStarted: MutableRefObject<boolean>;
  confirmEffort: (e: Effort) => void;
  requestExit: () => void;
  setEffortSelecting: (v: boolean) => void;
  setModelSelecting: (v: boolean) => void;
  setPaletteName: (name: PaletteName) => void;
  setZenMode: (fn: (v: boolean) => boolean) => void;
  setStatusMode: (fn: (v: boolean) => boolean) => void;
  showModelConfig: () => void;
  switchModelCommand: (role: string | undefined, modelName?: string) => void;
  registerModelCommand: (name: string | undefined, preset: string | undefined, modelOrKey: string | undefined, maybeApiKey: string | undefined) => void;
  showWebConfig: () => void;
  connectWebProviderCommand: (args: string[]) => void;
  switchWebProviderCommand: (name: string | undefined) => void;
  emitCommandMessage: (text: string) => void;
  startLogin?: () => void;
  setViewMode?:(mode:"agents"|"chat"|"logs")=>void;
  togglePlan?:()=>void;
}

function parseScheduleDelay(raw: string, now = Date.now()): number | null {
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? "ms").toLowerCase();
  const mult = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return now + Math.round(n * mult);
}

function fmtKIndex(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

export function buildCommands(ctx: CommandCtx): CmdDef[] {
  const {
    agents, secretaries, pm, scheduledTasks, killedAgents,
    startLeaderAgent, startWorker, pmStarted,
    confirmEffort, requestExit, setEffortSelecting, setModelSelecting,
    setPaletteName, setZenMode, setStatusMode,
    showModelConfig, switchModelCommand, registerModelCommand,
    showWebConfig, connectWebProviderCommand, switchWebProviderCommand,
    emitCommandMessage,
  } = ctx;
  const feishuConnected = isFeishuConnected();
  const feishuSessions = { size: feishuSessionCount() };
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const COMMANDS: CmdDef[] = [
    {name:"agents",desc:"/agents — Agent 列表（Ctrl+G）",handler:()=>ctx.setViewMode?.("agents")},
    {name:"chat",desc:"/chat — 返回会话",handler:()=>ctx.setViewMode?.("chat")},
    {name:"logs",desc:"/logs — 调试日志",handler:()=>ctx.setViewMode?.("logs")},
    {name:"plan",desc:"/plan — 展开或收起计划",handler:()=>ctx.togglePlan?.()},
    {name:"strategy",desc:"/strategy — 分工策略，独立于模型推理强度",handler:()=>setEffortSelecting(true)},
    {name:"login",desc:"/login — 选择供应商、订阅或 API Key，再配置模型和用途",handler:(args)=>{if(args.length){emitCommandMessage("请使用 /login 打开安全接入向导；不要把 API Key 写入命令参数。");return;}ctx.startLogin?.();}},
    { name: "pause",   desc: "kill the selected agent",     handler: () => { const sel = getState().selectedAgent; agents.get(sel)?.kill(); if (sessionJournal().binding(sel)?.parent) { killedAgents.add(sel); recordTaskCancellation(sel, "TUI pause"); } } },
    { name: "effort",  desc: "/effort [min|mid|high|max] — 旧分工策略命令；请使用 /strategy", handler: (args) => {
      const lvl = args[0] as Effort | undefined;
      if (lvl && (EFFORT_LEVELS as readonly string[]).includes(lvl)) {
        confirmEffort(lvl);
      } else {
        setEffortSelecting(true);
      }
    } },
    { name: "prune",   desc: "/prune [agentId] — hide done agents; with id: hide that subtree", handler: (args) => {
      const target = args[0];
      if (target) {
        // Validate: must exist and not be permanent
        const info = getState().agents.get(target);
        if (!info) {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `未找到 agent "${target}"` });
          return;
        }
        if (target === "pm" || target === "process-monitor") {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `pm 和 process-monitor 不能被 prune` });
          return;
        }
        const n = pruneAgents(target);
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `🧹 已隐藏 ${target} 及其 ${n - 1} 个子 agent（共 ${n} 个）` });
      } else {
        const n = pruneAgents();
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: n > 0 ? `🧹 已隐藏 ${n} 个已完成的 agent` : "没有可隐藏的已完成 agent" });
      }
    } },
    { name: "rate", desc: "/rate good|bad [comment] — rate the last completed session", handler: (args) => {
      const rating = getState().pendingRating;
      const verdict = args[0]?.toLowerCase();
      if (!verdict || (verdict !== "good" && verdict !== "bad")) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "用法：/rate good [说明]  或  /rate bad [说明]" });
        return;
      }
      const comment = args.slice(1).join(" ");
      const human = verdict === "good" ? 1 : -1;
      const agentId = rating?.agentId ?? "pm";
      const sessionHash = rating?.sessionHash ?? "?";
      logDiag(
        `[rating] ${agentId} session=${sessionHash} human=${human}` +
        (comment ? ` comment="${comment}"` : "") + "\n",
      );
      clearPendingRating();
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `评分已记录：${verdict === "good" ? "👍" : "👎"}${comment ? `  "${comment}"` : ""}` });
    } },
    { name: "usage", desc: "/usage [refresh|history] [claude|codex|copilot] [--json] — 套餐状态与查询原因", handler: (args) => {
      const provider=args.find(a=>["claude","codex","copilot"].includes(a)) as UsageProvider|undefined, refreshing=args.includes("refresh"), providers:UsageProvider[]=provider?[provider]:refreshing?["codex","copilot"]:["claude","codex","copilot"];
      if(args.some(a=>!["refresh","history","--json",provider].includes(a))||args.filter(a=>["claude","codex","copilot"].includes(a)).length>1){emitCommandMessage("用法 /usage [refresh|history] [claude|codex|copilot] [--json]");return;}
      const show=(values:ReturnType<typeof cachedUsage>[])=>args.includes("--json")?JSON.stringify(values,null,2):formatUsage(values,args.includes("history"));
      if(refreshing){emitCommandMessage("正在异步查询套餐用量，PM 沟通和任务执行继续。默认只刷新 Codex/Copilot；Claude 仅显式指定时查询。未知不等于零余额。");void Promise.all(providers.map(p=>refreshUsage(p,{force:true}))).then(values=>emitCommandMessage(show(values))).catch(()=>emitCommandMessage("套餐用量查询失败，已保留此前数据。使用 /usage history 查看已保存的原因。"));}
      else emitCommandMessage(show(providers.map(p=>cachedUsage(p))));
    } },
    { name: "account", desc: "/account — 离线查看模型配置、预算和套餐状态，不触发模型调用", handler: () => {
      emitCommandMessage([formatModelConfig(loadBillingConfig()),formatPriceStatus(Object.values(loadBillingConfig().models)),formatBudget(budgetReport(),sessionJournal().bindings()),formatUsage([cachedUsage("claude"),cachedUsage("codex"),cachedUsage("copilot")])].join("\n\n"));
    } },
    { name: "audit", desc: "/audit [model=ID task=ID before=序号 limit=40] [--json] [--rebuild] — 长期用量与停止原因审计", handler: (args) => {
      const filter:AuditFilter={};
      try{for(const arg of args){if(arg==="--json")continue;if(arg==="--rebuild"){filter.rebuild=true;continue;}const split=arg.indexOf("="),key=arg.slice(0,split),value=arg.slice(split+1);if(split<1||!value||!["model","task","before","limit"].includes(key))throw new Error("参数无效");if(key==="before"||key==="limit")filter[key]=Number(value);else filter[key as "model"|"task"]=value;}}
      catch{emitCommandMessage("用法 /audit [model=模型ID task=任务ID before=序号 limit=1..200] [--json]");return;}
      const budget=budgetReport();if("error" in budget){emitCommandMessage("预算账本不可读；审计前请检查账本完整性。");return;}
      emitCommandMessage("正在异步读取受保护历史，PM 沟通继续。费用是调用时的配置估价；查询不会调用模型。");
      void auditReport(process.cwd(),filter).then(report=>emitCommandMessage(args.includes("--json")?JSON.stringify(report,null,2):formatAudit(report))).catch(()=>emitCommandMessage("审计未完成：历史完整性、锁或筛选参数需要检查；不返回不完整的费用统计。"));
    } },
    { name: "route", desc: "/route [pm|leader|implement|research|review|verify|secretary <模型名...>|api-fallback on|off] — 定位与候选模型链", handler: (args) => {
      try {
        const cfg = loadBillingConfig(), profiles = ["pm","leader","implement","research","review","verify","secretary"];
        if (!args.length) { emitCommandMessage(JSON.stringify(cfg.routing ?? {profiles:{},allowApiFallback:false},null,2)); return; }
        if(args[0] === "api-fallback") { if(args.length!==2 || !["on","off"].includes(args[1]!)) throw new Error("用法 /route api-fallback on|off"); saveModelRouting({...cfg.routing,allowApiFallback:args[1]==="on"}); }
        else {
          const profile=args[0] as ModelProfile, names=args.slice(1); if(!profiles.includes(profile)||!names.length) throw new Error("用法 /route <定位> <注册模型名...>；使用 off 恢复角色默认模型");
          const routing={...cfg.routing,profiles:{...cfg.routing?.profiles}};
          if(names.length===1&&names[0]==="off") delete routing.profiles[profile];
          else { if(names.some(n=>!cfg.models[n])) throw new Error("候选链只能使用已注册模型名"); routing.profiles[profile]=names; resolveModelRoute({...cfg,routing},profile==="secretary"?"secretary":profile==="pm"||profile==="leader"?"leader":"worker",profile); }
          saveModelRouting(routing);
        }
        emitCommandMessage("模型路由已保存；新启动/恢复的 agent 生效，历史预算和任务副本保留。候选顺序决定优先级；订阅后的 API 默认不参与降级。");
      } catch(error) { emitCommandMessage(String(error)); }
    } },
    { name:"prices",desc:"/prices [sync|history|trust|import|revoke|replace|migrate] — 价格导入、撤销、替换与修订追溯",handler:args=>{
      if(args[0]==="revoke"||args[0]==="replace"||args[0]==="migrate"){
        const [action,target,...rest]=args,file=action!=="revoke"?rest.shift():undefined,flags=rest;
        if(!target||action!=="revoke"&&!file||flags.some(f=>f!=="--apply"&&!f.startsWith("reason=")&&!f.startsWith("expect="))||new Set(flags.map(f=>f.split("=")[0])).size!==flags.length){emitCommandMessage('用法 /prices revoke <批次摘要> reason="原因" [--apply] 或 /prices replace|migrate <批次摘要或行版本ID> "新价目表" reason="原因" [--apply] [expect=摘要]');return;}
        emitCommandMessage("正在后台校验价格修订；默认预览。历史调用快照保持不变，PM 沟通继续。");
        void revisePriceTable(process.cwd(),target,{file,migrate:action==="migrate",reason:flags.find(f=>f.startsWith("reason="))?.slice(7)??"",apply:flags.includes("--apply"),expect:flags.find(f=>f.startsWith("expect="))?.slice(7)}).then(result=>emitCommandMessage(JSON.stringify({...result,...("prices" in result?{prices:result.prices.slice(0,20),before:result.before.slice(0,20),displayLimit:20}:{})},null,2))).catch(e=>emitCommandMessage(/^PRICE_IMPORT_[A-Z_]+$/.test(e.message)?e.message:"PRICE_IMPORT_FILE_OR_HISTORY_ERROR"));return;
      }
      if(args[0]==="trust"||args[0]==="import"){
        const [action,file,...flags]=args;
        if(!file||flags.some(f=>action==="trust"?!f.startsWith("issuer="):!f.startsWith("expect=")&&f!=="--apply")||new Set(flags.map(f=>f.split("=")[0])).size!==flags.length){emitCommandMessage('用法 /prices trust "文件" issuer=来源机构 或 /prices import "文件" [--apply] [expect=预览摘要]');return;}
        emitCommandMessage("正在校验价目表；PM 沟通继续。默认仅预览，--apply 整批提交。");
        void Promise.resolve().then(async()=>action==="trust"?trustPriceTable(process.cwd(),file,flags.find(f=>f.startsWith("issuer="))?.slice(7)??""):importPriceTable(process.cwd(),file,{apply:flags.includes("--apply"),expect:flags.find(f=>f.startsWith("expect="))?.slice(7)})).then(result=>emitCommandMessage(JSON.stringify("prices" in result?{...result,prices:result.prices?.slice(0,20),note:"最多显示20条；CLI 可导出完整预览。"}:result,null,2))).catch(e=>emitCommandMessage(/^PRICE_IMPORT_[A-Z_]+$/.test(e.message)?`${e.message}${e.row?`（第 ${e.row} 条价格）`:""}`:"PRICE_IMPORT_FILE_OR_HISTORY_ERROR"));return;
      }
      if(args.length>1||args[0]&&!["sync","history"].includes(args[0])){emitCommandMessage("用法 /prices [sync|history]");return;}
      if(args[0]==="history"){
        emitCommandMessage("正在后台读取价格版本，PM 沟通继续。");void auditReport().then(r=>emitCommandMessage(JSON.stringify({revisions:r.priceRevisions.slice(-100),totalObservations:r.priceDefinitions.length,latest:r.priceDefinitions.slice(-100),note:"最近100条；完整版本随受保护历史保留，/audit --json 可导出。"},null,2))).catch(()=>emitCommandMessage("价格版本读取失败：请检查历史完整性或稍后重试。"));return;
      }
      const models=Object.values(loadBillingConfig().models);
      if(args[0]==="sync"){
        emitCommandMessage("正在异步同步官方价格；不发送 API Key、不调用推理接口。手工价格优先；代理端点不会套用官方价格。");
        void syncModelPrices(models,process.cwd(),{force:true}).then(()=>emitCommandMessage(formatPriceStatus(models))).catch(()=>emitCommandMessage("价格同步未完成，请检查 /prices 状态与持久记录。"));return;
      }
      emitCommandMessage(formatPriceStatus(models));
    }},
    { name: "price", desc: "/price <注册模型> <输入USD/M> <输出USD/M> source=来源 [since=ISO日期] [legacy] — 记录有来源的价格并补算历史", handler: (args) => {
      try {
        const [name,input,output,...options]=args,model=name&&loadBillingConfig().models[name];
        const source=options.find(v=>v.startsWith("source="))?.slice(7),date=options.find(v=>v.startsWith("since="))?.slice(6);
        if(!model||input===undefined||output===undefined||!source||options.some(v=>v!=="legacy"&&!v.startsWith("source=")&&!v.startsWith("since="))||(model.transport&&model.transport!=="http")||model.billing?.mode==="subscription")throw Error("用法 /price <API注册模型> <输入USD/M> <输出USD/M> source=来源标签 [since=ISO日期] [legacy]；省略日期表示明确补算全部历史；legacy 明确允许匹配旧记录中未知的端点。");
        const updated={...model,billing:{mode:"api" as const,inputUsdPerMillion:Number(input),outputUsdPerMillion:Number(output)}};
        validateBillingConfig(updated);
        const price=recordPrice(sessionJournal(),model,Number(input),Number(output),{source,since:date?Date.parse(date):0,legacy:options.includes("legacy")});
        saveModelConfig(name!,{...updated,billing:{...updated.billing,priceSource:price.source,priceRecordedAt:price.recordedAt}});
        emitCommandMessage(`价格来源 ${price.source} 已持久记录；/audit 显示后补估算。新启动/恢复的 agent 使用新价格。原账本、已用预算和不确定请求预留保持原值；缺实测用量不会编造费用。`);
      }catch(error){emitCommandMessage(String(error));}
    } },
    { name: "billing", desc: "/billing <modelName> <api|subscription> [inputUSD/M outputUSD/M] — 配置模型计费方式", handler: (args) => {
      try {
        const [name, mode, input, output] = args, model = name && loadBillingConfig().models[name];
        if (!model || !["api","subscription"].includes(mode ?? "") || args.length > 4 || (!!input !== !!output)) throw new Error("用法：/billing <已注册模型> <api|subscription> [输入美元/百万 输出美元/百万]");
        const updated = { ...model, billing: { mode: mode as "api" | "subscription", ...(input !== undefined ? {inputUsdPerMillion:Number(input),outputUsdPerMillion:Number(output)} : {}) } };
        validateBillingConfig(updated); saveModelConfig(name!, updated); emitCommandMessage(`模型 ${name} 计费模式为 ${mode}；下一次启动/恢复的 agent 使用新配置。不会重置已消费预算。`);
      } catch(error) { emitCommandMessage(String(error)); }
    } },
    { name: "budget", desc: "/budget [add requests=N tokens=N tools=N usd=N] — 离线查询或显式增加会话总额度", handler: (args) => {
      try {
        if (args[0] === "add") { const additions: Record<string, number> = {}; for (const arg of args.slice(1)) { const [key, value] = arg.split("="); if (!key || !["requests", "tokens", "tools", "usd"].includes(key) || value === undefined) throw new Error("用法：/budget add requests=20 tokens=100000 tools=40"); additions[key] = Number(value); } const j = sessionJournal(), agent = j.binding(getState().selectedAgent)?.conversation ?? j.bindings().find((b) => !b.parent)?.id ?? "pm"; addSessionBudget(agent, additions); }
        if(args[0] && args[0]!=="add" && !(args.length===1&&args[0]==="--json"))throw new Error("用法 /budget [--json] 或 /budget add requests=N tokens=N tools=N usd=N");
        emitCommandMessage(args.includes("--json")?JSON.stringify(budgetReport(),null,2):formatBudget(budgetReport(),sessionJournal().bindings()));
      } catch (error) { emitCommandMessage(String(error)); }
    } },
    { name: "tasks", desc: "/tasks [pause|resume] [taskId] — 查看任务预算或暂停/恢复后续自动续派", handler: (args) => {
      const j = sessionJournal(), selected = j.binding(getState().selectedAgent), owner = selected?.conversation ?? "pm";
      const tasks = workItems(j, owner).filter((t) => t.revision === j.current(owner)?.revision);
      if (args[0] === "pause" || args[0] === "resume") {
        try { for (const t of tasks.filter((t) => !args[1] || t.id === args[1])) taskMode(owner, t.id, args[0] === "pause" ? "manual" : "auto"); emitCommandMessage("后续自动续派策略已更新，正在运行的 Worker 继续执行；预算不重置。"); }
        catch (error) { emitCommandMessage(String(error)); }
      } else emitCommandMessage(tasks.map((t) => `${t.id} · ${t.profile} · ${t.status} · ${t.mode}\n尝试 ${t.attempts.length}/${t.maxAttempts}，轮数 ${t.usedTurns}/${t.maxTurns}，请求 ${t.usedRequests}/${t.maxRequests}，工具 ${t.usedTools}/${t.maxTools}\n${t.reason}`).join("\n\n") || "当前没有受管理的 Worker 任务。");
    } },
    { name: "backup", desc: "/backup [list] — 在线备份记忆或列出恢复点", handler: (args) => {
      if (args[0] && args[0] !== "list") { emitCommandMessage("用法：/backup 或 /backup list。恢复需退出程序后使用 npm run backup:session -- restore。"); return; }
      emitCommandMessage("备份操作已开始，期间可以继续与 PM 沟通。");
      const work = args[0] === "list" ? listBackups(process.cwd()).then((items) => items.map((m) => `${m.id} · seq=${m.seq} · ${new Date(m.createdAt).toLocaleString()}`).join("\n") || "尚无恢复点") : sessionJournal().backup().then((r) => `备份已校验：${r.id}\n位置：${r.directory}`);
      void work.then(emitCommandMessage).catch((e) => emitCommandMessage(`备份操作失败：${String(e)}`));
    } },
    { name: "storage", desc: "/storage [clean] — 查看配额或异步清理日志、重建索引", handler: (args) => {
      if (args[0] === "clean") {
        emitCommandMessage("存储维护已开始，期间可以继续与 PM 沟通。");
        void sessionJournal().maintain().then((r) => emitCommandMessage(`存储维护完成：日志 ${(r.logBytes / 1048576).toFixed(2)} MiB，受管理存储 ${(r.totalBytes / 1048576).toFixed(2)} MiB，整理 ${r.compactedSegments} 段。${r.overQuota ? "仍有配额压力：已保留受保护记忆和恢复状态。" : ""}${r.errors.length ? `\n${r.errors.join("\n")}` : ""}`)).catch((e) => emitCommandMessage(`存储维护失败，未确认安全的数据已保留：${String(e)}`));
      } else {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(process.cwd(), ".spawn/events/storage-status.json"), "utf8"));
          const mib = (n: number) => (Number(n ?? 0) / 1048576).toFixed(2);
          emitCommandMessage(`原始日志：${mib(s.logBytes)} / ${mib(s.policy.maxLogBytes)} MiB\n受管理存储：${mib(s.totalBytes)} / ${mib(s.policy.maxTotalBytes)} MiB\n检索索引：${mib(s.indexBytes)} / ${mib(s.policy.maxIndexBytes)} MiB\n最近维护：${new Date(s.updatedAt).toLocaleString()}\n${s.overQuota ? "仍超出配额，受保护记忆已保留。" : "配额正常。"}\n/storage clean 立即维护；期间可继续与 PM 沟通。`);
        }
        catch { emitCommandMessage("尚无维护报告；使用 /storage clean 运行维护。配额通过 SPAWN_LOG_MAX_BYTES / SPAWN_LOG_RETENTION_MS 等环境变量配置。"); }
      }
    } },
    { name: "sessions", desc: "列出所有未完成会话及 session hash", handler: () => {
      const sessions = listUnfinishedAgents();
      if (sessions.length === 0) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "✅ 无未完成会话" });
        return;
      }
      const lines = sessions.map((m) => {
        const id = m.session_hash ?? m.agent_id.slice(0, 7);
        const when = new Date(m.created_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        const goal = m.dispatch.background.slice(0, 55) || m.agent_id;
        return `[${id}] ${m.agent_id.slice(0, 20)} | ${goal} | ${when}`;
      }).join("\n");
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `📋 未完成会话 (${sessions.length}):\n${lines}\n\n/resume <agentId|hash> 恢复` });
    } },
    { name: "memory", desc: "/memory [agentId] — 查看 Secretary 记录的 facts / decisions / 子节点", handler: (args) => {
      const targetId = args[0] ?? getState().selectedAgent ?? "pm";
      const sec = secretaries.get(targetId);
      const mem = sec?.getMemory() ?? loadMemory(targetId);
      if (!mem) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `未找到 "${targetId}" 的 memory。可用 agent: ${[...secretaries.keys()].join(", ") || "无"}` });
        return;
      }
      const facts = topFactsByWeight(mem, 10);
      const decisions = mem.working_set.decisions.slice(-5);
      const children = mem.child_handles;
      const sessions = loadSessions(targetId);
      const sizeByes = JSON.stringify(mem).length;

      const logCursor = sec?.getLogCursor() ?? mem.tombstone.log_cursor ?? 0;
      const busStats = globalBus.logStats();
      const lines: string[] = [
        `── memory: ${targetId} (${(sizeByes / 1024).toFixed(1)} KB) ──`,
        `sessions: ${sessions.length}/${5}  |  facts: ${mem.working_set.facts.length}  |  decisions: ${mem.working_set.decisions.length}`,
        `log_cursor: ${logCursor}  |  bus_head: ${busStats.headOffset}  |  ring: ${busStats.size} (oldest offset: ${busStats.oldestOffset})`,
      ];
      if (facts.length > 0) {
        lines.push("\n【facts · top-10 by weight】");
        facts.forEach((f, i) => lines.push(`  ${i + 1}. [w=${f.weight ?? 1}] ${f.text.slice(0, 120)}`));
      } else {
        lines.push("\n【facts】(空)");
      }
      if (decisions.length > 0) {
        lines.push("\n【decisions · 最近 5 条】");
        decisions.forEach((d) => lines.push(`  · ${d.text.slice(0, 120)}`));
      }
      if (children.length > 0) {
        lines.push("\n【child_handles】");
        children.forEach((c) => lines.push(`  ${c.status === "running" ? "◐" : c.status === "done" ? "✓" : "✗"} ${c.agent_id.slice(0, 20)} — ${c.goal?.slice(0, 60) ?? ""}`));
      }
      if (mem.tombstone.compact_summary) {
        lines.push(`\n【tombstone】${mem.tombstone.compact_summary.slice(0, 200)}`);
      }
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: lines.join("\n") });
    } },
    { name: "fanout", desc: "/fanout [N] — 查看/设置最大并发子节点数 (1-16)", handler: (args) => {
      if (!args[0]) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `当前 maxFanout=${pm.getMaxFanout()}，用 /fanout <N> 修改（1-16）` });
        return;
      }
      const n = parseInt(args[0], 10);
      if (isNaN(n) || n < 1 || n > 16) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "maxFanout 必须在 1-16 之间" });
        return;
      }
      pm.setFanout(n);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `maxFanout 已更新为 ${n}` });
    } },
    { name: "schedule", desc: "/schedule <10s|5m|2h> <task> — schedule a PM task", handler: (args) => {
      const delay = args[0];
      const text = args.slice(1).join(" ").trim();
      if (!delay || !text) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "用法：/schedule <10s|5m|2h> <任务>，如 /schedule 10s 检查构建状态" });
        return;
      }
      const runAt = parseScheduleDelay(delay);
      if (runAt === null) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "时间格式支持：500ms / 10s / 5m / 2h" });
        return;
      }
      const ev = scheduledTasks.schedule({ conversationId: "tui:pm", text, runAt });
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `已安排 ${ev.task.id}：${new Date(runAt).toLocaleString()} 执行\n${text}` });
    } },
    { name: "metrics", desc: "/metrics [event_type|agentId] — 查看最近 HealthMetric", handler: (args) => {
      const filter = args[0]?.trim();
      const text = formatMetricsReport(getHealthMetricsStore().readMetrics(), filter);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text });
    } },
    { name: "tasks", desc: "/tasks [cancel <id>] — list or cancel scheduled tasks", handler: (args) => {
      if (args[0] === "cancel" && args[1]) {
        const ev = scheduledTasks.cancel(args[1]);
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: ev ? `已取消 ${ev.task.id}` : `无法取消 ${args[1]}（不存在或已结束）` });
        return;
      }
      const tasks = scheduledTasks.list();
      const active = tasks.filter((t) => t.state === "scheduled" || t.state === "running" || t.state === "waiting_user");
      const lines = active.map((t) =>
        `[${t.state}] ${t.id} @ ${new Date(t.runAt).toLocaleString()} — ${t.text.slice(0, 80)}`
      );
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: lines.length
          ? `计划任务：\n${lines.join("\n")}\n\n/tasks cancel <id> 取消`
          : "暂无计划任务。用 /schedule <10s|5m|2h> <task> 新建。" });
    } },
    { name: "resume",  desc: "/resume [agentId|hash] — resume from memory", handler: (args) => {
      const input = args[0] ?? "pm";
      const mem = loadMemory(input) ?? loadMemoryByHash(input);
      if (!mem) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `未找到 "${input}" 的记忆。输入 /sessions 查看可用会话。` });
        return;
      }
      const id = mem.agent_id;
      if (!sessionJournal().isCurrent(id)) {
        emitCommandMessage("该任务属于已失效的需求版本。请恢复 PM，按当前目标重新派发任务。");
        return;
      }
      replaceAgentForResume(id, { agents, secretaries, killedAgents });
      selectAgent(id);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `Resuming ${id} (hash: ${mem.session_hash ?? "?"}) from last checkpoint` });
      const isRootAgent = mem.agent_type === "PM" || id === "pm";
      if (isRootAgent) {
        const deadWorkers = listUnfinishedAgents()
          .filter((m) => m.parent_chain?.includes(id))
          .map((m) => m.agent_id)
          .filter((wid) => !agents.has(wid));
        const deadNote = deadWorkers.length > 0
          ? `\n\n⚠️ 以下 agent 在上次会话中存在，当前已不在线：${deadWorkers.join(", ")}。请重新 spawn 或调整计划。`
          : "";
        const hint = mem.tombstone.resume_hint ?? "上次会话中断";
        const lastTodoLines = (() => {
          try {
            return mem.tombstone.last_todo
              ? (JSON.parse(mem.tombstone.last_todo) as Array<{state: string; text: string}>)
                  .map((t) => `  [${t.state}] ${t.text}`).join("\n")
              : "  (无记录)";
          } catch { return "  (无法解析)"; }
        })();
        const resumeHint = [
          `[系统-恢复指令] 上次中断：${hint}${deadNote}`,
          ``,
          `上次 TODO 状态：`,
          lastTodoLines,
          ``,
          `**立刻输出 todo.set**，把上次已完成的项标为 done，把需要继续的项标为 todo/run，然后直接继续执行。不要等待确认，不要只说"收到"。`,
        ].join("\n");
        logDiag(`[resume] starting ${id} — firstMessage: "${resumeHint.slice(0, 200)}"\n`);
        pmStarted.current = false;
        startLeaderAgent({ id, firstMessage: resumeHint, resumedMemoryId: id, promptFile: isRootAgent ? "pm" : "leader" });
        pmStarted.current = true;
      } else if (mem.agent_type === "LEADER") {
        const parentId = mem.parent_chain[mem.parent_chain.length - 1] ?? "pm";
        const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
          v: 1, type: "spawn", parent: parentId, child: id,
          role: "Leader", goal: mem.dispatch.background, dispatch: mem.dispatch,
        };
        applyEvent(spawnEv);
        const hint = mem.tombstone.resume_hint ?? "上次 TL 会话中断";
        const resumeHint = [
          `[系统-恢复指令] 上次中断：${hint}`,
          `任务背景：${mem.dispatch.background}`,
          `请先输出 todo.set 恢复计划，然后继续推进。不要等待确认。`,
        ].join("\n");
        startLeaderAgent({
          id,
          parentId,
          goal: mem.dispatch.background,
          dispatch: mem.dispatch,
          resumedMemoryId: id,
          promptFile: "leader",
          firstMessage: resumeHint,
        });
      } else {
        const parentId = mem.parent_chain[mem.parent_chain.length - 1] ?? "pm";
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `Resuming worker ${id} (parent: ${parentId}, goal: ${mem.dispatch.background.slice(0, 80)})` });
        const spawnEv: Extract<TuiEvent, { type: "spawn" }> = {
          v: 1, type: "spawn", parent: parentId, child: id,
          role: mem.identity.role_name === "SECRETARY" ? "Secretary" : "Worker",
          goal: mem.dispatch.background, dispatch: mem.dispatch,
        };
        applyEvent(spawnEv);
        const hint = mem.tombstone.resume_hint ?? "上次 worker 会话中断";
        const resumeHint = [
          `[系统-恢复指令] 上次中断：${hint}`,
          `任务目标：${mem.dispatch.background}`,
          `请先输出 todo.set 恢复计划，然后继续执行未完成步骤。不要等待确认。`,
        ].join("\n");
        startWorker(spawnEv, { resumedMemoryId: id, firstMessage: resumeHint });
      }
    } },
    { name: "palette", desc: "切换配色 paper | green | amber", handler: (args) => { const name = args[0] as PaletteName; if (name && name in PALETTES) { setPaletteName(name); savePalette(name); } } },
    { name: "zen",     desc: "切换 Zen 模式（隐藏左右面板，只留中间文本方便复制）", handler: () => { setZenMode((v) => !v); } },
    { name: "status",  desc: "切换 Status 模式（只显示左侧 agents 状态面板）", handler: () => { setStatusMode((v) => !v); } },
    { name: "log",     desc: "日志级别 debug | info | warn | error", handler: (args) => { const l = args[0] as LogLevel; if (["debug","info","warn","error"].includes(l)) setMinLevel(l); } },
    { name: "feishu", desc: "/feishu <app_id> <app_secret> — 连接飞书 WebSocket（无参数显示状态）", handler: (args) => {
      const [appId, appSecret] = args;
      if (!appId || !appSecret) {
        const status = isFeishuConnected() ? "✅ 已连接" : "❌ 未连接";
        const sessions = feishuSessionCount();
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: `飞书状态: ${status}  活跃会话: ${sessions} 个\n用法: /feishu <app_id> <app_secret>` } as TuiEvent);
        return;
      }
      // Persist to .env for next startup
      const envPath = path.join(__dirname, "..", ".env");
      try {
        let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
        const set = (key: string, val: string) => {
          const re = new RegExp(`^${key}=.*$`, "m");
          return re.test(envContent) ? envContent.replace(re, `${key}=${val}`) : envContent + `\n${key}=${val}`;
        };
        envContent = set("FEISHU_APP_ID", appId);
        envContent = set("FEISHU_APP_SECRET", appSecret);
        fs.writeFileSync(envPath, envContent.trimStart(), "utf-8");
        process.env.FEISHU_APP_ID = appId;
        process.env.FEISHU_APP_SECRET = appSecret;
      } catch { /* non-fatal */ }
      connectFeishu(appId, appSecret);
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `飞书连接中... (${appId}) 凭证已保存到 .env` } as TuiEvent);
    } },
    { name: "model", desc: "/model [role name] — 查看/切换 leader|worker|secretary 使用的已注册模型", handler: (args) => {
      const [role, modelName] = args;
      if (!role) {
        setModelSelecting(true);
        return;
      }
      if (role === "show" || role === "status" || role === "ls") {
        showModelConfig();
        return;
      }
      switchModelCommand(role, modelName);
    } },
    { name: "connect", desc: "/connect <name> <preset|baseUrl> [modelId] <apiKey> — 注册/更新模型连接", handler: (args) => {
      if(args.length>4){emitCommandMessage("模型连接参数过多；订阅只需要名称、订阅类型和模型 ID。");return;}
      const [name, preset, modelOrKey, maybeApiKey] = args;
      registerModelCommand(name, preset, modelOrKey, maybeApiKey);
    } },
    { name: "web", desc: "/web show|provider <name>|connect <name> <serper|brave> <apiKey> [hl] [gl] — 配置 WebSearch", handler: (args) => {
      const [sub, ...rest] = args;
      if (!sub || sub === "show" || sub === "status" || sub === "ls") {
        showWebConfig();
        return;
      }
      if (sub === "connect") {
        connectWebProviderCommand(rest);
        return;
      }
      if (sub === "provider") {
        switchWebProviderCommand(rest[0]);
        return;
      }
      emitCommandMessage("用法: /web show | /web connect <name> <serper|brave> <apiKey> [hl] [gl] | /web provider <name>");
    } },
    { name: "alerts",  desc: "/alerts [ack <code>] — PM 告警面板", handler: (args) => {
      if (args[0] === "ack" && args[1]) { pm.ackAlert(args[1]); return; }
      const alerts = pm.getUnacked();
      if (alerts.length === 0) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "✅ 无未确认告警" });
        return;
      }
      const text = alerts.map((a) => `[${a.severity}] ${a.code} @ ${a.agent}: ${a.detail}`).join("\n");
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: `📊 告警 (${alerts.length} 条):\n${text}\n\n/alerts ack <code> 确认` });
    } },
    { name: "quit",    desc: "exit the TUI",                handler: () => requestExit() },
    { name: "contextbudget", desc: "/contextbudget [Nk|N|off] — set/clear token budget", handler: (args) => {
      const raw = args[0];
      if (!raw || raw === "off") {
        setTokenBudget(0);
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user", text: "💰 token 预算已清除" });
        return;
      }
      const lower = raw.toLowerCase();
      const multiplier = lower.endsWith("k") ? 1_000 : lower.endsWith("m") ? 1_000_000 : 1;
      const n = parseFloat(lower) * multiplier;
      if (isNaN(n) || n <= 0) {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "用法: /contextbudget 100k  /contextbudget 50000  /contextbudget off" });
        return;
      }
      setTokenBudget(Math.round(n));
      applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
        text: `💰 token 预算已设为 ${fmtKIndex(Math.round(n))} tokens（超过 80%/95% 时会警告）` });
    } },
    { name: "test", desc: "/test [headless|unit|full|e2e] — run test suite inside TUI", handler: (args) => {
      const suite = args[0] ?? "headless";
      if (suite === "full") {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "🧪 /test full 启动 — 结果在 test-monitor 面板" });
        new TestSuite().run().catch((e) => {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `⚠ TestSuite 崩溃: ${String(e)}` });
        });
      } else if (suite === "e2e") {
        applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
          text: "🧪 /test e2e 启动 — 结果在 e2e-monitor 面板" });
        new E2ESuite().run().catch((e) => {
          applyEvent({ v: 1, type: "message", agent: "pm", to: "user",
            text: `⚠ E2ESuite 崩溃: ${String(e)}` });
        });
      } else {
        runTestSuite(suite);
      }
    } },
  ];
  return COMMANDS;
}
