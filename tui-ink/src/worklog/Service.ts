import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkStore } from './Store.js';
import { SecretaryAgent, localDate, addDays, period, dayStart } from './Reports.js';
import { WorkPublisher } from './Publisher.js';
import type { PublishConfig } from './Config.js';
export class SecretaryService {
    readonly owner = `${hostname()}:${process.pid}:${randomUUID()}`;
    constructor(readonly store: WorkStore, readonly config: PublishConfig, readonly agent = new SecretaryAgent(store, config), readonly publisher = new WorkPublisher(store, config)) { }
    async tick(now = Date.now()) {
        if (!this.store.lease('secretary:' + this.config.tenant, this.owner))
            return { busy: true };
        try {
            await this.publisher.syncEdits();
            const today = localDate(now, this.config.timeZone), clock = new Intl.DateTimeFormat('sv-SE', { timeZone: this.config.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now), employees = new Set(this.config.employees.map(e => e.id));
            const dirty = this.store.db.prepare("SELECT d.id,d.employee,d.at,json_extract(e.json,'$.kind') AS kind FROM dirty_events d JOIN events e USING(id) WHERE d.tenant=? ORDER BY d.at LIMIT 5000").all(this.config.tenant) as any[];
            this.store.transaction(() => { for (const e of dirty) {
                if (!employees.has(e.employee))
                    continue;
                if (e.kind === 'session.settled') {
                    this.store.db.prepare('DELETE FROM dirty_events WHERE id=?').run(e.id);
                    continue;
                }
                const day = localDate(e.at, this.config.timeZone);
                this.store.touchPeriod(this.config.tenant, e.employee, 'daily', day);
                this.store.touchPeriod(this.config.tenant, e.employee, 'weekly', period('weekly', day).start);
                this.store.db.prepare('DELETE FROM dirty_events WHERE id=?').run(e.id);
            } });
            const dow = ((new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1, queue = this.store.db.prepare('SELECT * FROM periods WHERE tenant=? AND pending=1 ORDER BY day,kind LIMIT 1000').all(this.config.tenant) as any[];
            let generated = 0;
            for (const item of queue) {
                if (generated >= 20)
                    break;
                if (!employees.has(item.employee))
                    continue;
                const due = item.kind === 'daily' ? (item.day < today || item.day === today && clock >= this.config.dailyAt) : (addDays(item.day, 7) <= today && dow >= this.config.weeklyDay && clock >= this.config.dailyAt);
                if (!due)
                    continue;
                await this.agent.generate(item.employee, item.kind, item.day, now);
                this.store.db.prepare('UPDATE periods SET pending=0 WHERE tenant=? AND employee=? AND kind=? AND day=? AND generation=?').run(this.config.tenant, item.employee, item.kind, item.day, item.generation);
                generated++;
            }
            const publication = await this.publisher.publish();
            return { generated, ...publication };
        }
        finally {
            this.store.release('secretary:' + this.config.tenant, this.owner);
        }
    }
}
