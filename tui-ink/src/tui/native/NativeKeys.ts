import {parseKey,getKeybindings} from '@code-yeongyu/senpi-tui';
import {KEY_ACTIONS,Keybindings,keySequences,normalizeKey,type KeyAction,type KeyScope} from '../Keybindings.js';

/** Receives complete toolkit key events; never decodes stdin or bracketed paste. */
export class NativeKeys {
 readonly bindings=new Keybindings();
 reload(){this.bindings.reload();}
 install(){
  const native=getKeybindings(),bindings=native.getUserBindings();
  // Relay owns the key map before viewport navigation; mouse remains toolkit-owned.
  for(const id of ['pageUp','pageDown','halfPageUp','halfPageDown','lineUp','lineDown','previousPrompt','nextPrompt','search','top','bottom'])bindings[`tui.altScreen.${id}`]=[];
  bindings['tui.editor.undo']=['ctrl+z'];native.setUserBindings(bindings);
 }
 translate(data:string,scope:KeyScope):{action?:KeyAction;data:string}{
  if(data.includes('\x1b[200~')||data.includes('\x1b[201~'))return {data};
  // The toolkit aliases Alt+N/P to navigation. Preserve explicitly configured
  // physical keys before using its CSI-u parser, including disabled defaults.
  const candidates=new Set([...Object.values(KEY_ACTIONS).flatMap(d=>d.keys),...Object.keys(KEY_ACTIONS).flatMap(id=>this.bindings.keys(id as KeyAction))]);
  const physical=[...candidates].find(k=>keySequences(k).includes(data));
  const parsed=physical??parseKey(data);if(!parsed)return {data};const key=normalizeKey(parsed);
  for(const [id,definition] of Object.entries(KEY_ACTIONS))if(definition.scopes.includes(scope)&&this.bindings.keys(id as KeyAction).includes(key))return {action:id as KeyAction,data:definition.canonical};
  const known=Object.values(KEY_ACTIONS).some(d=>d.scopes.includes(scope)&&d.keys.includes(key))||Object.keys(KEY_ACTIONS).some(id=>this.bindings.keys(id as KeyAction).includes(key));
  if(known)return {data:''};
  // Editor operations not owned by Relay (word movement, paste, etc.) stay native.
  return {data};
 }
 hint(id:KeyAction){return this.bindings.hint(id);}
}
