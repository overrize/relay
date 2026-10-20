// Offline audit; writes only disposable caches/checkpoints. Redirect --json output to export a detail page.
import {auditReport,formatAudit} from '../dist/session/Audit.js';
const args=process.argv.slice(2),filter={};let root=process.cwd(),json=false;
for(let i=0;i<args.length;i++){
  const arg=args[i];if(arg==='--json'){json=true;continue;}
  if(arg==='--rebuild'){filter.rebuild=true;continue;}
  if(arg==='--root'){root=args[++i];if(!root)throw Error('--root requires a workspace');continue;}
  const split=arg.indexOf('='),key=arg.slice(0,split),value=arg.slice(split+1);
  if(split<1||!value||!['model','task','before','limit'].includes(key))throw Error('Usage: node scripts/session-audit.mjs [--root WORKSPACE] [model=ID task=ID before=SEQ limit=40] [--json] [--rebuild]');
  filter[key]=['before','limit'].includes(key)?Number(value):value;
}
try{const report=await auditReport(root,filter);console.log(json?JSON.stringify(report,null,2):formatAudit(report));}
catch{process.stderr.write('Audit failed: inspect history integrity, lock and filter arguments. No partial accounting report was exported.\n');process.exitCode=1;}
