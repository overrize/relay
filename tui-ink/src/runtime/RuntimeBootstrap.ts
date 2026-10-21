import {registerRuntimeOwner,releaseRuntimeOwners,ownershipNotice} from '../session/RuntimeOwner.js';

/** Claim before importing code that creates journals, services, or a terminal UI. */
export async function bootstrapRuntime(start:()=>Promise<unknown>,report:(message:string)=>void,root=process.cwd()):Promise<boolean>{
 try{registerRuntimeOwner(root);}catch(error){report(ownershipNotice(error));return false;}
 const release=()=>releaseRuntimeOwners();process.once('exit',release);
 try{await start();return true;}catch(error){process.removeListener('exit',release);release();report(ownershipNotice(error));return false;}
}
