// SPDX-License-Identifier: Apache-2.0
/** Independent test-only forwarding model; never imports scenarios/expectations. */
import type { Adapter, Emission, Fault, Member } from "./p1-native-member-contract";
export const nativeMemberModel: Adapter = {
  bind(original, emit, exercised, fault) {
    if (fault === "unrelated-crash") throw new Error("UNRELATED_MODEL_CRASH");
    const marked = new Set<Fault>();
    const mark = (value: Fault) => { if (!marked.has(value)) { marked.add(value); exercised(value); } };
    const descriptor = Object.getOwnPropertyDescriptor(original, "native");
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("MODEL: scripted native dependency required");
    const dependency = descriptor.value as (...args: unknown[]) => unknown;
    const bound: Member = function (this: unknown, ...args) { return Reflect.apply(original, this, args); };
    if (fault === "omit-native") { mark(fault); return bound; }
    const flags = { enumerable: descriptor.enumerable, configurable: descriptor.configurable, writable: descriptor.writable };
    for (const [key, bad] of [["enumerable", "wrong-enumerable"], ["configurable", "wrong-configurable"], ["writable", "wrong-writable"]] as const) {
      if (fault === bad) { flags[key] = !flags[key]; mark(bad); }
    }
    let deferred: { args: unknown[]; receiver: unknown } | undefined;
    const send = (event: Emission) => {
      if (fault === "omit-emission") { mark(fault); return; }
      emit(event);
      if (fault === "duplicate-emission") { mark(fault); emit(event); }
    };
    const native = function (this: unknown, ...incoming: unknown[]) {
      let args = incoming, receiver = this === bound ? original : this;
      if (fault === "wrong-receiver") { receiver = null; mark(fault); }
      if (fault === "drop-argument") { args = args.slice(0, 1); mark(fault); }
      if (fault === "wrong-path") { args = [String(args[0]).replace(/\r\n/g, "\n") + "-wrong", ...args.slice(1)]; mark(fault); }
      if (fault === "wrong-options") { args = [args[0], { encoding: "wrong", literal: "wrong" }]; mark(fault); }
      if (fault === "clone-options") { args = [args[0], structuredClone(args[1])]; mark(fault); }
      if (fault === "mutate-input" && args[1] && typeof args[1] === "object") {
        (args[1] as { literal: string }).literal += "-changed"; mark(fault);
      }
      const call: Emission = { phase: "call", args };
      if (fault !== "reorder-emission" && fault !== "late-call-emission") send(call);
      try {
        let result: unknown;
        if (fault === "omit-call") { mark(fault); result = undefined; }
        else if (fault === "reorder-calls") {
          if (!deferred) { deferred = { args, receiver }; result = undefined; }
          else {
            mark(fault);
            Reflect.apply(dependency, receiver, args);
            result = Reflect.apply(dependency, deferred.receiver, deferred.args);
          }
        } else {
          result = Reflect.apply(dependency, receiver, args);
          if (fault === "duplicate-call") { mark(fault); Reflect.apply(dependency, receiver, args); }
        }
        if (fault === "wrong-result") { mark(fault); result = { wrongResult: true }; }
        if (fault === "late-call-emission") { mark(fault); send(call); }
        send({ phase: "return", value: result });
        if (fault === "reorder-emission") { mark(fault); send(call); }
        return result;
      } catch (error) {
        const forwarded = fault === "wrong-error" ? new Error(error instanceof Error ? error.message : String(error)) : error;
        if (fault === "wrong-error") mark(fault);
        if (fault === "late-call-emission") { mark(fault); send(call); }
        send({ phase: "throw", value: forwarded });
        if (fault === "reorder-emission") { mark(fault); send(call); }
        throw forwarded;
      }
    };
    Object.defineProperty(bound, "native", { ...flags, value: fault === "non-callable-native" ? 0 : native });
    if (fault === "non-callable-native") mark(fault);
    return bound;
  },
};
