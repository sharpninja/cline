// SPDX-License-Identifier: Apache-2.0
/** Independent requirement/pinned-call-semantics fixtures; no model output. */
import type { Scenario } from "./p1-native-member-contract";
export function nativeMemberScenarios(): Scenario[] {
  const cases: Scenario[] = [];
  const payloads: unknown[] = ["  # native\r\n漢字\\u2014\r\t終\n", new Uint8Array([0, 13, 10, 92, 117, 50, 48, 49, 52, 255]), { exact: "\r\n**Markdown** \\n \\u2014", immutableSentinel: true }];
  for (let mask = 0; mask < 12; mask++) {
    const flags = { enumerable: !!(mask & 1), configurable: !!(mask & 2), writable: !!(mask & 4) };
    const secondReceiver = mask % 3 === 0 ? "member" : mask % 3 === 1 ? "foreign" : "detached";
    const input: Scenario["input"] = {
      flags,
      invocations: [
        { receiver: "member", args: ["C:/synthetic/一\r\n  a\\u2014", { encoding: "utf8", literal: " \t**first**\r\n" }] },
        { receiver: secondReceiver, args: ["C:/synthetic/b\r c\n漢字", { encoding: "buffer", literal: "\\n \\u2014" }] },
      ],
      replies: [{ kind: "return", value: payloads[mask % payloads.length] }, { kind: "throw", value: new Error("synthetic native failure\r\n漢字\\u2014") }],
      foreign: { syntheticReceiver: mask },
    };
    cases.push({ id: "descriptor-" + mask + "/" + secondReceiver,
      input, expectedReceivers: ["original", secondReceiver === "member" ? "original" : secondReceiver === "foreign" ? "foreign" : "undefined"],
      expectedPhases: ["call", "return", "call", "throw"], expectedJournal: ["emit:call", "native:call", "native:return", "emit:return", "emit:call", "native:call", "native:throw", "emit:throw"] });
  }
  return cases;
}
