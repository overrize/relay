// Only fixed public official sources are queried; model API keys are never sent.
import {loadConfig} from '../dist/config.js';
import {sessionJournal} from '../dist/session/Journal.js';
import {syncModelPrices,formatPriceStatus} from '../dist/session/PriceSync.js';
const args=process.argv.slice(2);let root=process.cwd(),sync=false,json=false;
for(let i=0;i<args.length;i++){
  if(args[i]==='--root'){root=args[++i];if(!root)throw Error('--root needs a workspace');}
  else if(args[i]==='--sync')sync=true;
  else if(args[i]==='--json')json=true;
  else throw Error('Usage: node scripts/session-prices.mjs [--root WORKSPACE] [--sync] [--json]');
}
const models=Object.values(loadConfig().models).map(({provider,model,baseUrl,transport,billing})=>({provider,model,baseUrl,transport,billing}));
try{
  if(sync)await syncModelPrices(models,root,{force:true});
  const j=sessionJournal(root);console.log(json?JSON.stringify({prices:j.prices(),status:j.priceStatus()},null,2):formatPriceStatus(models,root));
  if(sync&&j.priceStatus().some(s=>s.state==='error'))process.exitCode=1;
}catch{console.error('Price status/sync failed; inspect source status, journal integrity and concurrent writers.');process.exitCode=1;}
