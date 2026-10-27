import { it } from "vitest";
import { runActivationMockGate } from "./schedule-activation.contract.test-support";

it("proves corrected explicit-state activation assertions with independent input-only interactions", async () => {
  const result = await runActivationMockGate("F:/synthetic-task-owned-c-activation-model");
  console.log(JSON.stringify({
    evidenceKind: "independent input-only explicit-state activation gate",
    ...result,
    actualSQLitePersistence: false,
    actualNativeHost: false,
    actualProviderExecution: false,
  }));
});
