// Interactive official login, with account data kept in the selected E-drive home.
import {spawn} from 'node:child_process';
import {copilotExecutable} from '../dist/subscriptions/copilotBridge.js';
import {copilotHome} from '../dist/subscriptions/usage.js';
import {copilotEnvironment} from '../dist/subscriptions/usageProviders.js';
const child=spawn(copilotExecutable(),['login'],{env:{...copilotEnvironment(process.env),COPILOT_HOME:copilotHome()},stdio:'inherit',windowsHide:true});
child.on('error',()=>{process.stderr.write('Copilot login could not start. Run npm install and npm run build first.\n');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
