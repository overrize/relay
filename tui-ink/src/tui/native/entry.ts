import {ProcessTerminal} from '@code-yeongyu/senpi-tui';
import {NativeWorkbench} from './Workbench.js';
import {configuredModels} from '../interaction.js';
import {loadConfig} from '../../config.js';
import path from 'node:path';
import fs from 'node:fs';

if(!process.stdin.isTTY||!process.stdout.isTTY)throw new Error('交互验证版需要真实终端；自动测试运行 npm test。');
const logDirectory=path.join(process.cwd(),'.spawn','native-ui-preview');fs.mkdirSync(logDirectory,{recursive:true});
// No credentials cross the UI boundary; the workbench has no provider adapter.
const config=loadConfig(),models=configuredModels(config.models).map(name=>`${name} · ${config.models[name]!.model}`);
const terminal=new ProcessTerminal({onExternalStdoutWrite:text=>fs.appendFileSync(path.join(logDirectory,'diagnostic.log'),text)});
const workbench=new NativeWorkbench(terminal,models,()=>{},logDirectory);
const stop=()=>workbench.close();process.once('SIGTERM',stop);process.once('SIGINT',stop);
workbench.start();
