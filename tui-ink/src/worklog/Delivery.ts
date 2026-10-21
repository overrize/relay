import { readCapture, type CaptureConfig } from './Config.js';
import { WorkStore } from './Store.js';
export async function deliver(config: CaptureConfig, transport: typeof fetch = fetch) { if (!config.enabled || !config.server)
    return { sent: 0 }; const secret = process.env[config.server.tokenEnv]; if (!secret || secret.length < 32)
    throw Error('WORKLOG_INGEST_TOKEN_MISSING_OR_SHORT'); const s = new WorkStore(config.store); try {
    let rows = s.db.prepare("SELECT e.id,e.json,d.attempts FROM deliveries d JOIN events e USING(id) WHERE e.tenant=? AND e.employee=? AND d.status='pending' AND d.next_at<=? ORDER BY e.at LIMIT 100").all(config.tenant, config.employee, Date.now()) as any[];
    let bytes = 0;
    rows = rows.filter(row => { bytes += Buffer.byteLength(row.json); return bytes < 200000; });
    if (!rows.length)
        return { sent: 0 };
    let reason = '';
    try {
        const r = await transport(config.server.url.replace(/\/$/, '') + '/v1/events', { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ events: rows.map(r => JSON.parse(r.json)) }), signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!r.ok)
            throw Error('WORKLOG_INGEST_HTTP_' + r.status);
        const result = await r.json() as any;
        if (result.accepted !== rows.length)
            throw Error('WORKLOG_INGEST_RESPONSE_INVALID');
    }
    catch (e) {
        reason = /WORKLOG_[A-Z_]+(?:_\d+)?/.exec(String(e))?.[0] ?? 'WORKLOG_DELIVERY_UNAVAILABLE';
    }
    s.transaction(() => { for (const row of rows)
        if (!reason)
            s.db.prepare("UPDATE deliveries SET status='sent',reason=NULL WHERE id=?").run(row.id);
        else
            s.db.prepare('UPDATE deliveries SET attempts=attempts+1,status=?,reason=?,next_at=? WHERE id=?').run(row.attempts >= 9 ? 'manual' : 'pending', reason, Date.now() + Math.min(3600000, 30000 * 2 ** row.attempts), row.id); });
    return { sent: reason ? 0 : rows.length, ...(reason ? { reason } : {}) };
}
finally {
    s.close();
} }
