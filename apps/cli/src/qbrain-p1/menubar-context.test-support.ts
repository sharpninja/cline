// SPDX-License-Identifier: Apache-2.0
// Independent input/dependency-only background launch model. No actual host imports.
export type BackgroundContext={workspaceRoot:string;cwd?:string;provider:string;model:string};
export type StartRequest=BackgroundContext & {apiKey?:string;enableTools:boolean;enableSpawn:boolean;enableTeams:boolean;autoApproveTools:boolean;source:string;interactive:boolean};
export type SendRequest={config:Omit<StartRequest,"autoApproveTools"|"source"|"interactive">;prompt:string};
export interface BackgroundDependencies {
  context():BackgroundContext|undefined;
  auth(provider:string):{apiKey?:string};
  start(input:StartRequest):Promise<{sessionId:string}>;
  send(sessionId:string,input:SendRequest):Promise<void>;
  notify(body:string):void;
}
export type BackgroundLaunch=(prompt:string,dependencies:BackgroundDependencies)=>Promise<void>;
export const capturedBackgroundLaunch:BackgroundLaunch=async(prompt,d)=>{
  const text=prompt.trim();if(!text)return;
  const current=d.context();if(!current){d.notify("No recent workspace and model context is available yet.");return;}
  // Capture values before asynchronous work. This model receives no scenario/expected object.
  const context={...current},cwd=context.cwd??context.workspaceRoot;
  try {
    const auth=d.auth(context.provider);
    const config={workspaceRoot:context.workspaceRoot,cwd,provider:context.provider,model:context.model,apiKey:auth.apiKey,enableTools:true,enableSpawn:false,enableTeams:true};
    const started=await d.start({...config,autoApproveTools:true,source:"cline-menubar",interactive:false});
    await d.send(started.sessionId,{config,prompt:text});
  }catch(error){d.notify(error instanceof Error?error.message:String(error));}
};
// Source-faithful countermodel for index.ts:614-637. It deliberately rereads mutable
// context after await. Rejection is diagnostic model evidence, not execution of that module.
export const rereadingBackgroundLaunch:BackgroundLaunch=async(prompt,d)=>{
  const text=prompt.trim();if(!text)return;
  if(!d.context()){d.notify("No recent workspace and model context is available yet.");return;}
  try {
    const cwd=d.context()!.cwd??d.context()!.workspaceRoot;
    const auth=d.auth(d.context()!.provider);
    const started=await d.start({workspaceRoot:d.context()!.workspaceRoot,cwd,provider:d.context()!.provider,model:d.context()!.model,apiKey:auth.apiKey,enableTools:true,enableSpawn:false,enableTeams:true,autoApproveTools:true,source:"cline-menubar",interactive:false});
    await d.send(started.sessionId,{config:{workspaceRoot:d.context()!.workspaceRoot,cwd,provider:d.context()!.provider,model:d.context()!.model,apiKey:auth.apiKey,enableTools:true,enableSpawn:false,enableTeams:true},prompt:text});
  }catch(error){d.notify(error instanceof Error?error.message:String(error));}
};
