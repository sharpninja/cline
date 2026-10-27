// SPDX-License-Identifier: Apache-2.0
// Isolated existing public receiver functions, not a constructed native host or UI.
// SAME fixtures/assertions as independently qualified mock; no SDK/provider/audit use.
import { it, vi } from "vitest";
import { assertReceiver, cases } from "./vscode-receiver-boundary.contract.test-support";
import type { Factory, Registry } from "./vscode-receiver-boundary.contract.test-support";

const holder = vi.hoisted(() => ({ registry: undefined as Registry | undefined }));
vi.mock("../core/controller/grpc-handler", () => ({
  getRequestRegistry: () => {
    if (!holder.registry) throw new Error("unexpected request registry access before fixture binding");
    return holder.registry;
  },
}));
vi.mock("@/shared/services/Logger", () => ({ Logger: { error: () => {} } }));

import { subscribeToPartialMessage, sendPartialMessageEvent } from "../core/controller/ui/subscribeToPartialMessage";
const baseline: Factory = async registry => {
  holder.registry = registry;
  return {
    async subscribe(handler, requestId) {
      // Existing function does not access its controller/request arguments.
      // Opaque callback fixture objects are preserved, not proto-constructed or serialized.
      await subscribeToPartialMessage(
        undefined as unknown as Parameters<typeof subscribeToPartialMessage>[0],
        {} as Parameters<typeof subscribeToPartialMessage>[1],
        handler as unknown as Parameters<typeof subscribeToPartialMessage>[2],
        requestId,
      );
    },
    send(message) {
      return sendPartialMessageEvent(message as unknown as Parameters<typeof sendPartialMessageEvent>[0]);
    },
  };
};
for (const scenario of cases) {
  it(`binds SAME receiver assertions to existing public functions: ${scenario.name}`, async () => {
    const evidence = await assertReceiver(scenario, baseline);
    console.log(JSON.stringify({ kind: "actual-public-receiver-boundary", evidence }));
  });
}
