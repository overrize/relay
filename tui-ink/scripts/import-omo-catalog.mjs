import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';import {createHash} from 'node:crypto';
if(!process.argv[2]||!process.argv[3]||!process.argv[4])throw Error('Usage: node scripts/import-omo-catalog.mjs <senpi-ai-package> <omo-provider-map.json> <senpi-provider-display-names.js>');
const root=path.resolve(process.argv[2]);
const mapFile=process.argv[3];
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),map=JSON.parse(fs.readFileSync(mapFile));
if(pkg.name!=='@code-yeongyu/senpi-ai'||pkg.version!=='2026.10.19')throw Error('Expected pinned senpi-ai 2026.10.19 source');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'dist/providers/data/.manifest.json')));
const names=(await import(pathToFileURL(path.resolve(process.argv[4])))).BUILT_IN_PROVIDER_DISPLAY_NAMES;
const providers=[];
for(const id of map.builtinProviderIds){
 const file=path.join(root,'dist/providers/data',id+'.json');let models;
 if(fs.existsSync(file)){const bytes=fs.readFileSync(file);const expected=manifest.files?.[id+'.json']??manifest[id+'.json'];if(!expected||createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Catalog hash mismatch: '+id);models=Object.values(JSON.parse(bytes)).flatMap(group=>Object.values(group)).filter(m=>(m.type??'chat')==='chat');}
 else if(fs.existsSync(path.join(root,'dist/providers',id+'.models.js'))){const mod=await import(pathToFileURL(path.join(root,'dist/providers',id+'.models.js')));models=Object.entries(mod).filter(([key])=>key.endsWith('_MODELS')&&!key.includes('_IMAGE_')&&!key.includes('_CLASSIFIER_')).flatMap(([,values])=>Object.values(values));}
 else models=[];
 const text=fs.readFileSync(path.join(root,'dist/providers',id+'.js'),'utf8');
 const apis=[...new Set(models.map(m=>m.api))],supported=models.find(m=>m.api==='openai-completions')??models.find(m=>m.api==='anthropic-messages');
 const protocol=supported?.api==='anthropic-messages'?'anthropic':'openai';
 let endpoint=supported?.baseUrl??'',gatewayOnly=!supported;
 if(!endpoint||/[{}<>]/.test(endpoint))endpoint='';
 const label=names[id]??/\bname:\s*["']([^"']+)["']/.exec(text)?.[1]??id;
 providers.push({id,label,protocol,endpoint,gatewayOnly,apis,plan:/token-plan|coding|^zai$|^opencode-go$/.test(id),oauth:map.oauthProviderIds.includes(id),models:[...new Map(models.map(m=>[m.id,{id:m.id,label:m.name??m.id}])).values()]});
}
const snapshot={source:'@code-yeongyu/senpi-ai',version:pkg.version,license:pkg.license,sourceUrl:'https://www.npmjs.com/package/@code-yeongyu/senpi-ai/v/2026.10.19',registrySource:'OmO provider-map.json / senpi 2026.10.19-2',providers};
fs.writeFileSync('src/models/providerSnapshot.json',JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify({providers:providers.length,models:providers.reduce((n,p)=>n+p.models.length,0),direct:providers.filter(p=>!p.gatewayOnly).length,gateway:providers.filter(p=>p.gatewayOnly).map(p=>p.id)}));
