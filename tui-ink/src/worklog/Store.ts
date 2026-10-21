import { hostname } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
export const digest = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
export type Outcome = 'planned' | 'progress' | 'verified' | 'blocked' | 'superseded';
export interface WorkEvent {
    version: 1;
    id: string;
    client: 'relay' | 'omo';
    tenant: string;
    employee: string;
    project: string;
    session: string;
    sourceId: string;
    sourceSeq: number;
    workId: string;
    revision: number;
    at: number;
    kind: string;
    outcome: Outcome;
    title: string;
    artifacts: string[];
    policy: 'workspace-v1';
}
export interface Report {
    id: string;
    tenant: string;
    employee: string;
    kind: 'daily' | 'weekly';
    start: string;
    end: string;
    version: number;
    inputHash: string;
    events: string[];
    body: string;
    model: string;
    rules: 'work-report-v1';
    basis?: {
        rules: string;
        model: string;
        timeZone: string;
        events: [
            string,
            string
        ][];
        revisions: [
            string,
            string
        ][];
        generator?: {
            version: string;
            codeDigest: string;
            promptDigest: string;
            routeDigest: string;
        };
    };
    generation?: {
        requestId?: string;
        inputTokens?: number;
        outputTokens?: number;
        cost: 'unknown' | 'no-model-request';
    };
    createdAt: number;
    document?: string;
}
export class WorkStore {
    readonly db: DatabaseSync;
    constructor(readonly directory: string) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const file = path.join(directory, 'worklog.sqlite');
        this.db = new DatabaseSync(file);
        this.db.exec(`PRAGMA busy_timeout=200; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS identity(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);INSERT OR IGNORE INTO identity VALUES(1,'${randomUUID()}');
 CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,employee TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL);CREATE INDEX IF NOT EXISTS event_scope ON events(tenant,employee,at);
 CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',next_at INTEGER NOT NULL DEFAULT 0,reason TEXT);
 CREATE INDEX IF NOT EXISTS event_work ON events(tenant,employee,json_extract(json,'$.project'),json_extract(json,'$.workId'),json_extract(json,'$.revision'),json_extract(json,'$.kind'),at);
 CREATE INDEX IF NOT EXISTS event_goals ON events(tenant,employee,json_extract(json,'$.kind'),json_extract(json,'$.session'),json_extract(json,'$.revision'),at);
 CREATE TABLE IF NOT EXISTS dirty_events(id TEXT PRIMARY KEY,tenant TEXT NOT NULL,employee TEXT NOT NULL,at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS periods(tenant TEXT,employee TEXT,kind TEXT,day TEXT,pending INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(tenant,employee,kind,day));
 CREATE TABLE IF NOT EXISTS cursors(id TEXT PRIMARY KEY,seq INTEGER NOT NULL,hash TEXT NOT NULL);CREATE TABLE IF NOT EXISTS privacy(tenant TEXT,employee TEXT,start INTEGER,end INTEGER,PRIMARY KEY(tenant,employee,start));
 CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS reports(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,version));
 CREATE TABLE IF NOT EXISTS revisions(id TEXT PRIMARY KEY,report TEXT NOT NULL,actor TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,json TEXT NOT NULL,hash TEXT NOT NULL);CREATE INDEX IF NOT EXISTS revision_report ON revisions(report,at);
 CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,report TEXT NOT NULL,version INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'pending',next_at INTEGER NOT NULL DEFAULT 0,reason TEXT,document TEXT,before_hash TEXT,after_hash TEXT);
 CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,token TEXT NOT NULL,snapshot TEXT,hash TEXT,revision INTEGER);
 CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,status TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY,owner TEXT NOT NULL,until_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS model_budget(day TEXT PRIMARY KEY,used INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS audit_root(id INTEGER PRIMARY KEY CHECK(id=1),hash TEXT NOT NULL);INSERT OR IGNORE INTO audit_root VALUES(1,'');CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,json TEXT NOT NULL,previous TEXT NOT NULL,hash TEXT NOT NULL);`);
        if (!this.db.prepare("SELECT 1 FROM settings WHERE id='schema:dirty-initialized'").get())
            this.transaction(() => { this.db.exec('INSERT OR IGNORE INTO dirty_events SELECT id,tenant,employee,at FROM events'); this.db.prepare("INSERT OR IGNORE INTO settings VALUES('schema:dirty-initialized','1')").run(); });
        if (process.platform !== 'win32')
            fs.chmodSync(file, 0o600);
    }
    close() { this.db.close(); }
    transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try {
        const v = fn();
        this.db.exec('COMMIT');
        return v;
    }
    catch (e) {
        this.db.exec('ROLLBACK');
        throw e;
    } }
    instance() { return (this.db.prepare('SELECT value FROM identity WHERE id=1').get() as any).value as string; }
    paused(tenant: string, employee: string, value?: boolean) { const id = `pause:${tenant}:${employee}`, start = id + ':start', old = (this.db.prepare('SELECT value FROM settings WHERE id=?').get(id) as any)?.value === 'true'; if (value !== undefined && old !== value)
        this.transaction(() => { if (value)
            this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(start, String(Date.now()));
        else {
            const from = Number((this.db.prepare('SELECT value FROM settings WHERE id=?').get(start) as any)?.value ?? 0);
            this.db.prepare('INSERT OR REPLACE INTO privacy VALUES(?,?,?,?)').run(tenant, employee, from, Date.now());
        } this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(id, String(value)); }); return value ?? old; }
    cursor(id: string) { return this.db.prepare('SELECT seq,hash FROM cursors WHERE id=?').get(id) as {
        seq: number;
        hash: string;
    } | undefined; }
    capture(events: WorkEvent[], cursor?: {
        id: string;
        seq: number;
        hash: string;
    }, enqueue = false) { this.transaction(() => { for (const e of events) {
        if (this.paused(e.tenant, e.employee) || this.db.prepare('SELECT 1 FROM privacy WHERE tenant=? AND employee=? AND start<=? AND end>=?').get(e.tenant, e.employee, e.at, e.at))
            continue;
        const old = this.db.prepare('SELECT hash FROM events WHERE id=?').get(e.id) as any;
        if (old && old.hash !== digest(e))
            throw Error('WORKLOG_EVENT_ID_CONFLICT');
        const inserted = this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?)').run(e.id, e.tenant, e.employee, e.at, JSON.stringify(e), digest(e));
        if (inserted.changes)
            this.db.prepare('INSERT OR IGNORE INTO dirty_events VALUES(?,?,?,?)').run(e.id, e.tenant, e.employee, e.at);
        if (enqueue)
            this.db.prepare('INSERT OR IGNORE INTO deliveries(id) VALUES(?)').run(e.id);
    } if (cursor)
        this.db.prepare('INSERT OR REPLACE INTO cursors VALUES(?,?,?)').run(cursor.id, cursor.seq, cursor.hash); }); }
    events(tenant: string, employee: string, before: number, after = 0) { return (this.db.prepare('SELECT json,hash FROM events WHERE tenant=? AND employee=? AND at<? AND at>=? ORDER BY at,id').all(tenant, employee, before, after) as any[]).map(r => { const e = JSON.parse(r.json) as WorkEvent; if (digest(e) !== r.hash)
        throw Error('WORKLOG_EVENT_INTEGRITY'); return e; }); }
    hasEvents(tenant: string, employee: string, after: number, before: number) { return !!this.db.prepare('SELECT 1 FROM events WHERE tenant=? AND employee=? AND at>=? AND at<? LIMIT 1').get(tenant, employee, after, before); }
    goals(tenant: string, employee: string, before: number) { const rows = this.db.prepare("SELECT json_extract(json,'$.session') AS session,max(json_extract(json,'$.revision')) AS revision FROM events WHERE tenant=? AND employee=? AND json_extract(json,'$.kind')='goal.changed' AND at<? GROUP BY json_extract(json,'$.session')").all(tenant, employee, before) as any[]; return new Map<string, number>(rows.map(r => [r.session, r.revision])); }
    title(e: WorkEvent, before: number) { const row = this.db.prepare("SELECT json,hash FROM events WHERE tenant=? AND employee=? AND json_extract(json,'$.project')=? AND json_extract(json,'$.workId')=? AND json_extract(json,'$.revision')=? AND json_extract(json,'$.kind')='task.created' AND at<? ORDER BY at DESC LIMIT 1").get(e.tenant, e.employee, e.project, e.workId, e.revision, before) as any; if (!row)
        return; const value = JSON.parse(row.json); if (digest(value) !== row.hash)
        throw Error('WORKLOG_EVENT_INTEGRITY'); return value.title as string; }
    touchPeriod(tenant: string, employee: string, kind: string, day: string) { this.db.prepare('INSERT INTO periods(tenant,employee,kind,day) VALUES(?,?,?,?) ON CONFLICT(tenant,employee,kind,day) DO UPDATE SET pending=1,generation=generation+1').run(tenant, employee, kind, day); }
    verifyAudit() { let previous = '', count = 0; for (const row of this.db.prepare('SELECT json,previous,hash FROM audit ORDER BY seq').iterate() as Iterable<any>) {
        if (row.previous !== previous || digest([previous, row.json]) !== row.hash)
            throw Error('WORKLOG_AUDIT_INTEGRITY');
        previous = row.hash;
        count++;
    } if ((this.db.prepare('SELECT hash FROM audit_root WHERE id=1').get() as any).hash !== previous)
        throw Error('WORKLOG_AUDIT_INTEGRITY'); return { count, root: previous }; }
    latest(id: string) { const r = this.db.prepare('SELECT json,hash FROM reports WHERE id=? ORDER BY version DESC LIMIT 1').get(id) as any; if (!r)
        return; const v = JSON.parse(r.json) as Report; if (digest(v) !== r.hash)
        throw Error('WORKLOG_REPORT_INTEGRITY'); return v; }
    report(id: string, version: number) { const r = this.db.prepare('SELECT json,hash FROM reports WHERE id=? AND version=?').get(id, version) as any; if (!r)
        throw Error('WORKLOG_REPORT_NOT_FOUND'); const v = JSON.parse(r.json) as Report; if (digest(v) !== r.hash)
        throw Error('WORKLOG_REPORT_INTEGRITY'); return v; }
    audit(kind: string, data: unknown) { const previous = (this.db.prepare('SELECT hash FROM audit_root WHERE id=1').get() as any).hash, json = JSON.stringify({ kind, at: Date.now(), data }), hash = digest([previous, json]); this.db.prepare('INSERT INTO audit(json,previous,hash) VALUES(?,?,?)').run(json, previous, hash); this.db.prepare('UPDATE audit_root SET hash=? WHERE id=1').run(hash); }
    saveReport(r: Report) { this.transaction(() => { const old = this.latest(r.id); if (old?.inputHash === r.inputHash && old.basis)
        return; if ((old?.version ?? 0) + 1 !== r.version)
        throw Error('WORKLOG_REPORT_CONFLICT'); this.db.prepare('INSERT INTO reports VALUES(?,?,?,?)').run(r.id, r.version, JSON.stringify(r), digest(r)); this.db.prepare('INSERT INTO outbox(id,report,version) VALUES(?,?,?)').run(digest([r.id, r.version]), r.id, r.version); this.audit('generated', { report: r.id, version: r.version, inputHash: r.inputHash, events: r.events, model: r.model, rules: r.rules }); }); }
    revision(report: string, actor: string, kind: string, value: unknown) { this.transaction(() => { const id = digest([report, kind, value]); this.db.prepare('INSERT OR IGNORE INTO revisions VALUES(?,?,?,?,?,?,?)').run(id, report, actor, kind, Date.now(), JSON.stringify(value), digest(value)); this.audit(kind, { id, report, actor, digest: digest(value) }); const r = this.latest(report); if (kind === 'employee-edit' && r?.kind === 'daily') {
        const at = Date.parse(r.start + 'T00:00:00Z'), day = new Date(at - ((new Date(at).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
        this.touchPeriod(r.tenant, r.employee, 'weekly', day);
    } }); }
    lease(id: string, owner: string, ms = 120000) { return this.transaction(() => { const row = this.db.prepare('SELECT owner,until_at FROM claims WHERE id=?').get(id) as any; if (row && row.until_at > Date.now() && row.owner !== owner) {
        const [host, pid] = String(row.owner).split(':');
        let alive = true;
        if (host === hostname() && /^\d+$/.test(pid))
            try {
                process.kill(Number(pid), 0);
            }
            catch (e: any) {
                if (e.code === 'ESRCH')
                    alive = false;
            }
        if (alive)
            return false;
    } this.db.prepare('INSERT OR REPLACE INTO claims VALUES(?,?,?)').run(id, owner, Date.now() + ms); return true; }); }
    release(id: string, owner: string) { this.db.prepare('DELETE FROM claims WHERE id=? AND owner=?').run(id, owner); }
    modelRequest(day: string, limit: number) { return this.transaction(() => { const used = (this.db.prepare('SELECT used FROM model_budget WHERE day=?').get(day) as any)?.used ?? 0; if (used >= limit)
        throw Error('WORKLOG_MODEL_DAILY_BUDGET'); this.db.prepare('INSERT OR REPLACE INTO model_budget VALUES(?,?)').run(day, used + 1); return used + 1; }); }
    status() { return this.db.prepare('SELECT status,count(*) AS count FROM outbox GROUP BY status').all(); }
}
