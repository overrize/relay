import { readCapture, scopeFor } from './Config.js';
import { WorkStore } from './Store.js';
import { signalWorklog } from './RelayBridge.js';
export function worklogCommand(command = 'status') { const config = readCapture(); if (!config || !scopeFor(config, process.cwd()))
    return '工作秘书未启用，或当前目录未登记；未采集内容。'; const s = new WorkStore(config.store); try {
    if (command === 'pause' || command === 'resume')
        s.paused(config.tenant, config.employee, command === 'pause');
    else if (command !== 'status' && command !== 'sync')
        throw Error('用法：/worklog status|pause|resume|sync');
    signalWorklog();
    const n = (s.db.prepare('SELECT count(*) AS n FROM events WHERE tenant=? AND employee=?').get(config.tenant, config.employee) as any).n;
    return `工作秘书 ${s.paused(config.tenant, config.employee) ? '已暂停' : '已启用'} · 工作事件 ${n} · ${config.server ? '独立服务上传' : '共用本地账本'} · 日报/周报在飞书查看和修改。`;
}
finally {
    s.close();
} }
