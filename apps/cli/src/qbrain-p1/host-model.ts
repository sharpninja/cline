// SPDX-License-Identifier: Apache-2.0
// Independent test-only state machine; receives no Scenario or expected values.
import type {Binding, Effect, HostProvider, Input, Reply} from "./host-contract";

export class IndependentHostModel implements HostProvider {
  private effects: Effect[]=[];
  private index=0;
  private open=new Map<string,Binding>();
  private storage=new Map<string,{home:string;port:number}>();
  private persisted=new Map<string,{binding:Binding;request:string;result?:string}>();
  private providerCalls:unknown[]=[];
  private deliveries:{binding:Binding;text:string}[]=[];
  snapshot(){return structuredClone({storage:[...this.storage],persisted:[...this.persisted],providerCalls:this.providerCalls,deliveries:this.deliveries,open:[...this.open]});}
  constructor(private readonly script: Reply[]) {}
  private emit(kind:string,value:unknown):void {this.effects.push({kind,value:structuredClone(value)});}
  private exchange(boundary:string,value:unknown):any {
    this.emit(boundary,value);
    if(boundary==="provider")this.providerCalls.push(structuredClone(value));
    const response=this.script[this.index++];
    if (!response || response.boundary!==boundary) throw new Error(`callback-order:${boundary}`);
    if (response.value instanceof Error) throw response.value;
    return structuredClone(response.value);
  }
  private same(a:Binding,b:Binding):boolean {
    return ["workspace","nativeSession","agent","session","request","event","policy"].every(k=>a?.[k as keyof Binding]===b?.[k as keyof Binding]);
  }
  async perform(input:Input):Promise<Effect[]> {
    this.effects=[];this.index=0;
    const protect=(text:string)=>{let value=text;for(const secret of input.secrets){if(secret)value=value.replaceAll(secret,"[REDACTED]");}return value.replace(/[\u2013\u2014]/g,"-");};
    const requestText=protect(input.request);
    const block=(reason:string)=>{this.emit("blocked",reason);this.emit("canary",input.canary);return this.effects;};
    // Synthetic storage is selected before any simulated consumer initializes.
    if(input.root===input.upstream || input.root.startsWith(input.upstream+"/")) return block("upstream-storage");
    this.storage.set(input.root,{home:input.home,port:input.port});
    const selected=this.storage.get(input.root)!;
    this.emit("storage",{home:selected.home,root:input.root,port:selected.port});
    try {
      const assets=this.exchange("assets",null);
      if(!assets?.pin || !assets.runtime || !assets.modules)return block("assets");
      const trust=this.exchange("trust",{workspace:input.binding.workspace});
      if(!trust?.verified || trust.policy!==input.binding.policy)return block("trust");
      const hub=this.exchange("hub",{port:input.port});
      if(hub?.identity!=="cline-qb" || hub.policy!==input.binding.policy)return block("hub-identity");
      const guidance=this.exchange("guidance",null);
      if(!guidance?.skills?.length || !guidance.memory || !guidance.requirements?.length)return block("guidance");
      const ingress=this.exchange("ingress",{binding:input.binding,text:requestText});
      if(ingress?.code!=="persisted" || ingress.revision<=0 || !this.same(ingress.binding,input.binding))return block("ingress");
      this.open.set(input.binding.request,structuredClone(input.binding));
      this.persisted.set(input.binding.request,{binding:structuredClone(input.binding),request:requestText});
      const authorization=this.exchange("authorize",{binding:input.binding,operation:input.operation,overrides:input.overrides});
      if(!authorization?.allow || authorization.policy!==input.binding.policy)return block("authorization");
      if(["cline","cline-pass",""].includes(input.provider) || !input.model)return block("configure-direct-provider");
      const result=this.exchange("provider",{binding:input.binding,provider:input.provider,model:input.model,proxy:input.proxy,guidance,request:requestText});
      if(result?.provider!==input.provider || result.model!==input.model || typeof result.text!=="string")return block("provider-selection");
      result.text=protect(result.text);
      const receipt=this.exchange("audit",{binding:input.binding,text:result.text});
      if(receipt?.code!=="persisted" || receipt.revision<=0 || !this.same(receipt.binding,input.binding) || receipt.text!==result.text)return block("audit");
      this.persisted.get(input.binding.request)!.result=receipt.text;
      if(!receipt.decision || !receipt.verification || !receipt.title || receipt.title==="User prompt")return block("obligations");
      const completion=this.exchange("completion",{binding:input.binding});
      if(!completion?.allow || completion.policy!==input.binding.policy)return block("completion");
      const delivery=this.exchange("delivery",{binding:input.binding,text:result.text});
      if(!delivery?.delivered)return block("delivery");
      this.deliveries.push({binding:structuredClone(input.binding),text:result.text});
      this.open.delete(input.binding.request);
      this.emit("success",{request:input.binding.request});
      this.emit("canary",input.canary);
      if(this.index!==this.script.length)throw new Error("unexpected-callback");
      return this.effects;
    }catch(error){return block(error instanceof Error?error.message:"dependency-failure");}
  }
}
