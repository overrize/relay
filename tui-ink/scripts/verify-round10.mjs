// Real read-only Codex/Copilot quota checks and real subscription PM + API Worker.
// Claude is deliberately excluded; Copilot inference remains gated on login.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {refreshUsage} from '../dist/subscriptions/usage.js';
import {formatUsage} from '../dist/tui/accountStatus.js';
const model=process.argv[2];if(!model)throw Error('Usage: node scripts/verify-round10.mjs <account-supported-Codex-model>');
const repo=process.cwd();fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/live-round10-'));
process.env.SPAWN_USAGE_CACHE_DIR=path.join(root,'quota-cache');process.env.SPAWN_COPILOT_HOME??=path.join(repo,'.spawn/accounts/copilot');
const quota=await Promise.all(['codex','copilot'].map(provider=>refreshUsage(provider,{force:true})));
assert.equal(quota[0].state,'fresh','Real Codex quota must succeed');
for(const snapshot of quota){assert.equal(snapshot.attempts.length,1);assert.ok(snapshot.attempts[0].id);}
fs.writeFileSync(path.join(root,'quota-status.txt'),formatUsage(quota,true));
fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify({claude:'not_queried',quota,copilotInference:'not_run_pending_login'},null,2));
console.log(JSON.stringify({root,claude:'not_queried',quotaStates:quota.map(v=>({provider:v.provider,state:v.state,errorCode:v.errorCode})),copilotInference:'not_run_pending_login'},null,2));
const child=spawn(process.execPath,['scripts/verify-billing-mixed.mjs','--codex',model],{cwd:repo,env:process.env,stdio:'inherit',windowsHide:true});
child.on('error',()=>{process.exitCode=1;});const code=await new Promise(resolve=>child.once('exit',resolve));assert.equal(code,0,'Real mixed PM/Worker and account display must pass');
console.log('ROUND10_REAL_E2E_PASS');
