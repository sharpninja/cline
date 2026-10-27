// SPDX-License-Identifier: Apache-2.0
// Read-only reference of the existing pure Commander definition and normalizer.
import { it } from 'vitest';
import { createProgram } from '../commands/program';
import { normalizeCliArgs } from './helpers';
it('records existing updater routing without importing the CLI entrypoint',async()=>{
 for(const args of [['--update'],['update'],['--config','synthetic','update'],['update','--config','synthetic'],['--config','update'],['--model','update'],['--','update'],['--','--update'],['task','update'],['update task'],['auth','--key','update'],['--thinking','--update'],['--thinking','update'],['--autoapprove','--update'],['--unknown','update'],['--update','task'],['--update','--tui'],['update','--help'],['--help'],['--version'],['connect','--channel','update']]){
  const program=createProgram();let updateCommand=false,error:string|undefined;
  program.action(()=>{});program.command('update').allowUnknownOption().allowExcessArguments().option('-v, --verbose').option('--config <dir>').action(()=>{updateCommand=true;});
  try{await program.parseAsync(normalizeCliArgs(args),{from:'user'});}catch(e){error=(e as {code?:string}).code ?? String(e);}
  console.log('C_UPDATER_ROUTE_REFERENCE '+JSON.stringify({args,updateCommand,opts:program.opts(),operands:program.args,error}));
 }
});
