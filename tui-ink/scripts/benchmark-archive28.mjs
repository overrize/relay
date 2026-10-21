// Isolated-process RSS benchmark: run each mode in a fresh Node process.
import fs from 'node:fs';import path from 'node:path';import {performance} from 'node:perf_hooks';
import {decodeArchive} from '../dist/session/Storage.js';import {archiveEntries} from '../dist/session/ArchiveStream.js';
const root=path.resolve(process.argv[2]??''),mode=process.argv[3];if(!root.startsWith(path.resolve('.test-tmp')+path.sep)||!fs.existsSync(path.join(root,'benchmark.json'))||!['whole','stream'].includes(mode))throw Error('Expected offline benchmark fixture and whole|stream');
const base=JSON.parse(fs.readFileSync(path.join(root,'.spawn/events/retention.json'),'utf8')),ref=base.archives[0];if(!/^\d{16}-\d{16}\.mem\.gz$/.test(ref.name))throw Error('Invalid archive path');const file=path.join(root,'.spawn/events/memory',ref.name);global.gc?.();const before=process.memoryUsage().rss,start=performance.now();let entries=0;
if(mode==='whole'){const value=await decodeArchive(fs.readFileSync(file),ref);entries=value.entries.length;}else{const fd=fs.openSync(file,'r');try{for await(const entry of archiveEntries(fd,ref.bytes,ref))entries++;}finally{fs.closeSync(fd);}}
console.log(JSON.stringify({mode,entries,ms:Math.round(performance.now()-start),initialRssMiB:Math.round(before/1048576),peakRssMiB:Math.round(process.resourceUsage().maxRSS/1024)}));
