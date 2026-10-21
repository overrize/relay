import http from 'node:http';
import {randomBytes,createHash} from 'node:crypto';

/** PKCE yields a user-controlled API key, not a subscription entitlement. */
export async function openRouterOAuth(notify:(message:string)=>void,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<string>{
 signal.throwIfAborted();const verifier=randomBytes(32).toString('base64url'),path='/oauth/'+randomBytes(24).toString('hex');
 const server=http.createServer();let accepted=false;
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),300000);
 const combined=AbortSignal.any([signal,controller.signal]);
 try{
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address() as {port:number};
  const result=new Promise<string>((resolve,reject)=>{
   const abort=()=>reject(new DOMException('OAuth cancelled or timed out','AbortError'));
   combined.addEventListener('abort',abort,{once:true});
   server.on('request',(req,res)=>{
    const url=new URL(req.url??'/',`http://127.0.0.1:${address.port}`),code=url.searchParams.get('code');
    if(req.method!=='GET'||url.pathname!==path||!code||code.length>4096||accepted){res.writeHead(400);res.end('Invalid callback');return;}
    accepted=true;res.setHeader('Content-Type','text/plain');res.setHeader('Cache-Control','no-store');res.end('Authorization received. Return to Relay.');
    void (async()=>{try{
     const r=await fetcher('https://openrouter.ai/api/v1/auth/keys',{method:'POST',redirect:'error',signal:AbortSignal.any([combined,AbortSignal.timeout(30000)]),headers:{'Content-Type':'application/json'},body:JSON.stringify({code,code_verifier:verifier,code_challenge_method:'S256'})});
     if(!r.ok)throw new Error(`OpenRouter OAuth exchange HTTP ${r.status}`);
     const body=await r.json() as {key?:unknown};if(typeof body.key!=='string'||!body.key||body.key.length>8192||/[\r\n]/.test(body.key))throw new Error('OpenRouter OAuth missing key');resolve(body.key);
    }catch{reject(new Error('OpenRouter OAuth exchange failed; retry authorization'));}finally{combined.removeEventListener('abort',abort);}})();
   });
   if(combined.aborted)abort();
  });
  const url=new URL('https://openrouter.ai/auth');url.search=new URLSearchParams({callback_url:`http://127.0.0.1:${address.port}${path}`,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  notify(`在浏览器打开以下链接完成 OpenRouter 授权（API 计费）；本地回调等待 5 分钟，Esc 取消：\n${url}`);
  return await result;
 }finally{clearTimeout(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
