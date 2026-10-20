import {trustPriceTable,importPriceTable} from '../dist/session/PriceImport.js';
const args=process.argv.slice(2);let root=process.cwd(),issuer,expect,apply=false,action,file;
for(let i=0;i<args.length;i++){
  const a=args[i];if(a==='--root')root=args[++i];else if(a==='--issuer')issuer=args[++i];else if(a==='--expect')expect=args[++i];else if(a==='--apply')apply=true;else if(!action)action=a;else if(!file)file=a;else throw Error('Unexpected argument');
}
try{
  if(!file||!root||!['trust','import'].includes(action))throw Error('Usage: import-prices.mjs trust|import FILE [--root DIR] [--issuer ISSUER] [--apply] [--expect DIGEST]');
  console.log(JSON.stringify(action==='trust'?trustPriceTable(root,file,issuer??''):await importPriceTable(root,file,{apply,expect}),null,2));
}catch(e){console.error(/^PRICE_IMPORT_[A-Z_]+$/.test(e.message)?`${e.message}${e.row?` (price row ${e.row})`:""}`:'PRICE_IMPORT_FILE_OR_HISTORY_ERROR');process.exitCode=1;}
