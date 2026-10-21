import fs from 'node:fs';
import path from 'node:path';
import {ProcessTerminal} from '@code-yeongyu/senpi-tui';
import {sessionController} from '../../runtime/SessionController.js';
import {SessionScreen} from './SessionScreen.js';
import {installDiagnosticSink} from '../../runtime/ObservabilityRuntime.js';
import {terminalOwnership} from '../ExternalEditor.js';

if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('Native TUI 需要交互终端');
const logs=path.join(process.cwd(),'.spawn','native-ui');fs.mkdirSync(logs,{recursive:true});
installDiagnosticSink({isTTY:true,demo:false,logFile:path.join(logs,'diagnostic.log')});
sessionController.start({http:true});
const screen=new SessionScreen(new ProcessTerminal({onExternalStdoutWrite:text=>fs.appendFileSync(path.join(logs,'diagnostic.log'),text)}),sessionController,mode=>{
 if(mode==='detach')console.log(`界面已断开；后台进程 PID ${process.pid} 继续运行。关闭此终端仍可能结束进程，可重新启动后 /resume 恢复。`);
},logs);
process.once('SIGTERM',()=>{void screen.close('shutdown').finally(()=>process.exit(143));});
process.on('SIGINT',()=>{if(!terminalOwnership.external)void screen.close('shutdown');});
screen.start();
if(process.argv.includes('--resume'))sessionController.resume();
