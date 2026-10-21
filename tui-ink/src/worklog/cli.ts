import fs from 'node:fs';
import path from 'node:path';
import { readCapture, readPublish } from './Config.js';
import { WorkStore } from './Store.js';
import { collectRelay } from './RelayCapture.js';
import { deliver } from './Delivery.js';
import { SecretaryAgent, localDate } from './Reports.js';
import { WorkPublisher } from './Publisher.js';
import { FeishuDocs } from './FeishuDocs.js';
import { SecretaryService } from './Service.js';
import { ingestionServer } from './Ingestion.js';
const args = process.argv.slice(2), command = args[0] ?? 'help', option = (name: string) => { const i = args.indexOf('--' + name); return i < 0 ? undefined : args[i + 1]; }, has = (name: string) => args.includes('--' + name), print = (v: unknown) => process.stdout.write(JSON.stringify(v, null, 2) + '\n');
const required = (name: string) => { const value = option(name); if (!value || value.startsWith('--'))
    throw Error('WORKLOG_ARGUMENT_REQUIRED'); return value; };
async function main() {
    if (command === 'help') {
        print({ commands: ['capture --config FILE --workspace DIR [--backfill]', 'deliver --config FILE', 'status --config FILE', 'pause --config FILE', 'resume --config FILE', 'generate --publish FILE --employee ID --kind daily|weekly --day YYYY-MM-DD', 'publish --publish FILE', 'sync --publish FILE', 'doctor --publish FILE', 'watch --publish FILE', 'provision --publish FILE --name NAME', 'retry --publish FILE --job ID --reason TEXT', 'jobs --publish FILE', 'reconcile --publish FILE --report ID --reason TEXT [--document TOKEN | --confirm-absent] [--audit]', 'verify --publish FILE'], notes: '配置和账本放在工作区之外；密钥只放环境变量。watch 独立于 Relay/OmO 主会话运行。' });
        return;
    }
    if (['capture', 'deliver', 'status', 'pause', 'resume'].includes(command)) {
        const c = readCapture(has('config') ? option('config') : undefined);
        if (!c)
            throw Error('WORKLOG_CAPTURE_CONFIG_REQUIRED');
        if (command === 'capture')
            print(await collectRelay(path.resolve(option('workspace') ?? process.cwd()), c, has('backfill')));
        else if (command === 'deliver')
            print(await deliver(c));
        else {
            const s = new WorkStore(c.store);
            try {
                if (command === 'pause' || command === 'resume')
                    s.paused(c.tenant, c.employee, command === 'pause');
                print({ enabled: c.enabled, tenant: c.tenant, employee: c.employee, paused: s.paused(c.tenant, c.employee), events: (s.db.prepare('SELECT count(*) AS count FROM events WHERE tenant=? AND employee=?').get(c.tenant, c.employee) as any).count, delivery: s.db.prepare('SELECT status,count(*) AS count FROM deliveries GROUP BY status').all(), publication: s.status() });
            }
            finally {
                s.close();
            }
        }
        return;
    }
    if (!has('publish'))
        throw Error('WORKLOG_PUBLISH_CONFIG_REQUIRED');
    const config = readPublish(required('publish')), s = new WorkStore(config.store), cloud = new FeishuDocs(config), publisher = new WorkPublisher(s, config, cloud), agent = new SecretaryAgent(s, config);
    try {
        if (command === 'generate') {
            const employee = required('employee'), kind = option('kind') ?? '';
            if (!['daily', 'weekly'].includes(kind))
                throw Error('WORKLOG_REPORT_KIND_REQUIRED');
            print(await agent.generate(employee, kind as 'daily' | 'weekly', option('day') ?? localDate(Date.now(), config.timeZone)));
        }
        else if (command === 'publish')
            print(await publisher.publish());
        else if (command === 'sync') {
            await publisher.syncEdits();
            print({ synced: true });
        }
        else if (command === 'doctor') {
            print(await cloud.doctor());
            for (const e of config.employees)
                await cloud.folderMembers(e.folder, [e.openId, ...e.leaders]);
            await cloud.folderMembers(config.auditFolder, []);
            print({ foldersVerified: true });
        }
        else if (command === 'provision') {
            if (!has('name'))
                throw Error('WORKLOG_FOLDER_NAME_REQUIRED');
            print(await cloud.provision(required('name')));
        }
        else if (command === 'jobs') {
            print({ jobs: (s.db.prepare('SELECT id,report,version,attempts,status,reason,document FROM outbox ORDER BY rowid DESC LIMIT 100').all() as any[]).filter(j => s.latest(j.report)?.tenant === config.tenant), intents: s.db.prepare('SELECT * FROM intents').all() });
        }
        else if (command === 'verify')
            print(s.verifyAudit());
        else if (command === 'reconcile') {
            await publisher.reconcile(required('report'), required('reason'), option('document'), has('confirm-absent'), has('audit'));
            print({ reconciled: true });
        }
        else if (command === 'retry') {
            publisher.retry(required('job'), option('reason') ?? '');
            print({ retryRequested: true });
        }
        else if (command === 'watch') {
            const service = new SecretaryService(s, config, agent, publisher);
            let stopping = false;
            const server = config.ingest ? ingestionServer(config) : undefined;
            if (server)
                await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(config.ingest!.port, config.ingest!.host, resolve); });
            const stop = () => { stopping = true; server?.closeAllConnections(); server?.close(); };
            process.once('SIGINT', stop);
            process.once('SIGTERM', stop);
            print({ agent: 'independent-work-secretary', tenant: config.tenant, ingestion: server?.address(), timeZone: config.timeZone });
            while (!stopping) {
                try {
                    print(await service.tick());
                }
                catch (e) {
                    const reason = /WORKLOG_[A-Z_]+|FEISHU_[A-Z_0-9]+/.exec(String(e))?.[0] ?? 'WORKLOG_TICK_FAILED';
                    s.transaction(() => s.audit('service-error', { reason }));
                    print({ reason });
                }
                for (let i = 0; i < 60 && !stopping; i++)
                    await new Promise(r => setTimeout(r, 1000));
            }
        }
        else
            throw Error('WORKLOG_UNKNOWN_COMMAND');
    }
    finally {
        s.close();
    }
}
main().catch(error => { process.stderr.write((/WORKLOG_[A-Z_]+|FEISHU_[A-Z_0-9]+/.exec(String(error))?.[0] ?? 'WORKLOG_COMMAND_FAILED') + '\n'); process.exitCode = 1; });
