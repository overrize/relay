import fs from 'node:fs';
import path from 'node:path';
export interface Scope {
    root: string;
    project: string;
    exclude: string[];
}
export interface CaptureConfig {
    version: 1;
    enabled: boolean;
    tenant: string;
    employee: string;
    store: string;
    scopes: Scope[];
    file: string;
    server?: {
        url: string;
        tokenEnv: string;
    };
}
export interface PublishConfig {
    version: 1;
    store: string;
    tenant: string;
    timeZone: string;
    dailyAt: string;
    weeklyDay: number;
    appId: string;
    secretEnv: string;
    employees: {
        id: string;
        openId: string;
        folder: string;
        leaders: string[];
    }[];
    auditFolder: string;
    serviceGroupId?: string;
    ingest?: {
        host: string;
        port: number;
        clients: {
            employee: string;
            tokenEnv: string;
            projects: string[];
        }[];
    };
    model?: {
        baseUrl: string;
        name: string;
        keyEnv: string;
        requestsPerDay: number;
        maxOutputTokens: number;
    };
    file: string;
}
export const within = (file: string, root: string) => { const rel = path.relative(root, file); return rel === '' || !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel); };
const id = (x: unknown) => typeof x === 'string' && /^[\w.:-]{1,128}$/.test(x);
function absolute(x: unknown) { if (typeof x !== 'string' || !path.isAbsolute(x))
    throw Error('WORKLOG_ABSOLUTE_PATH_REQUIRED'); return path.resolve(x); }
function canonicalTarget(value: unknown) { let target = absolute(value); const rest: string[] = []; while (!fs.existsSync(target)) {
    const parent = path.dirname(target);
    if (parent === target)
        throw Error('WORKLOG_PATH_PARENT_MISSING');
    rest.unshift(path.basename(target));
    target = parent;
} return path.join(fs.realpathSync(target), ...rest); }
export function readCapture(file = process.env.RELAY_WORKLOG_CONFIG): CaptureConfig | undefined {
    if (!file)
        return;
    const target = fs.realpathSync(absolute(file)), v = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (v.version !== 1 || typeof v.enabled !== 'boolean' || !id(v.tenant) || !id(v.employee) || !Array.isArray(v.scopes) || !v.scopes.length)
        throw Error('WORKLOG_INVALID_CAPTURE_CONFIG');
    const scopes: Scope[] = v.scopes.map((s: any) => { if (!id(s.project) || !Array.isArray(s.exclude) || s.exclude.some((p: any) => typeof p !== 'string' || path.isAbsolute(p) || p.split(/[\\/]/).includes('..')))
        throw Error('WORKLOG_INVALID_SCOPE'); return { root: fs.realpathSync(absolute(s.root)), project: s.project, exclude: s.exclude }; });
    const store = canonicalTarget(v.store);
    if (scopes.some(s => within(target, s.root) || within(store, s.root)))
        throw Error('WORKLOG_CONFIG_AND_STORE_MUST_BE_OUTSIDE_WORKSPACE');
    if (scopes.some((s, i) => scopes.some((b, j) => i !== j && (within(s.root, b.root) || within(b.root, s.root)))))
        throw Error('WORKLOG_OVERLAPPING_SCOPES');
    if (v.server) {
        const u = new URL(v.server.url);
        if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) || u.username || u.password || u.search || u.hash || u.pathname !== '/' || !id(v.server.tokenEnv))
            throw Error('WORKLOG_INVALID_SERVER');
    }
    return { version: 1, enabled: v.enabled, tenant: v.tenant, employee: v.employee, store, scopes, file: target, server: v.server };
}
export function scopeFor(c: CaptureConfig, workspace: string): Scope | undefined { if (!c.enabled)
    return; let real: string; try {
    real = fs.realpathSync(workspace);
}
catch {
    return;
} const scope = c.scopes.find(s => within(real, s.root)); if (!scope)
    return; const relative = path.relative(scope.root, real), parts = relative.split(path.sep); if (parts.some(p => ['.git', '.spawn', 'node_modules'].includes(p)) || scope.exclude.some(p => within(real, path.resolve(scope.root, p))))
    return; return scope; }
