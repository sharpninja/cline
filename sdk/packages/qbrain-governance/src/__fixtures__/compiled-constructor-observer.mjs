// SPDX-License-Identifier: Apache-2.0
/** Test-only debugger observation of an UNMODIFIED compiled core bundle.
 * No expected journal/case names enter this observer. Every row requires an
 * actual V8 function-call breakpoint. No remote debugger or rewritten bundle.
 * Not execution evidence until the pinned native child has actually run.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector";

export function observeCompiledConstructor(core, bundleSource, bundleUrl) {
  const session = new Session();
  const rows = [], failures = [];
  const breakpoints = new Map(), retained = new Map();
  let ordinal = 0, discovering = false;
  session.connect();
  function post(method, params = {}) {
    let result, error, completed = false;
    session.post(method, params, (failure, value) => {
      error = failure; result = value; completed = true;
    });
    assert.ok(completed, "CAPTURE: inspector callback must be synchronous");
    if (error) throw error;
    return result;
  }
  function install(objectId, label, expression) {
    assert.ok(objectId, "CAPTURE: missing function identity");
    const { breakpointId } = post("Debugger.setBreakpointOnFunctionCall", { objectId });
    assert.ok(breakpointId && !breakpoints.has(breakpointId), "CAPTURE: duplicate/missing breakpoint");
    breakpoints.set(breakpointId, { label, expression });
  }
  const handles = [
    ["core.create", core.ClineCore.create, "({distinctId:arguments[0]?.distinctId,backendMode:arguments[0]?.backendMode})"],
    ["provider.migration", core.migrateLegacyProviderSettings, "({data:arguments[0]?.dataDir})"],
    ["provider.custom.load", core.ensureCustomProvidersLoadedSync, "({providerSettingsPath:arguments[0]?.getFilePath()})"],
    ["provider.rawRead", core.ProviderSettingsManager.prototype.read, "({path:this.getFilePath()})"],
    ["provider.lastUsed", core.ProviderSettingsManager.prototype.getLastUsedProviderSettings, "({path:this.getFilePath()})"],
    ["provider.get", core.ProviderSettingsManager.prototype.getProviderSettings, "({path:this.getFilePath(),provider:arguments[0]})"],
    ["oauth.construct", core.RuntimeOAuthTokenManager, "({providerSettingsPath:arguments[0]?.providerSettingsManager?.getFilePath()})"],
  ];
  // Resolve lexical registration from the ORIGINAL exported constructor.
  const text = Function.prototype.toString.call(core.ProviderSettingsManager);
  const matches = [...text.matchAll(/([A-Za-z_$][\w$]*)\(this\.read\(\)\)/g)];
  assert.equal(matches.length, 1, "CAPTURE: constructor registration boundary changed");
  const registrationName = matches[0][1];
  const marker = '"Detached command log recovery failed"';
  const offset = bundleSource.indexOf(marker);
  assert.ok(offset >= 0 && bundleSource.indexOf(marker, offset + 1) < 0,
    "CAPTURE: recovery source correspondence is not unique");
  const declarations = [...bundleSource.slice(0, offset).matchAll(/function ([A-Za-z_$][\w$]*)\([^)]*\)\{/g)];
  const recoveryName = declarations.at(-1)?.[1];
  assert.ok(recoveryName, "CAPTURE: missing original recovery declaration");
  const internal = [
    [registrationName, "provider.registerConfigured", "arguments[0]"],
    [recoveryName, "detached.recover", "({})"],
  ];
  session.on("Debugger.paused", ({ params }) => {
    try {
      const frame = params.callFrames[0];
      assert.ok(frame, "CAPTURE: missing original function frame");
      const observed = (params.hitBreakpoints ?? []).map((id) => breakpoints.get(id)).filter(Boolean);
      assert.equal(observed.length, 1, "CAPTURE: pause is not one owned function call");
      const point = observed[0];
      const result = post("Debugger.evaluateOnCallFrame", {
        callFrameId: frame.callFrameId, expression: point.expression,
        returnByValue: true, silent: true,
      });
      assert.equal(result.exceptionDetails, undefined, "CAPTURE: frame observation failed");
      rows.push({ order: ++ordinal, operation: point.label, data: result.result.value,
        location: frame.location,
        stack: params.callFrames.map(({ functionName, location, url }) => ({ functionName, location, url })),
      });
      // Resolve original lexical functions while paused in the compiled bundle.
      // Breakpoints observe subsequent calls without replacing those functions.
      if (!discovering && retained.size !== internal.length) {
        discovering = true;
        for (const [name, label, expression] of internal) {
          if (retained.has(label)) continue;
          const candidate = post("Debugger.evaluateOnCallFrame", {
            callFrameId: frame.callFrameId, expression: name, silent: true,
          });
          assert.equal(candidate.exceptionDetails, undefined, "CAPTURE: lexical function unavailable: " + label);
          assert.equal(candidate.result.type, "function", "CAPTURE: lexical target is not a function");
          install(candidate.result.objectId, label, expression);
          retained.set(label, candidate.result.objectId);
        }
        discovering = false;
      }
    } catch (error) {
      failures.push({ message: String(error?.stack ?? error) });
    } finally {
      post("Debugger.resume");
    }
  });
  post("Runtime.enable");
  post("Debugger.enable");
  // A temporary private handle obtains V8 function identities only. It neither
  // invokes product methods nor mutates product closures or application state.
  const slot = Symbol("constructor observer handles");
  const holder = {};
  globalThis[slot] = holder;
  const slotIndex = Object.getOwnPropertySymbols(globalThis).indexOf(slot);
  try {
    for (const [label, fn, expression] of handles) {
      assert.equal(typeof fn, "function", "CAPTURE: missing compiled export: " + label);
      holder.fn = fn;
      const remote = post("Runtime.evaluate", {
        expression: `globalThis[Object.getOwnPropertySymbols(globalThis)[${slotIndex}]].fn`,
      });
      assert.equal(remote.result.type, "function", "CAPTURE: observer handle is not a function");
      install(remote.result.objectId, label, expression);
    }
  } catch (error) {
    session.disconnect();
    throw error;
  } finally {
    delete holder.fn;
    delete globalThis[slot];
  }
  return {
    rows, failures,
    correspondence: { bundleUrl, registrationName, recoveryName, exportedCallPoints: handles.map(([label]) => label) },
    assertHealthy() {
      assert.deepEqual(failures, [], "CAPTURE: incomplete debugger observation");
      assert.equal(retained.size, internal.length, "CAPTURE: private boundaries were not installed");
    },
    close() { session.disconnect(); },
  };
}
