import fs from 'node:fs';
import {createGunzip} from 'node:zlib';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {StringDecoder} from 'node:string_decoder';
import {decodeArchive} from './Storage.js';
import type {ArchiveRef} from './Storage.js';
import type {Entry} from './Journal.js';
/** Reads Relay's canonical v1 archive without retaining the decompressed object.
 * Consumers must stage results until the generator finishes its digest check. */
async function* canonicalEntries(fd:number,size:number,expected:ArchiveRef):AsyncGenerator<Entry>{
 let reading:Promise<number>|undefined;
 async function* compressed(){for(let offset=0;offset<size;){const bytes=Buffer.alloc(Math.min(65536,size-offset));reading=new Promise<number>((resolve,reject)=>fs.read(fd,bytes,0,bytes.length,offset,(error,n)=>error?reject(error):resolve(n)));const n=await reading;reading=undefined;if(!n)throw Error('History source was truncated during recall');offset+=n;yield bytes.subarray(0,n);}}
 const input=Readable.from(compressed(),{objectMode:false}),unzip=createGunzip(),decoder=new StringDecoder('utf8'),hash=createHash('sha256');
 const fail=(error:Error)=>unzip.destroy(error);input.on('error',fail);input.pipe(unzip);
 const stringToken=/["\\]/g;
 let buffer='',header=false,entryStart=-1,position=0,depth=0,quoted=false,escaped=false,first=true,ended=false,afterComma=false,count=0,previous=expected.from-1;
 try{
  for await(const bytes of unzip){buffer+=decoder.write(bytes as Buffer);
   if(!header){const boundary=buffer.indexOf('"entries":[');if(boundary<0){if(buffer.length>4096)throw Error('Unsupported archive header');continue;}
    const prefix=buffer.slice(0,boundary+11),canonical=JSON.stringify({version:1,from:expected.from,to:expected.to,lastHash:expected.lastHash}).slice(0,-1)+',"entries":[';
    if(prefix!==canonical)throw Error('Unsupported archive header');hash.update(prefix);buffer=buffer.slice(prefix.length);header=true;
   }
   while(position<buffer.length&&!ended){const char=buffer[position]!;
    if(entryStart<0){if(char===']'){if(afterComma)throw Error('Invalid archive separator');ended=true;break;}if(char===','){if(first||afterComma)throw Error('Invalid archive separator');afterComma=true;position++;if(position===buffer.length){buffer=buffer.slice(position);position=0;break;}}if(buffer[position]!=='{'||(!first&&!afterComma))throw Error('Invalid archive entry');entryStart=position;depth=0;quoted=false;escaped=false;}
    if(quoted){if(escaped){position++;escaped=false;continue;}stringToken.lastIndex=position;const token=stringToken.exec(buffer);if(!token){position=buffer.length;break;}position=token.index;}
    const c=buffer[position++]!;if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;}else if(c==='"')quoted=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']')depth--;
    if(depth===0&&!quoted){const raw=buffer.slice(entryStart,position),entry=JSON.parse(raw) as Entry;if(JSON.stringify(entry)!==raw||!Number.isSafeInteger(entry.seq)||entry.seq<=previous||entry.seq<expected.from||entry.seq>expected.to)throw Error('Memory archive entry integrity failure');hash.update((first?'':',')+raw);first=false;afterComma=false;previous=entry.seq;count++;buffer=buffer.slice(position);position=0;entryStart=-1;yield entry;}
   }
  }
  buffer+=decoder.end();if(!header)throw Error('Unsupported archive header');hash.update(']}');const actual=hash.digest('hex');if(!header||!ended||buffer!==`],"digest":"${expected.digest}"}`||actual!==expected.digest||count!==expected.events)throw Error('Memory archive integrity failure');
 }finally{const closed=input.closed?Promise.resolve():new Promise<void>(resolve=>input.once('close',resolve));input.unpipe(unzip);input.destroy();unzip.destroy();await closed;await reading?.catch(()=>{});}
}

export async function* archiveEntries(fd:number,size:number,expected:ArchiveRef):AsyncGenerator<Entry>{
 let yielded=false;
 try{for await(const entry of canonicalEntries(fd,size,expected)){yielded=true;yield entry;}}
 catch(error){
  // Historical hand-edited/noncanonical JSON remains readable through the old
  // verified decoder. Never replay a partially yielded stream.
  if(yielded||!/Unsupported archive header/.test(String(error)))throw error;
  const bytes=Buffer.alloc(size);for(let offset=0;offset<size;){const n=await new Promise<number>((resolve,reject)=>fs.read(fd,bytes,offset,size-offset,offset,(e,n)=>e?reject(e):resolve(n)));if(!n)throw Error('History source truncated');offset+=n;}
  for(const entry of (await decodeArchive(bytes,expected)).entries)yield entry;
 }
}
