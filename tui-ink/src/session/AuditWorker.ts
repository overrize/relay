import {parentPort,workerData} from "node:worker_threads";
import {auditReport} from "./Audit.js";
try{parentPort!.postMessage({report:await auditReport(workerData.root,workerData.filter)});}
catch(error){parentPort!.postMessage({busy:/Another process|index busy|lock unavailable/.test(String(error)),error:"Audit history/index could not be verified; retry after checking integrity and concurrent writers"});}
