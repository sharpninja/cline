// SPDX-License-Identifier: Apache-2.0
// Product-test pre-import guard. The PowerShell launcher must already have isolated every consumer process.
import assert from "node:assert/strict";
import { isAbsolute, relative } from "node:path";
const root = process.env.CLINE_QB_D_TEST_ROOT;
assert.ok(root && isAbsolute(root), "exact granted task-owned test root required");
assert.equal(process.env.CLINE_QB_D_EXECUTION_KIND, "baseline-component-observation");
assert.match(process.env.CLINE_QB_D_GRANT_SHA256 ?? "", /^[A-F0-9]{64}$/);
for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "CLINE_QB_DATA_DIR"]) {
  const value = process.env[name];
  assert.ok(value && isAbsolute(value), "pre-import isolated " + name + " required");
  const child = relative(root, value);
  assert.ok(child === "" || (!child.startsWith("..") && !isAbsolute(child)), name + " escaped test ownership");
}
for (const name of Object.keys(process.env)) {
  assert.ok(!/(?:ANTHROPIC|OPENAI|OPENROUTER|CLINE|AZURE|AWS|GOOGLE|GEMINI).*(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name),
    "inherited provider/account credential variable prohibited: " + name);
}
assert.equal(process.env.CLINE_QB_SIDECAR_PORT, "0");
assert.equal(process.env.CLINE_QB_SIDECAR_HOST, "127.0.0.1");

// Baseline component observation has no permitted network or native socket endpoint.
const denyNetwork = () => { throw new Error("Unexpected network access in isolated desktop component fixture"); };
Object.defineProperty(globalThis, "fetch", { configurable: true, value: denyNetwork });
Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class { constructor() { denyNetwork(); } } });