export function safeArtifact(c: CaptureConfig, workspace: string, file: unknown) { if (typeof file !== 'string' || file.length > 1000)
    return; const s = scopeFor(c, workspace); if (!s)
    return; let real: string; try {
    real = fs.realpathSync(path.resolve(workspace, file));
}
catch {
    return;
} if (!within(real, s.root) || !scopeFor(c, path.dirname(real)) || /(^|[\\/])(\.env(?:\.|$)|.*(?:credential|secret|token|password|private[-_]?key).*)/i.test(path.relative(s.root, real)))
    return; return path.relative(s.root, real).split(path.sep).join('/'); }
export function cleanTitle(value: unknown) { if (typeof value !== 'string')
    return '工作事项'; const text = value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim(); if (/(?:sk-[a-z0-9]{12,}|bearer\s+\S+|(?:api[_ -]?key|password|secret|access[_ -]?token)\s*[:=]|-----BEGIN .*PRIVATE KEY)/i.test(text))
    return '工作事项（敏感字段已隐藏）'; return text.slice(0, 300) || '工作事项'; }
export function readPublish(file: string): PublishConfig { const target = fs.realpathSync(absolute(file)), v = JSON.parse(fs.readFileSync(target, 'utf8')); if (v.version !== 1 || !id(v.tenant) || !id(v.appId) || !id(v.secretEnv) || !Array.isArray(v.employees) || !v.employees.length || !id(v.auditFolder))
    throw Error('WORKLOG_INVALID_PUBLISH_CONFIG'); new Intl.DateTimeFormat('en', { timeZone: v.timeZone }); if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.dailyAt) || !Number.isInteger(v.weeklyDay) || v.weeklyDay < 1 || v.weeklyDay > 7)
    throw Error('WORKLOG_INVALID_SCHEDULE'); const employees = v.employees.map((e: any) => { if (!id(e.id) || !id(e.openId) || !id(e.folder) || !Array.isArray(e.leaders) || e.leaders.some((x: any) => !id(x)))
    throw Error('WORKLOG_INVALID_EMPLOYEE'); return { ...e, leaders: [...new Set(e.leaders)] }; }); if (new Set(employees.map((e: any) => e.id)).size !== employees.length || new Set(employees.map((e: any) => e.folder)).size !== employees.length || employees.some((e: any) => e.folder === v.auditFolder))
    throw Error('WORKLOG_FOLDER_OR_EMPLOYEE_COLLISION'); if (v.serviceGroupId !== undefined && !id(v.serviceGroupId))
    throw Error('WORKLOG_INVALID_SERVICE_GROUP'); if (v.ingest && (!['127.0.0.1', '::1'].includes(v.ingest.host) || !Number.isInteger(v.ingest.port) || v.ingest.port < 1 || v.ingest.port > 65535 || !Array.isArray(v.ingest.clients) || v.ingest.clients.some((c: any) => !employees.some((e: any) => e.id === c.employee) || !id(c.tokenEnv) || !Array.isArray(c.projects) || !c.projects.length || c.projects.some((x: any) => !id(x)))))
    throw Error('WORKLOG_INVALID_INGEST'); if (v.model) {
    const m = v.model, u = new URL(m.baseUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !id(m.keyEnv) || typeof m.name !== 'string' || !Number.isInteger(m.requestsPerDay) || m.requestsPerDay < 1 || m.requestsPerDay > 100 || !Number.isInteger(m.maxOutputTokens) || m.maxOutputTokens < 128 || m.maxOutputTokens > 4096)
        throw Error('WORKLOG_INVALID_MODEL');
} return { ...v, store: canonicalTarget(v.store), employees, file: target }; }
