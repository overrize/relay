import {ownershipNotice} from '../session/RuntimeOwner.js';

/** A rejected submission must not clear a draft or be recorded as accepted. */
export function submitInput(dispatch:()=>boolean|void,reject:(notice:string)=>void):boolean{
 try{return dispatch()!==false;}catch(error){reject(ownershipNotice(error));return false;}
}
