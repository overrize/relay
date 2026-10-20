// Opt-in real quota reads and bounded Codex calls. No Copilot account is created.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const model=process.argv[2];if(!model)throw Error('Usage: node scripts/verify-round9.mjs <account-supported-Codex-model>');
const repo=process.cwd();fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.join(repo,'.test-tmp/live-round9-'));process.chdir(root);
process.env.SPAWN_USAGE_CACHE_DIR=path.join(root,'quota-cache');process.env.SPAWN_COPILOT_HOME??=path.join(repo,'.spawn/accounts/copilot');process.env.SPAWN_SESSION_MAX_REQUESTS='3';process.env.SPAWN_COMMUNICATION_REQUESTS='1';
const {refreshUsage}=await import('../dist/subscriptions/usage.js');
const {callCodexSubscription}=await import('../dist/adapters/codexSubscription.js');const {codexInputBound}=await import('../dist/adapters/codexBudget.js');
const {sessionJournal}=await import('../dist/session/Journal.js');const {reserveSessionRequest,settleSessionRequest}=await import('../dist/session/Budget.js');
const quota=await Promise.all(['claude','codex','copilot'].map(p=>refreshUsage(p,{force:true})));
sessionJournal().bind('pm','Leader');const config={provider:'openai',model,transport:'codex-cli',apiKey:'',billing:{mode:'subscription'}};
async function invoke(system,maxOutput,communication=false){const messages=[{role:'user',content:'Execute this controlled transport verification.'}],permit=reserveSessionRequest('pm',codexInputBound(system,messages),maxOutput,communication,config);try{const result=await callCodexSubscription(config,system,messages,{agent:'pm',maxOutput:permit.maxOutput,maxInput:permit.maxInput});settleSessionRequest('pm',permit.id,result.promptTokens,result.completionTokens);return {result,permit};}catch(e){settleSessionRequest('pm',permit.id,e.usage?.inputTokens,e.usage?.outputTokens);throw e;}}
let overspend;
try{await invoke('The output string must consist only of exactly 64 repetitions of the Chinese character 龘. No English, JSON protocol or abbreviation inside the string.',64);throw Error('Expected an independently reported token allocation overrun');}catch(e){if(!e.message.startsWith('SUBSCRIPTION_BUDGET')||!e.usage)throw e;overspend={stopped:true,reason:e.message,usage:e.usage};}
assert.ok((await invoke('The output string must be exactly BOUNDED_OK.',512)).result.text.includes('BOUNDED_OK'));
assert.throws(()=>reserveSessionRequest('pm',100,128,false,config),/SESSION_BUDGET/);
const talk=await invoke('Inside output emit exactly one host event {"v":1,"type":"message","agent":"pm","to":"user","text":"PM_STILL_HERE"}.',512,true);assert.equal(talk.permit.communicationOnly,true);assert.ok(talk.result.text.includes('PM_STILL_HERE'));
assert.throws(()=>reserveSessionRequest('pm',100,128,true,config),/SESSION_BUDGET/);
const budget=sessionJournal().budget();assert.equal(budget.used.requests,3);const report={root,quota,overspend,structuredOutputVerified:true,normalBudgetStopped:true,communicationReserveWorked:true,noFourthModelInvocation:true,budget:{used:budget.used,byBilling:budget.byBilling}};
fs.writeFileSync('verification.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
