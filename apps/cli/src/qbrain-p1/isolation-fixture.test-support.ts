// SPDX-License-Identifier: Apache-2.0
// Test-only I/O boundary. All paths and values belong to this fixture, never a real home.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync } from "node:fs";
import { resolve, relative, sep, join, isAbsolute } from "node:path";
import type { Binding, Input } from "./host-contract";

export type Inventory = { path: string; bytes: string; sha256: string }[];
export type Access = { kind: string; target: string; identity: Binding; namespace: string; value: unknown };
export type Fault = "none" | "changed-canary" | "deleted-canary" | "new-external-file" | "false-unchanged" | "unlogged-write" | "root-crossover" | "namespace-crossover" | "identity-crossover" | "hub-crossover" | "credential-crossover" | "upstream-env" | "peer-write" | "forbidden-write" | "missing-storage" | "reordered-access" | "wrong-storage-result" | "wrong-hub-identity" | "wrong-credential-identity" | "changed-env-root" | "missing-access";
export const faults: Fault[] = ["changed-canary","deleted-canary","new-external-file","false-unchanged","unlogged-write","root-crossover","namespace-crossover","identity-crossover","hub-crossover","credential-crossover","upstream-env","peer-write","forbidden-write","missing-storage","reordered-access","wrong-storage-result","wrong-hub-identity","wrong-credential-identity","changed-env-root","missing-access"];
export function inventory(root: string): Inventory {
  const entries: Inventory = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("fixture refuses symlinks");
      if (stat.isDirectory()) walk(path);
      else { const bytes = readFileSync(path); entries.push({path:relative(root,path).split(sep).join("/"),bytes:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex")}); }
    }
  };
  walk(root); return entries;
}
export type Fixture = ReturnType<typeof createFixture>;
export function createFixture(parent: string, input: Input) {
  // Parent is explicitly supplied by the task runner, not os.homedir/process.env.HOME.
  mkdirSync(parent,{recursive:true}); const run = mkdtempSync(join(resolve(parent),"canary-"));
  const active=join(run,"derivative"), original=join(run,"original-synthetic"), peer=join(run,"peer-synthetic");
  for (const root of [active,original,peer]) mkdirSync(join(root,"state"),{recursive:true});
  const seed=(root:string,identity:string)=>{
    writeFileSync(join(root,"canary.bin"),Buffer.from([0,255,13,10,32,9,65,0]));
    writeFileSync(join(root,"state","retained.txt"),`synthetic ${identity}\r\n雪`);
    writeFileSync(join(root,"hub.json"),JSON.stringify({identity,namespace:identity,endpoint:`synthetic://${identity}`}));
    writeFileSync(join(root,"credential.json"),JSON.stringify({identity,provider:"direct-fixture",token:`synthetic-only-${identity}`}));
  };
  seed(original,"original-synthetic"); seed(peer,"peer-synthetic");
  writeFileSync(join(active,"hub.json"),JSON.stringify({identity:"cline-qb",namespace:input.binding.workspace,endpoint:"synthetic://derivative"}));
  writeFileSync(join(active,"credential.json"),JSON.stringify({identity:input.binding.workspace,provider:input.provider,token:"synthetic-only-derivative"}));
  const prepared=structuredClone(input); prepared.home=active; prepared.root=join(active,"state"); prepared.upstream=original;
  const env:Record<string,string>={HOME:active,QB_STATE_ROOT:prepared.root,QB_HUB_DISCOVERY:join(active,"hub.json"),QB_DIRECT_CREDENTIAL:join(active,"credential.json"),CLINE_STATE_DIR:join(original,"state"),CLINE_API_KEY:"synthetic-only-excluded",CLINE_HUB_DISCOVERY:join(original,"hub.json")};
  return {run,active,original,peer,input:prepared,env};
}

export class CapturedBoundary {
  readonly accesses: Access[]=[];
  private count=0;
  private readonly baseline: string;
  constructor(readonly fixture: Fixture, private readonly fault: Fault="none") { this.baseline=JSON.stringify([inventory(fixture.original),inventory(fixture.peer)]); }
  private safe(path:string) { const r=relative(this.fixture.run,resolve(path)); if(isAbsolute(r) || r===".." || r.startsWith(`..${sep}`) || resolve(path)===resolve(this.fixture.run)) throw new Error("outside task-owned fixture"); return resolve(path); }
  private record(kind:string,target:string,identity:Binding,value:unknown) {
    const captured=structuredClone(identity); let namespace=identity.workspace;
    if(this.fault==="identity-crossover") captured.request="peer-request";
    if(this.fault==="namespace-crossover") namespace="original-synthetic";
    const access={kind,target,identity:captured,namespace,value:structuredClone(value)};
    if(this.fault!=="missing-access" || this.count!==0) this.accesses.push(access);
    this.count++;
  }
  env(key:string,identity:Binding) {
    let value=this.fixture.env[key];
    if(this.fault==="changed-env-root" && key==="QB_STATE_ROOT") value=join(this.fixture.original,"state");
    if(this.fault==="reordered-access" && key==="HOME") this.read("hub",join(this.fixture.active,"hub.json"),identity);
    this.record("env",key,identity,value);
    if(this.fault==="upstream-env" && key==="HOME") this.record("env","CLINE_API_KEY",identity,this.fixture.env.CLINE_API_KEY);
    return value;
  }
  root(path:string,identity:Binding) { this.record("root",this.safe(path),identity,null); }
  read(kind:string,path:string,identity:Binding) {
    if(this.fault===`${kind}-crossover`) path=join(this.fixture.original,`${kind}.json`);
    path=this.safe(path); const value=JSON.parse(readFileSync(path,"utf8"));
    if(this.fault==="wrong-hub-identity" && kind==="hub") value.identity="cline";
    if(this.fault==="wrong-credential-identity" && kind==="credential") value.identity="original-synthetic";
    this.record(kind,path,identity,value); return value;
  }
  write(path:string,identity:Binding,value:unknown) {
    if(this.fault==="root-crossover") path=join(this.fixture.original,"state","request.json");
    if(this.fault==="namespace-crossover") path=join(this.fixture.peer,"state","request.json");
    const payload=structuredClone(value) as Record<string,unknown>;
    if(this.fault==="identity-crossover") payload.binding={...identity,request:"peer-request"};
    if(this.fault==="wrong-storage-result" && payload.result) payload.result="summary";
    path=this.safe(path); this.record("storage",path,identity,payload);
    if(this.fault!=="missing-storage") writeFileSync(path,JSON.stringify(payload));
  }
  finish(identity:Binding):boolean {
    const f=this.fixture;
    if(["changed-canary","false-unchanged","unlogged-write"].includes(this.fault)) writeFileSync(this.safe(join(f.original,"canary.bin")),"changed synthetic bytes");
    if(this.fault==="deleted-canary") unlinkSync(this.safe(join(f.original,"canary.bin")));
    if(this.fault==="new-external-file") writeFileSync(this.safe(join(f.original,"new.txt")),"forbidden synthetic file");
    if(this.fault==="peer-write" || this.fault==="forbidden-write") {
      const path=this.safe(join(this.fault==="peer-write"?f.peer:f.original,"state","forbidden.txt"));
      this.record("storage",path,identity,"forbidden"); writeFileSync(path,"forbidden");
    }
    // Access-order control performs a real synthetic hub read before environment/root selection.
    // The acknowledgment is deliberately not accepted as evidence by the assertion runner.
    const unchanged=JSON.stringify([inventory(f.original),inventory(f.peer)])===this.baseline;
    return this.fault==="false-unchanged" ? true : unchanged;
  }
}

