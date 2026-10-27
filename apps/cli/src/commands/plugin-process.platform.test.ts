import type { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { registerPackageCommand, resetPackageCommands, subprocessEffects, withPackageCommandFixtures } from "./plugin-process.test-support";

type Input = { platform: NodeJS.Platform; registered: boolean };
type Fault = "none" | "wrong-platform" | "missing-registration" | "extra-registration" | "wrong-stderr" | "wrong-code" | "reordered-native-callbacks";
const command = "F:/synthetic-package/fixture.sh";
const args = ["install", "--prefix", "F:/synthetic-package/install"];
const options = { cwd: "F:/synthetic-package/workspace" };

async function observe(input: Input, fault: Fault) {
 resetPackageCommands();
 const nativeCalls: { command: unknown; args: unknown; options: unknown }[] = [];
 const callbackOrder: string[] = [];
 const native = ((command: string, args: readonly string[], options: object) => {
  nativeCalls.push({ command, args, options });
  const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
  child.stderr = new PassThrough();
  queueMicrotask(() => {
   if (fault === "reordered-native-callbacks") { child.emit("close", 37); child.stderr.write("native-response"); }
   else { child.stderr.write("native-response"); child.emit("close", 37); }
  });
  return child;
 }) as unknown as typeof spawn;
 const registered = fault === "missing-registration" ? false : fault === "extra-registration" ? true : input.registered;
 if (registered) registerPackageCommand(command, { exitCode: fault === "wrong-code" ? 0 : 1, stderr: fault === "wrong-stderr" ? "wrong-response" : "scripted-response" });
 const platform = fault === "wrong-platform" ? input.platform === "win32" ? "linux" : "win32" : input.platform;
 const child = withPackageCommandFixtures(native, platform)(command, args, options);
 let stderr = "";
 child.stderr!.on("data", chunk => { callbackOrder.push("data"); stderr += String(chunk); });
 child.on("close", () => { callbackOrder.push("close"); });
 const [code] = await once(child, "close");
 const observed = { code, stderr, nativeCalls, callbackOrder, effects: structuredClone(subprocessEffects) };
 console.log("C_PACKAGE_PLATFORM_MOCK " + JSON.stringify({ input, fault, observed }));
 return observed;
}
function assertRoute(input: Input, observed: Awaited<ReturnType<typeof observe>>) {
 const modeled = input.platform === "win32" && input.registered;
 expect(observed.code).toBe(modeled ? 1 : 37);
 expect(observed.stderr).toBe(modeled ? "scripted-response" : "native-response");
 expect(observed.callbackOrder).toEqual(["data", "close"]);
 expect(observed.nativeCalls).toHaveLength(modeled ? 0 : 1);
 if (modeled) {
  expect(observed.effects).toEqual([
   { kind: "spawn", command, args, cwd: options.cwd },
   { kind: "stderr", text: "scripted-response" },
   { kind: "close", code: 1 },
  ]);
 } else {
  expect(observed.nativeCalls[0]).toEqual({ command, args, options });
  expect(observed.nativeCalls[0]!.options).toBe(options);
  expect(observed.effects).toEqual([]);
 }
}

describe("package fixture platform parity through actual spawn seam", () => {
 for (const input of [
  { platform: "win32", registered: true },
  { platform: "linux", registered: true },
  { platform: "darwin", registered: true },
  { platform: "win32", registered: false },
 ] as const) {
  it(`${input.platform}/${input.registered} preserves modeled or native effects`, async () => {
   assertRoute(input, await observe(input, "none"));
  });
 }
 for (const [input, fault] of [
  [{ platform: "win32", registered: true }, "wrong-platform"],
  [{ platform: "linux", registered: true }, "wrong-platform"],
  [{ platform: "win32", registered: true }, "missing-registration"],
  [{ platform: "win32", registered: false }, "extra-registration"],
  [{ platform: "win32", registered: true }, "wrong-stderr"],
  [{ platform: "win32", registered: true }, "wrong-code"],
  [{ platform: "linux", registered: true }, "reordered-native-callbacks"],
 ] as const) {
  it(`${input.platform}/${input.registered} rejects actual ${fault} through same assertions`, async () => {
   const observed = await observe(input, fault);
   expect(() => assertRoute(input, observed)).toThrow();
  });
 }
});