import {bootstrapRuntime} from './runtime/RuntimeBootstrap.js';
if(!await bootstrapRuntime(()=>import('./runtime/AgentRuntime.js'),message=>console.error(`Relay：${message}`)))process.exitCode=1;
