import fs from 'node:fs';
import { SessionJournal, type Entry } from '../session/Journal.js';
import { readCapture, scopeFor, cleanTitle, type CaptureConfig } from './Config.js';
import { WorkStore, digest, type WorkEvent, type Outcome } from './Store.js';
export function relayEvent(config: CaptureConfig, workspace: string, e: Entry): WorkEvent | undefined {
    const scope = scopeFor(config, workspace);
    if (!scope)
        return;
    let title: string | undefined, workId = '', outcome: Outcome = 'progress';
    if (e.kind === 'requirement.changed') {
        title = e.data.inputKind === 'change' ? cleanTitle(e.data.text) : e.data.reason === 'user-interrupted' ? '工作执行已中断' : '工作目标版本更新（未采集问答正文）';
        workId = 'goal:' + e.conversation;
    }
    else if (e.kind === 'task.created') {
        title = cleanTitle(e.data.goal ?? e.data.task?.goal);
        workId = String(e.data.id ?? e.data.task?.id ?? '');
        outcome = 'planned';
    }
    else if (e.kind === 'task.state') {
        workId = String(e.data.id ?? '');
        const status = e.data.patch?.status;
        outcome = status === 'accepted' ? 'verified' : status === 'superseded' ? 'superseded' : ['blocked', 'exhausted', 'awaiting_review'].includes(status) ? 'blocked' : 'progress';
        title = '任务 ' + workId;
    }
    else
        return;
    if (!workId)
        return;
    return { version: 1, id: digest(['relay', e.id, digest(fs.realpathSync(workspace)) + ':' + e.conversation, config.tenant, config.employee]), client: 'relay', tenant: config.tenant, employee: config.employee, project: scope.project, session: digest(fs.realpathSync(workspace)) + ':' + e.conversation, sourceId: e.id, sourceSeq: e.seq, workId, revision: e.revision, at: e.ts, kind: e.kind === 'requirement.changed' ? 'goal.changed' : e.kind, outcome, title, artifacts: [], policy: 'workspace-v1' };
}
export async function collectRelay(workspace: string, config = readCapture(), backfill = false, startedAt = Date.now()) {
    if (!config || !scopeFor(config, workspace))
        return { captured: 0, filtered: true };
    const store = new WorkStore(config.store), key = digest(['relay-cursor', fs.realpathSync(workspace), config.tenant, config.employee]);
    try {
        const journal = new SessionJournal(workspace, { automatic: false, readOnly: true }), cursor = store.cursor(key);
        if (cursor && cursor.seq > journal.sequence().seq)
            throw Error('WORKLOG_SOURCE_RESTORED_BEHIND_CURSOR');
        let count = 0, batch: WorkEvent[] = [];
        let through = cursor?.seq ?? 0, lastHash = cursor?.hash ?? '';
        await journal.visitHistory(e => { through = e.seq; lastHash = e.hash; const event = !cursor && !backfill && e.ts < startedAt ? undefined : relayEvent(config, workspace, e); if (event) {
            batch.push(event);
            count++;
        } }, cursor ? { seq: cursor.seq, lastHash: cursor.hash } : undefined, (seq, hash) => { store.capture(batch, { id: key, seq, hash }, !!config.server); batch = []; through = seq; lastHash = hash; }, { prefetch: 4, streamArchives: true });
        if (batch.length)
            store.capture(batch, { id: key, seq: through, hash: lastHash }, !!config.server);
        return { captured: count, filtered: false };
    }
    finally {
        store.close();
    }
}
