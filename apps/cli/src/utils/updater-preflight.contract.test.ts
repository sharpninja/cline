// SPDX-License-Identifier: Apache-2.0
// FR-QB-006 -> TR-QB-NETWORK-001 -> AC/TEST-QB-016/017.
// Contribution to native UC5 flow9 step9 / flow10 step10 only; full host acceptance remains open.
import { strict as assert, AssertionError } from 'node:assert';
import { describe, expect, it } from 'vitest';
import { runPreflightModel, type PreflightInput, type ParsedUpdateRoute, type ParseResponse, type PreflightFault, type PreflightObservation } from './updater-preflight.test-support';
const disabled='Upstream Cline updates are unavailable in cline-qb. Install a matching reviewed cline-qb build and restart.';
const invalid='Use --update without a prompt or task flags.';
type Disposition='continue'|'disabled'|'invalid';
interface Scenario { name:string; input:PreflightInput; reply?:ParsedUpdateRoute; disposition:Disposition; }
const route=(args:string[]=[],extra:Partial<ParsedUpdateRoute>={}):ParsedUpdateRoute=>({updateCommand:false,updateFlag:false,args,tui:false,kanban:false,stopped:false,...extra});
const scenario=(name:string,args:string[],reply:ParsedUpdateRoute,disposition:Disposition):Scenario=>({name,input:{args,mainThread:true,env:{}},reply,disposition});
// Route facts are independently pinned to the existing createProgram/normalizeCliArgs reference receipt.
const scenarios:Scenario[]=[
 scenario('root flag',['--update'],route([],{updateFlag:true}),'disabled'),
 scenario('subcommand',['update'],route(['update'],{updateCommand:true}),'disabled'),
 scenario('global config before subcommand',['--config','synthetic','update'],route(['update'],{updateCommand:true}),'disabled'),
 scenario('child config after subcommand',['update','--config','synthetic'],route(['update','--config','synthetic'],{updateCommand:true}),'disabled'),
 scenario('config value named update',['--config','update'],route(),'continue'),
 scenario('model value named update',['--model','update'],route(),'continue'),
 scenario('sentinel command matches original Commander',['--','update'],route(['update'],{updateCommand:true}),'disabled'),
 scenario('sentinel literal flag',['--','--update'],route(['--update']),'continue'),
 scenario('task operand named update',['task','update'],route(['task','update']),'continue'),
 scenario('single task string',['update task'],route(['update task']),'continue'),
 scenario('auth option value',['auth','--key','update'],route(['auth']),'continue'),
 scenario('bare thinking normalized',['--thinking','--update'],route([],{updateFlag:true}),'disabled'),
 scenario('thinking value named update',['--thinking','update'],route(),'continue'),
 scenario('legacy autoapprove normalized',['--autoapprove','--update'],route([],{updateFlag:true}),'disabled'),
 scenario('unknown option remains normal error',['--unknown','update'],route(['--unknown','update'],{stopped:true}),'continue'),
 scenario('root update with task preserves diagnostic',['--update','task'],route(['task'],{updateFlag:true}),'invalid'),
 scenario('root update with tui preserves diagnostic',['--update','--tui'],route([],{updateFlag:true,tui:true}),'invalid'),
 scenario('root update with kanban preserves diagnostic',['--update','--kanban'],route([],{updateFlag:true,kanban:true}),'invalid'),
 scenario('update help remains original help',['update','--help'],route(['update','--help'],{stopped:true}),'continue'),
 scenario('root help remains original help',['--help'],route(['--help'],{stopped:true}),'continue'),
 scenario('version remains original version',['--version'],route([],{stopped:true}),'continue'),
 scenario('connector option value',['connect','--channel','update'],route(['connect','--channel','update'],{stopped:true}),'continue'),
];
for(const legacy of ['false','true'])for(const arg of ['--update','update']){
 const base=scenarios[arg==='update'?1:0];scenarios.push({...base,name:`legacy=${legacy} ${arg}`,input:{...base.input,env:{CLINE_NO_AUTO_UPDATE:'0',CLINE_UPDATE_FIXTURE_LEGACY:legacy}}});
}
for(const [name,input] of [
 ['worker',{args:['--update'],mainThread:false,env:{}}],
 ['hub personality',{args:['update'],mainThread:true,env:{CLINE_RUN_AS_HUB_DAEMON:'1'}}],
 ['supervised connector',{args:['update'],mainThread:true,env:{CLINE_CONNECTOR_SUPERVISED:'1'}}],
] as const)scenarios.push({name,input:{args:[...input.args],mainThread:input.mainThread,env:{...input.env}},disposition:'continue'});
const provider=process.env.CLINE_PREFLIGHT_PROVIDER ?? 'Mock';
async function observe(s:Scenario,fault:PreflightFault='none',responseChange?:'missing'|'wrong-args'|'wrong-result'|'extra'){
 const responses:ParseResponse[]=s.reply?[{args:[...s.input.args],result:{...s.reply,args:[...s.reply.args]}}]:[];
 if(responseChange==='missing')responses.splice(0);
 if(responseChange==='wrong-args')responses[0].args=['different'];
 if(responseChange==='wrong-result')responses[0].result=route(['unexpected']);
 if(responseChange==='extra')responses.push({args:[],result:route()});
 try{
  if(provider==='Production' && fault==='none' && !responseChange){
   const modulePath='./updater-preflight';const actual=await import(modulePath);
   const effects:Array<Record<string,unknown>>=[];let terminated=false,continued=false,exitCode:number|undefined;
   let consumed=0;
   actual.runUpdaterPreflight(s.input,{
    onParse:(args:string[])=>{effects.push({kind:'parse',args:[...args]});consumed++;},
    onParsed:(r:ParsedUpdateRoute)=>effects.push({kind:'parsed',route:r}),
    write:(message:string)=>effects.push({kind:'write',message}),
    terminate:(code:number)=>{effects.push({kind:'exit',code});terminated=true;exitCode=code;},
    continueStartup:()=>{effects.push({kind:'bootstrap'});continued=true;},
   });
   return {observation:{effects,consumed,remaining:0,terminated,exitCode,continued} as PreflightObservation,error:undefined};
  }
  return {observation:runPreflightModel(s.input,responses,fault),error:undefined};
 }catch(error){return {observation:undefined,error:String(error)};}
}
function assertObserved(s:Scenario,observed:Awaited<ReturnType<typeof observe>>){
 assert.equal(observed.error,undefined);assert.ok(observed.observation);const o=observed.observation;
 const prefix=s.reply?[{kind:'parse',args:s.input.args},{kind:'parsed',route:s.reply}]:[];
 const refused=s.disposition!=='continue';
 const tail=refused?[{kind:'write',message:s.disposition==='invalid'?invalid:disabled},{kind:'exit',code:1}]:[{kind:'bootstrap'}];
 assert.deepEqual(o.effects,[...prefix,...tail]);assert.equal(o.consumed,s.reply?1:0);assert.equal(o.remaining,0);
 assert.equal(o.terminated,refused);assert.equal(o.exitCode,refused?1:undefined);assert.equal(o.continued,!refused);
}
describe(`updater pre-storage refusal boundary (${provider})`,()=>{
 for(const s of scenarios){
  it(s.name,async()=>{const observed=await observe(s);assertObserved(s,observed);console.log('C_PREFLIGHT_INTERACTIONS '+JSON.stringify({name:s.name,input:s.input,observed}));});
  const faults:PreflightFault[]=!s.reply?['omit-bootstrap']:s.disposition==='continue'?['early-bootstrap','changed-args','force-refusal','omit-bootstrap']:['omit-parse','changed-args','early-bootstrap','wrong-message','wrong-exit','double-write','double-exit','post-exit-bootstrap','false-continue'];
  for(const fault of faults)it(`${s.name} rejects executed ${fault}`,async()=>{let rejected:unknown;try{assertObserved(s,await observe(s,fault));}catch(e){rejected=e;}expect(rejected).toBeInstanceOf(AssertionError);});
 }
 for(const change of ['missing','wrong-args','wrong-result','extra'] as const)it(`same assertions reject parser response ${change}`,async()=>{let rejected:unknown;try{assertObserved(scenarios[0],await observe(scenarios[0],'none',change));}catch(e){rejected=e;}expect(rejected).toBeInstanceOf(AssertionError);});
});
