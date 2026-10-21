import fs from 'node:fs';
import path from 'node:path';
import { validWorkEvent } from './Ingestion.js';
import { signalWorklog } from './RelayBridge.js';
import { readCapture, scopeFor, safeArtifact, cleanTitle } from './Config.js';
import { WorkStore, digest, type WorkEvent } from './Store.js';
interface Context {
    cwd: string;
    sessionManager: {
        getSessionId(): string;
        getLeafId(): string | undefined;
        getEntries(): any[];
    };
    ui?: {
        notify(text: string, kind?: string): void;
    };
}
/** Thin OmO Native extension. No chat messages, prompts, tool output or commands
 * are read. The independent SecretaryAgent process consumes the durable events. */
export default function install(api: any) {
    let config = readCapture();
    if (!config?.enabled)
        return;
    let store: WorkStore | undefined;
    const get = () => { if (store && store.directory !== config!.store) {
        store.close();
        store = undefined;
    } return store ??= new WorkStore(config!.store); };
    const capture = (ctx: Context, sourceId: string, title: string, kind: string, outcome: WorkEvent['outcome'], artifacts: string[] = []) => { const scope = scopeFor(config!, ctx.cwd); if (!scope)
        return; const s = get(); if (s.paused(config!.tenant, config!.employee))
        return; const session = ctx.sessionManager.getSessionId(), taskKey = 'omo-task:' + digest([config!.tenant, config!.employee, session]), declared = s.db.prepare('SELECT value FROM settings WHERE id=?').get(taskKey) as any; const task = declared ? JSON.parse(declared.value) : { id: 'omo:' + session, title: 'OmO 工作会话', revision: 0 }; const e: WorkEvent = { version: 1, id: digest(['omo', sourceId, 'omo:' + session, config!.tenant, config!.employee]), client: 'omo', tenant: config!.tenant, employee: config!.employee, project: scope.project, session: 'omo:' + session, sourceId, sourceSeq: ctx.sessionManager.getEntries().length, workId: task.id, revision: task.revision, at: Date.now(), kind, outcome, title: cleanTitle(task.title + ' · ' + title), artifacts, policy: 'workspace-v1' }; const existing = s.db.prepare('SELECT json FROM events WHERE id=?').get(e.id) as any; if (!existing) {
        api.appendEntry?.('worklog-event-v1', { root: digest(scope.root), relative: path.relative(scope.root, fs.realpathSync(ctx.cwd)), event: e });
        s.capture([e], undefined, !!config!.server);
    } signalWorklog(); };
    const guarded = (fn: (event: any, ctx: Context) => void) => (event: any, ctx: Context) => { try {
        config = readCapture();
        if (config && scopeFor(config, ctx.cwd))
            fn(event, ctx);
    }
    catch {
        ctx.ui?.notify('工作秘书采集失败；主会话可继续，运行 secretary status 检查。', 'warning');
    } };
    api.on('session_start', guarded((_event, ctx) => { const s = get(), scope = scopeFor(config!, ctx.cwd)!; for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== 'custom' || entry.customType !== 'worklog-event-v1')
            continue;
        const value = entry.data, e = value?.event;
        if (value?.root !== digest(scope.root) || typeof value.relative !== 'string' || !scopeFor(config!, path.resolve(scope.root, value.relative)) || !validWorkEvent(e) || e.tenant !== config!.tenant || e.employee !== config!.employee || e.project !== scope.project)
            continue;
        s.capture([e], undefined, !!config!.server);
    } }));
    api.on('tool_result', guarded((e, ctx) => { if (!['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash'].includes(e.toolName))
        return; const artifact = ['read', 'write', 'edit'].includes(e.toolName) ? safeArtifact(config!, ctx.cwd, e.input?.path) : undefined; if (['read', 'write', 'edit'].includes(e.toolName) && !artifact)
        return; capture(ctx, 'tool:' + e.toolCallId, e.toolName + (e.isError ? ' 未成功' : ' 已返回结果'), 'tool.activity', e.isError ? 'blocked' : 'progress', artifact ? [artifact] : []); }));
    api.on('agent_settled', guarded((_e, ctx) => capture(ctx, 'settled:' + ctx.sessionManager.getLeafId(), '会话本轮已停稳（未宣称验收）', 'session.settled', 'progress')));
    api.on('session_shutdown', () => { store?.close(); store = undefined; });
    api.registerCommand('worklog', { description: '工作秘书：status / pause / resume / task <共享任务ID> <工作标题>', handler: async (args: string, ctx: Context) => { config = readCapture(); if (!config || !scopeFor(config, ctx.cwd)) {
            ctx.ui?.notify('当前目录未登记为工作区；未采集内容。', 'info');
            return;
        } const s = get(), [command, ...rest] = args.trim().split(/\s+/); if (command === 'pause' || command === 'resume') {
            s.paused(config!.tenant, config!.employee, command === 'pause');
            ctx.ui?.notify(command === 'pause' ? '工作记录已暂停。' : '工作记录已恢复。', 'info');
            return;
        } if (command === 'task') {
            const [id, ...title] = rest;
            if (!id || !title.length || !/^[\w.:-]{1,128}$/.test(id))
                throw Error('Usage: /worklog task <id> <title>');
            const key = 'omo-task:' + digest([config!.tenant, config!.employee, ctx.sessionManager.getSessionId()]), old = s.db.prepare('SELECT value FROM settings WHERE id=?').get(key) as any, revision = (old ? JSON.parse(old.value).revision : 0) + 1;
            s.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, JSON.stringify({ id, title: cleanTitle(title.join(' ')), revision }));
            capture(ctx, 'task:' + revision, '登记工作事项', 'task.created', 'planned');
        } ctx.ui?.notify(`工作秘书 ${s.paused(config!.tenant, config!.employee) ? '已暂停' : '已开启'}；仅采集已登记目录的结构化工作事件，飞书发布由独立秘书进程负责。`, 'info'); } });
}
