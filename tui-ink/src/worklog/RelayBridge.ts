import { Worker } from 'node:worker_threads';
let worker: Worker | undefined, failed = false, lastError = '';
export const captureState = () => ({ running: !!worker, error: lastError });
export function signalWorklog() { if (!process.env.RELAY_WORKLOG_CONFIG || failed)
    return; try {
    if (!worker) {
        const source = import.meta.url.endsWith('.ts'), entry = new URL(source ? './RelayWorker.ts' : './RelayWorker.js', import.meta.url), target = source ? new URL('data:text/javascript,' + encodeURIComponent(`import {register} from ${JSON.stringify(import.meta.resolve('tsx/esm/api'))};register();await import(${JSON.stringify(entry.href)});`)) : entry;
        worker = new Worker(target, { workerData: { root: process.cwd(), config: process.env.RELAY_WORKLOG_CONFIG, startedAt: Date.now() }, execArgv: ['--no-warnings'] });
        worker.unref();
        worker.on('message', message => { if (message.error && message.error !== lastError) {
            lastError = message.error;
            process.stderr.write('[worklog] ' + message.error + '；主会话继续运行。\n');
        } });
        worker.on('error', () => { failed = true; worker = undefined; process.stderr.write('[worklog] 采集未启动；请运行秘书 status 检查配置。\n'); });
    }
    worker.postMessage('scan');
    worker.unref();
}
catch {
    failed = true;
} }
export async function closeWorklog() { const current = worker; worker = undefined; if (current)
    await current.terminate(); }
