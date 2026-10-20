/** A separate Node process owns each shell tree. It survives an application crash,
 * polls a nonce-scoped cancel file, and never accepts an arbitrary PID to kill. */
export const SUPERVISOR_SOURCE = String.raw`
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const [token, dir, command, cwd, owner] = process.argv.slice(1);
if (!/^[a-f0-9-]{36}$/.test(token) || path.basename(dir) !== token) process.exit(125);
const recordPath = path.join(dir, 'record.json'), cancelPath = path.join(dir, 'cancel');
let child, stopping = false, closed = false, rootExited = false, killer, stopReason;
function save(status, extra = {}) {
  const temporary = recordPath + '.' + process.pid + '.tmp';
  const fd = fs.openSync(temporary, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify({version:1, token, pid:process.pid, childPid:child?.pid, ownerPid:Number(owner), status, updatedAt:Date.now(), ...extra})); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, recordPath);
}
function ownerAlive() {
  try { process.kill(Number(owner), 0); return Date.now() - fs.statSync(path.join(dir, 'lease')).mtimeMs < 15000; }
  catch { return false; }
}
function finish(status, code) { if (closed) return; closed=true; clearInterval(watch); save(status, {reason:stopReason, exitCode:code}); process.exit(code); }
function stop(reason) {
  if (stopping || closed) return;
  stopping=true; stopReason=reason; save('stopping', {reason});
  if (!child?.pid) return finish('cancelled', 125);
  if (rootExited) { save('blocked',{reason:'Shell exited before its inherited pipes closed; refusing to kill a potentially reused PID'}); process.exit(126); }
  if (process.platform === 'win32') {
    killer = new Promise(resolve => {
      const p=cp.spawn('taskkill.exe', ['/pid',String(child.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'});
      p.on('error', () => resolve(false)); p.on('exit', code => resolve(code===0));
    });
  } else {
    try { process.kill(-child.pid,'SIGKILL'); killer=Promise.resolve(true); }
    catch (error) { killer=Promise.resolve(error.code==='ESRCH'); }
  }
  void killer.then(ok => { if (!ok && !closed) { save('blocked',{reason:'Process tree termination could not be confirmed'}); process.exit(126); } });
}
const watch=setInterval(() => {
  if (fs.existsSync(cancelPath)) stop('cancel-request');
  else if (!ownerAlive()) stop('owner-lost');
}, 200);
process.on('SIGTERM',()=>stop('supervisor-signal')); process.on('SIGINT',()=>stop('supervisor-signal'));
let stdoutOpen=true, stderrOpen=true;
process.stdout.on('error',()=>{stdoutOpen=false;}); process.stderr.on('error',()=>{stderrOpen=false;});
save('starting');
if (fs.existsSync(cancelPath) || !ownerAlive()) finish('cancelled',125);
const invocation = command === '@spawn-file' ? JSON.parse(fs.readFileSync(path.join(dir,'invocation.json'),'utf8')) : undefined;
child=invocation
  ? cp.spawn(invocation.file, invocation.args, {cwd,shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']})
  : cp.spawn(command, {cwd,shell:true,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
if(invocation){child.stdin.on('error',()=>{});child.stdin.end(invocation.input??'');}
save('running');
child.stdout.on('data',chunk=>{if(stdoutOpen && process.stdout.writableLength<1048576) process.stdout.write(chunk);});
child.stderr.on('data',chunk=>{if(stderrOpen && process.stderr.writableLength<1048576) process.stderr.write(chunk);});
child.on('error',error=>{if(stderrOpen)process.stderr.write(String(error));finish('failed',127);});
child.on('exit',()=>{rootExited=true;});
child.on('close',async code=>{
  if (killer && !(await killer)) return;
  finish(stopping?'cancelled':'completed',stopping?125:(code??127));
});
`;
