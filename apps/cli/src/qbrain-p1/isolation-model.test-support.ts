// SPDX-License-Identifier: Apache-2.0
// Independent test-only adapter: inputs + dependency responses only, no Scenario/expected.
import type { HostProvider, Input, Reply } from "./host-contract";
import { IndependentHostModel } from "./host-model";
import type { CapturedBoundary } from "./isolation-fixture.test-support";
import { join } from "node:path";

export class FilesystemHostModel implements HostProvider {
  private readonly model: IndependentHostModel;
  unchangedAcknowledgment: boolean | undefined;
  constructor(script: Reply[], private readonly io: CapturedBoundary) { this.model=new IndependentHostModel(script); }
  snapshot() { return this.model.snapshot(); }
  async perform(input: Input) {
    const identity=structuredClone(input.binding);
    const home=this.io.env("HOME",identity);
    const root=this.io.env("QB_STATE_ROOT",identity);
    const discovery=this.io.env("QB_HUB_DISCOVERY",identity);
    const credential=this.io.env("QB_DIRECT_CREDENTIAL",identity);
    this.io.root(home,identity); this.io.root(root,identity);
    this.io.read("hub",discovery,identity);
    this.io.read("credential",credential,identity);
    // This actual synthetic journal is separate from the original model's in-memory audit map.
    const journal={binding:identity,request:input.request};
    const path=join(root,"request.json"); this.io.write(path,identity,journal);
    const effects=await this.model.perform(structuredClone(input));
    const persisted=this.model.snapshot().persisted.find(([request])=>request===identity.request)?.[1];
    if(persisted?.result!==undefined) this.io.write(path,identity,{...journal,result:persisted.result});
    this.unchangedAcknowledgment=this.io.finish(identity);
    return effects;
  }
}
