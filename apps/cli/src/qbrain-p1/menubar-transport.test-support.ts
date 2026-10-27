// SPDX-License-Identifier: Apache-2.0
// Test-only independent transport/backend. Receives operations, never expected outcomes.
import type { BackgroundContext, StartRequest, SendRequest } from "./menubar-context.test-support";
export type Fault = "none" | "wrong-start-session" | "wrong-send-session" | "changed-prompt" | "changed-result" | "omit-send" | "double-send" | "reorder-effects" | "missing-reply" | "swapped-reply";
export type Command = { command:string; requestId:string; sessionId?:string; payload:Record<string,unknown> };
type State = BackgroundContext & { apiKey?:string };
export interface Port {
  start(input:StartRequest):Promise<{sessionId:string}>;
  send(sessionId:string,input:SendRequest):Promise<unknown>;
  close():void;
}
const copy = <T>(value:T):T => JSON.parse(JSON.stringify(value));
export class ScriptedBackend {
  readonly frames:Command[]=[];
  readonly sessions=new Map<string,State>();
  readonly effects:Array<State & {sessionId:string;prompt:string}>=[];
  readonly results:unknown[]=[];
  readonly replies:Array<{requestId:string;sessionId?:string;payload:unknown}>=[];
  readonly creates=[Promise.withResolvers<void>(),Promise.withResolvers<void>()];
  readonly releaseFirst=Promise.withResolvers<void>();
  readonly firstWaiting=Promise.withResolvers<void>();
  private createCount=0;
  private pendingEffect:(State & {sessionId:string;prompt:string})|undefined;
  constructor(readonly fault:Fault){}
  async command(input:Command):Promise<Record<string,unknown>> {
    const frame=copy(input);
    this.frames.push(frame);
    if(frame.command==="client.register")return {};
    if(frame.command==="session.create"){
      const ordinal=++this.createCount;
      const sessionId=`synthetic-session-${ordinal}`;
      const config=frame.payload.sessionConfig as Record<string,unknown>;
      this.sessions.set(sessionId,{
        workspaceRoot:String(config.workspaceRoot),cwd:String(config.cwd),
        provider:String(config.providerId),model:String(config.modelId),
        apiKey:typeof config.apiKey==="string"?config.apiKey:undefined,
      });
      this.creates[ordinal-1]?.resolve();
      if(ordinal===1){this.firstWaiting.resolve();await this.releaseFirst.promise;}
      const returned=ordinal===1&&this.fault==="wrong-start-session"?"synthetic-session-2":sessionId;
      const payload={session:{sessionId:returned}};
      this.replies.push({requestId:frame.requestId,payload:copy(payload)});
      return payload;
    }
    if(frame.command!=="session.send_input")throw new Error("Unsupported scripted command");
    if(this.fault==="missing-reply")throw new Error("scripted transport response omitted");
    let sessionId=frame.sessionId;
    if(this.fault==="wrong-send-session"&&sessionId==="synthetic-session-1")sessionId="synthetic-session-2";
    const state=this.sessions.get(sessionId??"");
    if(!state)throw new Error("Unknown synthetic session");
    let prompt=String(frame.payload.prompt);
    if(this.fault==="changed-prompt")prompt+=" changed";
    const effect={...state,sessionId:sessionId!,prompt};
    if(this.fault==="reorder-effects"){
      if(!this.pendingEffect)this.pendingEffect=effect;
      else {this.effects.push(effect,this.pendingEffect);this.pendingEffect=undefined;}
    }else this.effects.push(effect);
    if(this.fault==="double-send")this.effects.push(copy(effect));
    const result=this.fault==="changed-result"?{...effect,model:"changed-model"}:
      this.fault==="swapped-reply"?{...effect,sessionId:sessionId==="synthetic-session-1"?"synthetic-session-2":"synthetic-session-1"}:effect;
    this.results.push(copy(result));
    const payload={result};
    this.replies.push({requestId:frame.requestId,sessionId:frame.sessionId,payload:copy(payload)});
    return payload;
  }
}
export async function modelPort(backend:ScriptedBackend):Promise<Port>{
  let count=0,connected=false;
  const command=async(command:string,payload:Record<string,unknown>,sessionId?:string)=>{
    if(!connected){connected=true;await backend.command({command:"client.register",requestId:`model-${++count}`,payload:{clientId:"synthetic-menubar-client"}});}
    return backend.command({command,requestId:`model-${++count}`,sessionId,payload});
  };
  return {
    async start(input){
      const payload=await command("session.create",{
        workspaceRoot:input.workspaceRoot,cwd:input.cwd,
        sessionConfig:{workspaceRoot:input.workspaceRoot,cwd:input.cwd??input.workspaceRoot,providerId:input.provider,modelId:input.model,apiKey:input.apiKey},
      });
      return (payload.session as {sessionId:string});
    },
    async send(sessionId,input){
      if(backend.fault==="omit-send")return {result:undefined};
      const reply=await command("session.send_input",{prompt:input.prompt},sessionId);
      return {result:reply.result};
    },
    close(){},
  };
}
export type PortFactory=(backend:ScriptedBackend)=>Promise<Port>;
// Real baseline client boundary with a scripted socket, no listener or provider is launched.
// Caller orchestration remains source-faithful test model until a real host binding is explicit.
export async function actualTransportPort(backend:ScriptedBackend):Promise<Port>{
  if(backend.fault!=="none")throw new Error("Negative controls stay independently modeled");
  const original=globalThis.WebSocket;
  class ScriptedSocket {
    readyState=0;
    private listeners=new Map<string,Array<(event:unknown)=>void>>();
    constructor(readonly url:string){
      if(url!=="ws://synthetic-menubar.invalid/")throw new Error("Unexpected socket destination");
      queueMicrotask(()=>{this.readyState=1;this.emit("open",{});});
    }
    addEventListener(type:string,listener:(event:unknown)=>void){
      const list=this.listeners.get(type)??[];list.push(listener);this.listeners.set(type,list);
    }
    send(data:string){
      const frame=JSON.parse(data) as {kind:string;envelope:Command};
      if(frame.kind!=="command")throw new Error("Unexpected socket frame");
      void backend.command(frame.envelope).then(payload=>{
        this.emit("message",{data:JSON.stringify({kind:"reply",envelope:{
          version:"v1",requestId:frame.envelope.requestId,command:frame.envelope.command,ok:true,payload,
        }})});
      },error=>this.emit("error",error));
    }
    close(){this.readyState=3;this.emit("close",{code:1000,reason:"synthetic fixture complete"});}
    private emit(type:string,event:unknown){for(const listener of this.listeners.get(type)??[])listener(event);}
  }
  globalThis.WebSocket=ScriptedSocket as unknown as typeof WebSocket;
  try{
    const {HubSessionClient}=await import("../../../../sdk/packages/core/src/hub/client/session-client");
    const client=new HubSessionClient({
      address:"ws://synthetic-menubar.invalid/",authToken:"synthetic-hub-auth",
      clientId:"synthetic-menubar-client",workspaceRoot:"/synthetic/connection",cwd:"/synthetic/connection",
    });
    return {
      start:input=>client.startRuntimeSession(input),
      send:(sessionId,input)=>client.sendRuntimeSession(sessionId,input),
      close(){try{client.close();}finally{globalThis.WebSocket=original;}},
    };
  }catch(error){globalThis.WebSocket=original;throw error;}
}
