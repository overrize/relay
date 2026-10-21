import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WorkStore, digest, type WorkEvent } from './Store.js';
import { cleanTitle, type PublishConfig } from './Config.js';
export function validWorkEvent(e: any): e is WorkEvent { const keys = ['version', 'id', 'client', 'tenant', 'employee', 'project', 'session', 'sourceId', 'sourceSeq', 'workId', 'revision', 'at', 'kind', 'outcome', 'title', 'artifacts', 'policy']; return e && Object.keys(e).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(e, k)) && e.version === 1 && ['relay', 'omo'].includes(e.client) && e.policy === 'workspace-v1' && ['planned', 'progress', 'verified', 'blocked', 'superseded'].includes(e.outcome) && ['tenant', 'employee', 'project', 'session', 'sourceId', 'workId', 'kind'].every(k => typeof e[k] === 'string' && e[k].length > 0 && e[k].length <= 160) && ['sourceSeq', 'revision', 'at'].every(k => Number.isSafeInteger(e[k]) && e[k] >= 0) && typeof e.title === 'string' && e.title.length <= 300 && cleanTitle(e.title) === e.title && Array.isArray(e.artifacts) && e.artifacts.length <= 20 && e.artifacts.every((p: any) => typeof p === 'string' && p.length < 500 && !p.startsWith('/') && !p.includes('\\') && !p.includes(':') && !p.split('/').some((x: string) => x === '..' || ['.git', '.spawn', '.env', 'node_modules'].includes(x))) && e.id === digest([e.client, e.sourceId, e.session, e.tenant, e.employee]); }
export function ingestionServer(config: PublishConfig) {
    if (!config.ingest)
        throw Error('WORKLOG_INGEST_NOT_CONFIGURED');
    const clients = config.ingest.clients.map(c => { const token = process.env[c.tokenEnv]; if (!token || token.length < 32)
        throw Error('WORKLOG_INGEST_TOKEN_MISSING_OR_SHORT'); return { ...c, token: Buffer.from(token) }; });
    if (new Set(clients.map(c => c.token.toString())).size !== clients.length)
        throw Error('WORKLOG_INGEST_TOKENS_MUST_BE_UNIQUE');
    const store = new WorkStore(config.store), server = http.createServer(async (req, res) => {
        const reply = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
        const text = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '', token = Buffer.from(text);
        const client = clients.find(c => c.token.length === token.length && timingSafeEqual(c.token, token));
        if (!client) {
            reply(401, { error: 'UNAUTHORIZED' });
            return;
        }
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'POST' && url.pathname === '/v1/events') {
                let size = 0, buffers: Buffer[] = [];
                for await (const bytes of req) {
                    size += bytes.length;
                    if (size > 256 * 1024) {
                        reply(413, { error: 'PAYLOAD_LIMIT' });
                        return;
                    }
                    buffers.push(bytes);
                }
                const value = JSON.parse(Buffer.concat(buffers).toString());
                if (!Array.isArray(value.events) || value.events.length > 100 || value.events.some((e: any) => !validWorkEvent(e) || e.tenant !== config.tenant || e.employee !== client.employee || !client.projects.includes(e.project) || e.at > Date.now() + 300000)) {
                    reply(400, { error: 'WORKLOG_EVENT_SCOPE_OR_SCHEMA' });
                    return;
                }
                store.capture(value.events);
                reply(200, { accepted: value.events.length });
                return;
            }
            if (req.method === 'GET' && url.pathname === '/v1/reports') {
                const rows = store.db.prepare('SELECT DISTINCT id FROM reports').all() as any[];
                reply(200, { reports: rows.map(r => store.latest(r.id)).filter(r => r?.tenant === config.tenant && r.employee === client.employee) });
                return;
            }
            const match = /^\/v1\/reports\/([a-f0-9]{64})$/.exec(url.pathname);
            if (req.method === 'GET' && match) {
                const report = store.latest(match[1]);
                if (!report || report.tenant !== config.tenant || report.employee !== client.employee) {
                    reply(404, { error: 'NOT_FOUND' });
                    return;
                }
                reply(200, { report, revisions: store.db.prepare('SELECT actor,kind,at,json,hash FROM revisions WHERE report=? ORDER BY at').all(report.id) });
                return;
            }
            reply(404, { error: 'NOT_FOUND' });
        }
        catch {
            reply(400, { error: 'WORKLOG_REQUEST_REJECTED' });
        }
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.on('close', () => store.close());
    return server;
}
