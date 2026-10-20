// Opt-in: never claims real inference success when no account is signed in.
import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {CopilotClient} from '@github/copilot-sdk';
import {copilotExecutable} from '../dist/subscriptions/copilotBridge.js';
import {copilotHome} from '../dist/subscriptions/usage.js';
import {copilotEnvironment} from '../dist/subscriptions/usageProviders.js';
fs.mkdirSync('.test-tmp',{recursive:true});const root=fs.mkdtempSync(path.resolve('.test-tmp/live-copilot-'));
const client=new CopilotClient({connection:{kind:'stdio',path:copilotExecutable()},mode:'empty',baseDirectory:copilotHome(),env:copilotEnvironment(process.env),logLevel:'none'});
let authenticated=false,models=[];
try{await client.start();const auth=await client.getAuthStatus();authenticated=auth.isAuthenticated;if(authenticated)models=(await client.listModels()).map(m=>m.id);}finally{await client.stop();}
const report={runtimeStarted:true,inference:authenticated?'ready':'not_run',reason:authenticated?undefined:'copilot-login-required',models};fs.writeFileSync(path.join(root,'verification.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({root,...report},null,2));
if(!authenticated){process.exitCode=3;}else{
  const model=process.argv[2];if(!model||!models.includes(model))throw Error('Pass a model ID from the reported account model list');
  const child=spawn(process.execPath,['scripts/verify-billing-mixed.mjs','--copilot',model],{stdio:'inherit',windowsHide:true});const code=await new Promise(r=>child.once('exit',r));if(code!==0)process.exitCode=code??1;
}
