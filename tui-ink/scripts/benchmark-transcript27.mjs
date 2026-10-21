import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import * as api from '../dist/session/Transcript.js';
const root=path.resolve(process.argv[2]??''),workspace=path.resolve('.test-tmp');
if(!root.startsWith(workspace+path.sep)||!fs.existsSync(path.join(root,'benchmark.json')))throw Error('Pass an existing offline benchmark root inside .test-tmp');
if(process.argv.includes('--cold'))fs.rmSync(path.join(root,'.spawn/transcript-cache/index.sqlite'),{force:true});
const samples=[];let before;try{for(let i=0;i<8;i++){const start=performance.now(),page=await api.transcriptPage(root,before);samples.push({page:i+1,ms:Math.round(performance.now()-start),rows:page.rows.length,...page.index});before=page.nextBefore;}}finally{await api.closeTranscriptReaders?.(root);}
console.log(JSON.stringify({root,samples},null,2));
