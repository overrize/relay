import {bootstrapRuntime} from './runtime/RuntimeBootstrap.js';
if(!await bootstrapRuntime(()=>process.argv.includes('--ui=native')?import('./tui/native/liveEntry.js'):import('./runtime/AgentRuntime.js'),message=>console.error(`Relay：${message}`)))process.exitCode=1;
