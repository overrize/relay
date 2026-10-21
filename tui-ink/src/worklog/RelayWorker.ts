import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { collectRelay } from './RelayCapture.js';
import { readCapture, scopeFor } from './Config.js';
import { deliver } from './Delivery.js';
let running = false, pending = false;
async function scan() { if (running) {
    pending = true;
    return;
} running = true; try {
    const config = readCapture(workerData.config);
    if (config && scopeFor(config, workerData.root)) {
        if (fs.existsSync(path.join(workerData.root, '.spawn/events')))
            await collectRelay(workerData.root, config, false, workerData.startedAt);
        await deliver(config);
    }
}
catch {
    parentPort?.postMessage({ error: 'WORKLOG_CAPTURE_OR_DELIVERY_FAILED' });
}
finally {
    running = false;
    if (pending) {
        pending = false;
        setTimeout(() => void scan(), 100);
    }
} }
parentPort!.on('message', () => void scan());
setInterval(() => void scan(), 2000).unref();
await scan();
