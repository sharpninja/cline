// SPDX-License-Identifier: Apache-2.0
// Independent test-only operation model. No expected objects enter this boundary.
export interface PreflightInput { args: string[]; mainThread: boolean; env: Record<string,string|undefined>; }
export interface ParsedUpdateRoute { updateCommand: boolean; updateFlag: boolean; args: string[]; tui: boolean; kanban: boolean; stopped: boolean; }
export interface ParseResponse { args: string[]; result: ParsedUpdateRoute; }
export type PreflightFault = 'none'|'omit-parse'|'changed-args'|'early-bootstrap'|'wrong-message'|'wrong-exit'|'double-write'|'double-exit'|'post-exit-bootstrap'|'false-continue'|'omit-bootstrap'|'force-refusal';
export const REVIEWED_UPDATE_MESSAGE='Upstream Cline updates are unavailable in cline-qb. Install a matching reviewed cline-qb build and restart.';
export const INVALID_UPDATE_MESSAGE='Use --update without a prompt or task flags.';
export interface PreflightObservation { effects: Array<Record<string,unknown>>; consumed: number; remaining: number; terminated: boolean; exitCode?: number; continued: boolean; }
export function runPreflightModel(input:PreflightInput,responses:ParseResponse[],fault:PreflightFault='none'):PreflightObservation {
 const queue=responses.map(r=>({args:[...r.args],result:{...r.result,args:[...r.result.args]}}));
 const effects:Array<Record<string,unknown>>=[];let consumed=0,terminated=false,continued=false,exitCode:number|undefined;
 const bootstrap=()=>{if(fault!=='omit-bootstrap'){effects.push({kind:'bootstrap'});continued=true;}};
 const finish=()=>({effects,consumed,remaining:queue.length,terminated,exitCode,continued});
 if(!input.mainThread || input.env.CLINE_RUN_AS_HUB_DAEMON==='1' || input.env.CLINE_CONNECTOR_SUPERVISED==='1'){bootstrap();return finish();}
 if(fault==='early-bootstrap')bootstrap();
 if(fault==='omit-parse'){bootstrap();return finish();}
 const args=fault==='changed-args'?[...input.args,'changed']:[...input.args];effects.push({kind:'parse',args});
 const response=queue.shift();if(!response)throw new Error('Missing parser response');consumed++;
 if(JSON.stringify(response.args)!==JSON.stringify(args))throw new Error('Wrong/reordered parser response');
 const route=response.result;effects.push({kind:'parsed',route});
 const refusal=(!route.stopped && (route.updateCommand || route.updateFlag)) || fault==='force-refusal';
 if(!refusal){bootstrap();return finish();}
 const invalid=!route.updateCommand && (route.args.length>0 || route.tui || route.kanban);
 const message=fault==='wrong-message'?'wrong diagnostic':invalid?INVALID_UPDATE_MESSAGE:REVIEWED_UPDATE_MESSAGE;
 effects.push({kind:'write',message});if(fault==='double-write')effects.push({kind:'write',message});
 exitCode=fault==='wrong-exit'?0:1;terminated=true;effects.push({kind:'exit',code:exitCode});if(fault==='double-exit')effects.push({kind:'exit',code:exitCode});
 if(fault==='post-exit-bootstrap')bootstrap();if(fault==='false-continue')continued=true;
 return finish();
}
