// SPDX-License-Identifier: Apache-2.0
import { createProgram } from '../commands/program';
import { UPSTREAM_UPDATE_DISABLED_MESSAGE } from '../commands/update-policy';
import { normalizeCliArgs } from './cli-args';
interface Input { args:string[]; mainThread:boolean; env:Readonly<Record<string,string|undefined>>; }
interface Route { updateCommand:boolean; updateFlag:boolean; args:string[]; tui:boolean; kanban:boolean; stopped:boolean; }
interface Effects { onParse?:(args:string[])=>void; onParsed?:(route:Route)=>void; write:(message:string)=>void; terminate:(code:number)=>void; continueStartup:()=>void; }
/** Only the excluded updater route terminates here; normal startup remains owned by index.ts. */
export function runUpdaterPreflight(input:Input,effects:Effects):void {
 if(!input.mainThread || input.env.CLINE_RUN_AS_HUB_DAEMON==='1' || input.env.CLINE_CONNECTOR_SUPERVISED==='1'){
  effects.continueStartup();return;
 }
 effects.onParse?.([...input.args]);
 const program=createProgram();let updateCommand=false,stopped=false;
 program.action(()=>{});
 program.command('update').allowUnknownOption().allowExcessArguments().option('-v, --verbose','Show verbose output').option('--config <dir>','configuration directory').action(()=>{updateCommand=true;});
 try{program.parse(normalizeCliArgs(input.args),{from:'user'});}catch{stopped=true;}
 const options=program.opts<{update?:boolean;tui?:boolean;kanban?:boolean}>();
 const route:Route={updateCommand,updateFlag:options.update===true,args:[...program.args],tui:options.tui===true,kanban:options.kanban===true,stopped};
 effects.onParsed?.(route);
 if(stopped || (!updateCommand && !route.updateFlag)){effects.continueStartup();return;}
 effects.write(!updateCommand && (route.args.length>0 || route.tui || route.kanban)?'Use --update without a prompt or task flags.':UPSTREAM_UPDATE_DISABLED_MESSAGE);
 effects.terminate(1);
}