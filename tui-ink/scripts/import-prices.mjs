import {trustPriceTable,importPriceTable,revisePriceTable} from '../dist/session/PriceImport.js';
const args=process.argv.slice(2);let root=process.cwd(),issuer,expect,apply=false,reason,action;const positionals=[];
try{
  const seen=new Set();
  for(let i=0;i<args.length;i++){
    const a=args[i];if(a.startsWith('--')){
      if(seen.has(a))throw Error('Duplicate flag');seen.add(a);
      if(a==='--apply')apply=true;
      else if(['--root','--issuer','--expect','--reason'].includes(a)){
        const value=args[++i];if(!value||value.startsWith('--'))throw Error('Missing flag value');
        if(a==='--root')root=value;else if(a==='--issuer')issuer=value;else if(a==='--expect')expect=value;else reason=value;
      }else throw Error('Unknown flag');
    }else if(!action)action=a;else positionals.push(a);
  }
  if(!root||!['trust','import','revoke','replace','migrate'].includes(action)||positionals.length!==(['replace','migrate'].includes(action)?2:1))throw Error('Usage: import-prices.mjs trust|import FILE | revoke DIGEST | replace|migrate TARGET FILE [--reason TEXT] [--root DIR] [--issuer ISSUER] [--apply] [--expect DIGEST]');
  if(action==='trust'&&(apply||expect||reason)||action==='import'&&(issuer||reason)||['revoke','replace','migrate'].includes(action)&&issuer)throw Error('Inapplicable flag');
  const result=action==='trust'?trustPriceTable(root,positionals[0],issuer??''):action==='import'?await importPriceTable(root,positionals[0],{apply,expect}):await revisePriceTable(root,positionals[0],{file:action!=='revoke'?positionals[1]:undefined,migrate:action==='migrate',reason:reason??'',apply,expect});
  console.log(JSON.stringify(result,null,2));
}catch(e){console.error(/^PRICE_IMPORT_[A-Z_]+$/.test(e.message)?`${e.message}${e.row?` (price row ${e.row})`:''}`:'PRICE_IMPORT_FILE_OR_HISTORY_ERROR');process.exitCode=1;}
