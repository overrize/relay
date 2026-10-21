import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkStore, digest, type Report } from './Store.js';
import { FeishuDocs, FeishuError, type CloudSnapshot } from './FeishuDocs.js';
import { cleanTitle, type PublishConfig } from './Config.js';
const safe = (s: string) => { const x = cleanTitle(s); return x === '工作事项（敏感字段已隐藏）' ? x : s.slice(0, 8000); };
export class WorkPublisher {
    readonly owner = `${hostname()}:${process.pid}:${randomUUID()}`;
    constructor(readonly store: WorkStore, readonly config: PublishConfig, readonly cloud = new FeishuDocs(config)) { }
    private title(id: string, audit = false) { return `[Worklog ${audit ? 'audit ' : ''}${id}]`; }
    private async document(id: string, folder: string, employee: string, leaders: string[], uncertain = false, audit = false, label = '') { const key = audit ? 'audit:' + id : id, stored = this.store.db.prepare('SELECT token FROM documents WHERE id=?').get(key) as any; if (stored)
        return stored.token as string; const title = this.title(id, audit), found = await this.cloud.find(folder, title); if (found.length > 1)
        throw new FeishuError('FEISHU_DUPLICATE_DOCUMENTS'); const intent = this.store.db.prepare('SELECT status FROM intents WHERE id=?').get(key); if (!found.length && (uncertain || intent))
        throw new FeishuError('FEISHU_CREATE_UNCERTAIN_MANUAL_RECONCILIATION', true); let token = found[0]; if (!token) {
        this.store.db.prepare("INSERT OR REPLACE INTO intents VALUES(?,'creating')").run(key);
        try {
            token = await this.cloud.create(folder, label + ' ' + title);
        }
        catch (e) {
            if (e instanceof FeishuError && !e.uncertain)
                this.store.db.prepare('DELETE FROM intents WHERE id=?').run(key);
            throw e;
        }
    } this.store.transaction(() => { this.store.db.prepare('INSERT OR REPLACE INTO documents(id,token) VALUES(?,?)').run(key, token); this.store.db.prepare('DELETE FROM intents WHERE id=?').run(key); this.store.audit('cloud-document', { report: id, document: token, audit }); }); await this.cloud.permissions(token, employee, leaders, audit); return token; }
    private saveSnapshot(id: string, document: string, s: CloudSnapshot) { const redacted = { ...s, title: s.title ? safe(s.title) : s.title, blocks: s.blocks.map(b => ({ ...b, text: safe(b.text) })) }; this.store.db.prepare('UPDATE documents SET snapshot=?,hash=?,revision=? WHERE id=? AND token=?').run(JSON.stringify(redacted), s.hash, s.revision, id, document); }
    async inspect(report: Report) { const row = this.store.db.prepare('SELECT * FROM documents WHERE id=?').get(report.id) as any; if (!row)
        return; const snapshot = await this.cloud.snapshot(row.token); if (row.hash && row.hash !== snapshot.hash) {
        const known = new Set<string>();
        for (const item of this.store.db.prepare('SELECT json FROM reports WHERE id=?').all(report.id) as any[]) {
            const r = JSON.parse(item.json) as Report;
            const body = r.body + '\n\n员工补充与修正：可直接编辑本文；新版本只追加，不覆盖人工内容。';
            for (let part = 0; part < body.length; part += 50000) {
                const text = body.slice(part, part + 50000);
                for (let at = 0; at < text.length; at += 1800)
                    known.add(text.slice(at, at + 1800));
            }
        }
        const markers = new Set((this.store.db.prepare('SELECT id FROM outbox WHERE report=?').all(report.id) as any[]).map(r => r.id));
        const ownMarker = (text: string) => { const m = /^\[WORKLOG GENERATION ([a-f0-9]{64}) PART \d+\/\d+\]$/.exec(text); return m && markers.has(m[1]); };
        const previous = JSON.parse(row.snapshot) as CloudSnapshot, before = new Map(previous.blocks.map(b => [b.id, b.text])), after = new Map(snapshot.blocks.map(b => [b.id, b.text])), edits: string[] = [];
        if (previous.title !== snapshot.title)
            edits.push('修改标题：' + safe(snapshot.title ?? ''));
        for (const b of snapshot.blocks)
            if (before.get(b.id) !== b.text && (before.has(b.id) || !known.has(b.text) && !ownMarker(b.text)))
                edits.push(safe(b.text));
        for (const b of previous.blocks)
            if (!after.has(b.id))
                edits.push('删除段落：' + safe(b.text));
        if (edits.length)
            this.store.revision(report.id, 'unknown-feishu-editor', 'employee-edit', { document: row.token, fromRevision: row.revision, toRevision: snapshot.revision, beforeHash: row.hash, afterHash: snapshot.hash, edits, changes: [...new Set([...before.keys(), ...after.keys()])].filter(id => before.get(id) !== after.get(id)).map(id => ({ id, before: before.has(id) ? safe(before.get(id)!) : null, after: after.has(id) ? safe(after.get(id)!) : null })), note: '仅能确认同步间隔内变化；逐次操作和编辑者未知' });
    } this.saveSnapshot(report.id, row.token, snapshot); return snapshot; }
    private async appendParts(id: string, document: string, marker: string, text: string) { const parts: string[] = []; for (let i = 0; i < text.length; i += 50000)
        parts.push(text.slice(i, i + 50000)); if (!parts.length)
        parts.push(''); for (let i = 0; i < parts.length; i++) {
        if (!this.store.lease('publisher:' + this.config.tenant, this.owner))
            throw new FeishuError('WORKLOG_PUBLISH_LEASE_LOST');
        const tag = `[WORKLOG ${marker} PART ${i + 1}/${parts.length}]`, snap = await this.cloud.snapshot(document);
        if (snap.blocks.some(b => b.text === tag)) {
            this.saveSnapshot(id, document, snap);
            continue;
        }
        await this.cloud.append(document, snap.revision, tag, parts[i]!);
        if (id.startsWith('audit:'))
            this.saveSnapshot(id, document, await this.cloud.snapshot(document));
        else
            await this.inspect(this.store.latest(id)!);
    } }
    async audit(report: Report) { const employee = this.config.employees.find(e => e.id === report.employee)!; const entries: {
        id: string;
        hash: string;
        text: string;
    }[] = []; for (const row of this.store.db.prepare('SELECT version,json,hash FROM reports WHERE id=? ORDER BY version').all(report.id) as any[]) {
        if (digest(JSON.parse(row.json)) !== row.hash)
            throw Error('WORKLOG_REPORT_INTEGRITY');
        const generation = JSON.parse(row.json) as Report, sourceEvidence = [];
        for (const [id, expected] of generation.basis?.events ?? []) {
            const source = this.store.db.prepare('SELECT json,hash FROM events WHERE id=? AND tenant=? AND employee=?').get(id, generation.tenant, generation.employee) as any;
            if (!source || source.hash !== expected || digest(JSON.parse(source.json)) !== expected)
                throw Error('WORKLOG_SOURCE_EVIDENCE_INTEGRITY');
            sourceEvidence.push({ event: JSON.parse(source.json), hash: source.hash });
        }
        entries.push({ id: digest([report.id, 'generation', row.version]), hash: row.hash, text: JSON.stringify({ generation, sourceEvidence, hash: row.hash }, null, 2) });
    } for (const row of this.store.db.prepare('SELECT id,actor,kind,at,json,hash FROM revisions WHERE report=? ORDER BY at,id').all(report.id) as any[]) {
        if (digest(JSON.parse(row.json)) !== row.hash)
            throw Error('WORKLOG_REVISION_INTEGRITY');
        entries.push({ id: row.id, hash: row.hash, text: JSON.stringify({ revision: { ...row, value: JSON.parse(row.json), json: undefined } }, null, 2) });
    } const pending = entries.filter(entry => { const saved = this.store.db.prepare('SELECT value FROM settings WHERE id=?').get('cloud-audit:' + entry.id) as any; if (saved && saved.value !== entry.hash)
        throw Error('WORKLOG_AUDIT_ENTRY_CHANGED'); return !saved; }); if (!pending.length)
        return; const document = await this.document(report.id, this.config.auditFolder, employee.openId, employee.leaders, false, true, `修订与生成依据 ${report.employee} ${report.start}`); await this.cloud.permissions(document, employee.openId, employee.leaders, true); for (const entry of pending) {
        await this.appendParts('audit:' + report.id, document, 'AUDIT ENTRY ' + entry.id, entry.text);
        this.store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run('cloud-audit:' + entry.id, entry.hash);
    } }
    async publish() {
        if (!this.store.lease('publisher:' + this.config.tenant, this.owner))
            return { busy: true, published: 0 };
        let published = 0;
        try {
            const jobs = this.store.db.prepare("SELECT * FROM outbox WHERE status IN ('pending','retry','uncertain') AND next_at<=? ORDER BY rowid LIMIT 10").all(Date.now()) as any[];
            for (const job of jobs) {
                const report = this.store.report(job.report, job.version);
                if (report.tenant !== this.config.tenant)
                    continue;
                if (report.version < this.store.latest(report.id)!.version) {
                    this.store.db.prepare("UPDATE outbox SET status='superseded',reason='newer-report-version' WHERE id=?").run(job.id);
                    continue;
                }
                const employee = this.config.employees.find(e => e.id === report.employee);
                if (!employee)
                    continue;
                if (job.attempts >= 6) {
                    this.store.db.prepare("UPDATE outbox SET status='manual',reason='WORKLOG_RETRY_BUDGET' WHERE id=?").run(job.id);
                    continue;
                }
                this.store.db.prepare('UPDATE outbox SET attempts=attempts+1 WHERE id=?').run(job.id);
                try {
                    await this.cloud.folderMembers(employee.folder, [employee.openId, ...employee.leaders]);
                    await this.cloud.folderMembers(this.config.auditFolder, []);
                    const document = await this.document(report.id, employee.folder, employee.openId, employee.leaders, job.status === 'uncertain', false, `${report.kind === 'daily' ? '日报' : '周报'} ${report.employee} ${report.start}`);
                    await this.cloud.permissions(document, employee.openId, employee.leaders);
                    await this.inspect(report);
                    await this.appendParts(report.id, document, `GENERATION ${job.id}`, `${report.body}\n\n员工补充与修正：可直接编辑本文；新版本只追加，不覆盖人工内容。`);
                    await this.audit(report);
                    this.store.transaction(() => { this.store.db.prepare("UPDATE outbox SET status='complete',reason=NULL,document=? WHERE id=?").run(document, job.id); this.store.audit('published', { report: report.id, version: report.version, document }); });
                    published++;
                }
                catch (e) {
                    const reason = e instanceof FeishuError ? e.reason : /WORKLOG_[A-Z_]+/.exec(String(e))?.[0] ?? 'WORKLOG_PUBLISH_FAILED', uncertain = e instanceof FeishuError && e.uncertain;
                    this.store.transaction(() => { this.store.db.prepare('UPDATE outbox SET status=?,reason=?,next_at=? WHERE id=?').run(uncertain ? 'uncertain' : 'retry', reason, Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts), job.id); this.store.audit('publish-failed', { report: report.id, version: report.version, reason, uncertain }); });
                }
            }
            return { busy: false, published };
        }
        finally {
            this.store.release('publisher:' + this.config.tenant, this.owner);
        }
    }
    async syncEdits() { if (!this.store.lease('publisher:' + this.config.tenant, this.owner))
        return; try {
        const key = 'edit-scan:' + this.config.tenant, cursor = (this.store.db.prepare('SELECT value FROM settings WHERE id=?').get(key) as any)?.value ?? '';
        let rows = this.store.db.prepare("SELECT id FROM documents WHERE id NOT LIKE 'audit:%' AND id>? ORDER BY id LIMIT 10").all(cursor) as any[];
        if (!rows.length && cursor)
            rows = this.store.db.prepare("SELECT id FROM documents WHERE id NOT LIKE 'audit:%' ORDER BY id LIMIT 10").all() as any[];
        for (const row of rows) {
            const report = this.store.latest(row.id);
            if (report?.tenant === this.config.tenant && this.config.employees.some(e => e.id === report.employee)) {
                this.store.lease('publisher:' + this.config.tenant, this.owner);
                await this.inspect(report);
                await this.audit(report);
            }
            this.store.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key, row.id);
        }
    }
    finally {
        this.store.release('publisher:' + this.config.tenant, this.owner);
    } }
    async reconcile(reportId: string, reason: string, document?: string, confirmAbsent = false, audit = false) { if (!reason.trim() || !document && !confirmAbsent)
        throw Error('WORKLOG_RECONCILIATION_REVIEW_REQUIRED'); const report = this.store.latest(reportId); if (report?.tenant !== this.config.tenant)
        throw Error('WORKLOG_REPORT_NOT_FOUND'); const employee = this.config.employees.find(e => e.id === report.employee); if (!employee)
        throw Error('WORKLOG_EMPLOYEE_NOT_CONFIGURED'); if (!this.store.lease('publisher:' + this.config.tenant, this.owner))
        throw Error('WORKLOG_PUBLISH_BUSY'); try {
        const key = audit ? 'audit:' + reportId : reportId, found = await this.cloud.find(audit ? this.config.auditFolder : employee.folder, this.title(reportId, audit));
        if (document && !found.includes(document) || !document && found.length)
            throw Error('WORKLOG_RECONCILIATION_DOCUMENT_MISMATCH');
        this.store.transaction(() => { if (document)
            this.store.db.prepare('INSERT OR REPLACE INTO documents(id,token) VALUES(?,?)').run(key, document); this.store.db.prepare('DELETE FROM intents WHERE id=?').run(key); this.store.db.prepare("UPDATE outbox SET status='retry',attempts=0,next_at=0 WHERE report=? AND status IN ('manual','uncertain','retry')").run(reportId); this.store.audit('manual-reconciliation', { report: reportId, audit, document: document ?? null, confirmedAbsent: !document, reason: cleanTitle(reason) }); });
    }
    finally {
        this.store.release('publisher:' + this.config.tenant, this.owner);
    } }
    retry(job: string, reason: string) { if (!reason.trim())
        throw Error('WORKLOG_RETRY_REASON_REQUIRED'); this.store.transaction(() => { const row = this.store.db.prepare('SELECT report,status FROM outbox WHERE id=?').get(job) as any; if (!row || this.store.latest(row.report)?.tenant !== this.config.tenant)
        throw Error('WORKLOG_JOB_NOT_FOUND'); this.store.db.prepare("UPDATE outbox SET attempts=0,next_at=0,status=CASE WHEN status='uncertain' THEN 'uncertain' ELSE 'retry' END WHERE id=?").run(job); this.store.audit('manual-retry', { job, reason: cleanTitle(reason) }); }); }
}
