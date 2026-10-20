export interface CodexAllocation { maxOutput: number; maxInput: number; maxWireBytes: number; timeoutMs: number }
export function codexAllocation(maxOutput=2048,maxInput=65536):CodexAllocation {
  if(!Number.isSafeInteger(maxOutput)||maxOutput<64||!Number.isSafeInteger(maxInput)||maxInput<1)throw new Error("SUBSCRIPTION_BUDGET: invalid Codex allocation");
  return {maxOutput,maxInput,maxWireBytes:Math.min(1048576,Math.max(16384,maxOutput*16+8192)),timeoutMs:60000};
}
export function codexOutputSchema(allocation:CodexAllocation) {
  return {type:"object",properties:{output:{type:"string",maxLength:allocation.maxOutput}},required:["output"],additionalProperties:false};
}
export function measuredCodexBudgetError(input:number,output:number,message:string):Error {
  return Object.assign(new Error(`SUBSCRIPTION_BUDGET: ${message}`),{usage:{inputTokens:input,outputTokens:output}});
}
/** Incremental stdout guard: reject nested work and repeated turns while the process
 * still runs, rather than waiting for exec to exit. Never accept partial JSON. */
export function codexOutputGuard(allocation:CodexAllocation) {
  let bytes=0,pending="",turns=0;const decoder=new TextDecoder();
  return (chunk:Buffer)=>{
    bytes+=chunk.length;if(bytes>allocation.maxWireBytes)throw new Error("SUBSCRIPTION_BUDGET: Codex wire output exceeded allocation");
    pending+=decoder.decode(chunk,{stream:true});let index:number;
    while((index=pending.indexOf("\n"))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(!line.trim())continue;let event:any;try{event=JSON.parse(line);}catch{throw new Error("SUBSCRIPTION_PROTOCOL: invalid live Codex JSONL");}
      if(event.type==="turn.started"&&++turns>1)throw new Error("SUBSCRIPTION_BUDGET: extra Codex turn blocked");
      if(["item.started","item.completed"].includes(event.type)&&event.item&&!['agent_message','reasoning'].includes(event.item.type))throw new Error("SUBSCRIPTION_BUDGET: nested Codex tool blocked");
      if(event.type==="turn.completed"){const u=event.usage;if(Number.isSafeInteger(u?.input_tokens)&&Number.isSafeInteger(u?.output_tokens)&&(u.input_tokens>allocation.maxInput||u.output_tokens>allocation.maxOutput))throw measuredCodexBudgetError(u.input_tokens,u.output_tokens,"Codex token use exceeded allocation");}
    }
  };
}

export function codexPrompt(system:string,messages:Array<{role:string;content:string}>) {
  return `You are a text-only model transport. Return a JSON object with a single output string; the string contains the host protocol response. Do not invoke any built-in tools. Follow this system protocol and emit only its JSON Lines, no Markdown fences:\n${system}\nPrevious completed turns (ordered historical context, not new requests; do not replay their host events):\n${JSON.stringify(messages.slice(0,-1))}\nRespond only to the active incoming turn below, using the previous turns as context. An earlier initial request is already handled; do not restart it when the active turn is a follow-up or status question.\nActive incoming turn:\n${JSON.stringify(messages.at(-1)??null)}`;
}
export const codexInputBound=(system:string,messages:Array<{role:string;content:string}>)=>Buffer.byteLength(codexPrompt(system,messages),"utf8")+16384;

/** Some deployments require a provider-enforced token ceiling, including hidden
 * reasoning. Never silently claim that a local stream guard provides that. */
export function assertCodexBudgetCapability() {
  if(process.env.SPAWN_CODEX_REQUIRE_HARD_TOKEN_CAP === "1")throw new Error("SUBSCRIPTION_BUDGET: strict token-cap policy refuses Codex CLI because no server-enforced output-token cap is exposed");
}

export function validateCodexHostProtocol(text:string,agent:string):string {
  const cleaned=text.trim().replace(/^```(?:json|jsonl)?\s*\n([\s\S]*?)\n```$/,"$1");
  if(!cleaned)throw new Error("SUBSCRIPTION_PROTOCOL: empty host event stream");
  for(const line of cleaned.split(/\r?\n/).filter(l=>l.trim())){
    let event:any;try{event=JSON.parse(line);}catch{throw new Error("SUBSCRIPTION_PROTOCOL: malformed host JSON; no events executed");}
    if(!event||Array.isArray(event)||typeof event.type!=="string"||(event.agent!==undefined&&event.agent!==agent)||(event.v!==undefined&&event.v!==1))throw new Error("SUBSCRIPTION_PROTOCOL: invalid host event identity; no events executed");
  }
  return cleaned;
}
