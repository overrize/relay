// Real PM/Worker workflow plus fresh-process index, pricing and restore checks.
// Test rates are explicitly synthetic and never modify the user's model config.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {SessionJournal} from '../dist/session/Journal.js';
import {restoreBackup} from '../dist/session/Backup.js';
import {recordPrice} from '../dist/session/Pricing.js';
import {loadConfig} from '../dist/config.js';
import {resolveModelRoute} from '../dist/models/routing.js';
const repo=process.cwd();fs.mkdirSync('.test-tmp',{recursive:true});
const output=fs.mkdtempSync(path.resolve('.test-tmp/live-round12-')),mixedReport=path.join(output,'mixed.json');
const mode=process.argv[2]??'--configured',args=mode==='--codex'?['--codex',process.argv[3]]:['--configured'];
if(args.some(v=>!v))throw Error('Pass an available Codex model');
const child=spawn(process.execPath,['scripts/verify-billing-mixed.mjs',...args],{cwd:repo,env:{...process.env,SPAWN_VERIFICATION_REPORT_FILE:mixedReport},stdio:'inherit',windowsHide:true});
const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});assert.equal(code,0,'Real transport workflow must pass');
const mixed=JSON.parse(fs.readFileSync(mixedReport,'utf8'));assert.equal(mixed.continuousPM,true);assert.equal(mixed.accepted,'accepted');
const inspect=async root=>{const started=performance.now(),r=await promisify(execFile)(process.execPath,['scripts/session-audit.mjs','--root',root,'--json','limit=200'],{cwd:repo,windowsHide:true,maxBuffer:8*1024*1024});return {report:JSON.parse(r.stdout),ms:performance.now()-started};};
const first=await inspect(mixed.root),second=await inspect(mixed.root);assert.equal(second.report.index.visited,0);assert.deepEqual(second.report.totals,first.report.totals);
const j=new SessionJournal(mixed.root),budget=j.budget();assert.equal(first.report.totals.requests,budget.used.requests);assert.equal(first.report.totals.tokens,budget.used.tokens);assert.equal(first.report.totals.microUsd,budget.used.microUsd);
let supplemented=first.report;
if(mode==='--configured'){
  const cfg=loadConfig(),pm=resolveModelRoute(cfg,'leader','pm').candidates[0].config;
  recordPrice(j,pm,2,4,{source:'verification-fixture-not-vendor-price'});
  supplemented=(await inspect(mixed.root)).report;
  assert.ok(supplemented.pricing.resolved>0,'Measured real PM usage can be backfilled');
  assert.deepEqual(supplemented.totals,first.report.totals,'Backfill cannot rewrite recorded spending');
  assert.equal(j.budget().used.microUsd,budget.used.microUsd);
  assert.equal((await inspect(mixed.root)).report.index.visited,0);
}
await j.maintain({maxLogBytes:0,retentionMs:0,maxIndexBytes:1024*1024,maxTotalBytes:32*1024*1024});
const cold=(await inspect(mixed.root)).report;assert.deepEqual(cold.totals,supplemented.totals);assert.deepEqual(cold.pricing,supplemented.pricing);
const backup=await j.backup(),restored=path.join(output,'restored');await restoreBackup(mixed.root,restored,{id:backup.id});const recovered=(await inspect(restored)).report;
assert.deepEqual(recovered.totals,supplemented.totals);assert.deepEqual(recovered.pricing,supplemented.pricing);assert.deepEqual(recovered.byTask,supplemented.byTask);
assert.ok(recovered.rows.some(r=>r.kind==='task-state'&&r.state==='accepted'&&r.reason==='acceptance'));
assert.equal((await inspect(restored)).report.index.visited,0);
const report={workspace:mixed.root,continuousPM:true,accepted:true,mode,newProcessIndex:true,retention:true,backupRestore:true,immutableSpending:true,pricing:recovered.pricing,firstAuditMs:Math.round(first.ms),warmAuditMs:Math.round(second.ms),claude:'not_queried',copilot:'pending_login'};
fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log('ROUND12_REAL_E2E_PASS');
