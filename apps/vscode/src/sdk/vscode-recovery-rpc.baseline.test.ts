// SPDX-License-Identifier: Apache-2.0
// SAME recovery RPC assertions against unchanged host-owned functions.
// Generated protobuf, native transport, SdkController continuation and durable audit are separate gates.
import { it, vi } from "vitest";
import { assertRecoveryRpc, cases } from "./vscode-recovery-rpc.contract.test-support";
import type { Factory } from "./vscode-recovery-rpc.contract.test-support";

const logging = vi.hoisted(() => ({ warn: (_message: string) => {} }));
vi.mock("../shared/services/Logger", () => ({
  Logger: { warn: (message: string) => logging.warn(message), error: () => {} },
}));

import { askResponse } from "../core/controller/task/askResponse";
import { createTaskProxy } from "./task-proxy";
const baseline: Factory = (callback, warn) => {
  logging.warn = warn;
  const sessions = new Map<string, ReturnType<typeof createTaskProxy> | undefined>();
  return {
    configure(context, active) {
      sessions.set(context, active ? createTaskProxy(
        context,
        (text, images, files) => callback(context, text, images as string[], files as string[]),
        async () => {},
      ) : undefined);
    },
    state(context) { return sessions.get(context)?.taskState.askResponse as string | undefined; },
    invoke(context, request) {
      return askResponse(
        { task: sessions.get(context) } as Parameters<typeof askResponse>[0],
        request as Parameters<typeof askResponse>[1],
      );
    },
  };
};
for (const scenario of cases) {
  it("binds SAME recovery RPC assertions to unchanged askResponse/task proxy: " + scenario.name, async () => {
    const evidence = await assertRecoveryRpc(scenario, baseline);
    console.log(JSON.stringify({ kind: "actual-public-recovery-rpc-boundary", evidence }));
  });
}
