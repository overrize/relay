import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { digest } from './Store.js';
import { FeishuDocs } from './FeishuDocs.js';
import type { PublishConfig } from './Config.js';

/** Discovery never writes configuration or opens the work ledger. Confirmation
 * binds the displayed company to the application and rechecks it before saving. */
export async function setupTenant(publishFile: string, clientFile?: string, confirmation?: string, transport: typeof fetch = fetch) {
    const publishPath = fs.realpathSync(publishFile);
    const publishText = fs.readFileSync(publishPath, 'utf8');
    const raw = JSON.parse(publishText);
    if (typeof raw.appId !== 'string' || !raw.appId || raw.appId.startsWith('PENDING') || typeof raw.secretEnv !== 'string')
        throw Error('WORKLOG_APP_CREDENTIALS_REQUIRED');
    const company = await new FeishuDocs(raw as PublishConfig, transport).discoverTenant();
    const confirmationCode = digest({ appId: raw.appId, ...company });
    if (!confirmation) return { company, confirmationCode, saved: false };
    if (confirmation !== confirmationCode) throw Error('WORKLOG_COMPANY_CONFIRMATION_CHANGED');
    const files = [{ file: publishPath, original: publishText }];
    if (clientFile) {
        const clientPath = fs.realpathSync(clientFile);
        if (clientPath === publishPath) throw Error('WORKLOG_SETUP_SAME_FILE');
        files.push({ file: clientPath, original: fs.readFileSync(clientPath, 'utf8') });
    }
    // Parse every file before changing any of them. Preserve enabled and all
    // other settings; failures are rolled back, and interrupted runs are safe to repeat.
    const updates = files.map(row => ({ ...row, value: JSON.stringify({ ...JSON.parse(row.original), tenant: company.tenantKey }, null, 2) + '\n' }));
    const replace = (file: string, text: string) => {
        const temp = file + '.setup-' + randomUUID();
        try { fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
        finally { fs.rmSync(temp, { force: true }); }
    };
    const changed: typeof updates = [];
    try {
        for (const row of updates) {
            if (fs.readFileSync(row.file, 'utf8') !== row.original) throw Error('WORKLOG_SETUP_CONFIG_CHANGED');
            replace(row.file, row.value); changed.push(row);
        }
    } catch (error) {
        for (const row of changed.reverse()) replace(row.file, row.original);
        throw error;
    }
    return { company, confirmationCode, saved: true, files: files.map(row => row.file) };
}
