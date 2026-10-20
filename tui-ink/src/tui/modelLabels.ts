import {getAgentProviderConfig,type AgentConfigRole,type Config,type ProviderConfig} from "../config.js";
import {resolveModelRoute} from "../models/routing.js";
export function configuredRoleModel(cfg:Config,role:AgentConfigRole):string {
  try{return resolveModelRoute(cfg,role,role==="leader"?"pm":role==="worker"?"implement":"secretary").candidates[0]!.config.model;}
  catch{return getAgentProviderConfig(cfg,role).model;}
}
export function displayedPmModel(cfg:Config,active?:ProviderConfig):string {return active?.model??configuredRoleModel(cfg,"leader");}
export function modelAssignmentSummary(cfg:Config){return `PM=${configuredRoleModel(cfg,"leader")}；Worker=${configuredRoleModel(cfg,"worker")}；秘书=${configuredRoleModel(cfg,"secretary")}`;}
