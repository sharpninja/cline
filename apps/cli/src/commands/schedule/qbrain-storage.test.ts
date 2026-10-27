// Actual default Core manager constructor, synthetic test namespace and real task-owned files.
// This is not the private governance policy, Windows Known Folder, native host or provider acceptance.
import assert from "node:assert/strict";
import { dirname, join, resolve, sep } from "node:path";
import { it, vi } from "vitest";
import { assertConstructorIsolation, type StorageAccess } from "../../qbrain-p1/provider-constructor-isolation.contract.test";

const capture = vi.hoisted(() => ({
  enabled: false, parent: "", accesses: [] as StorageAccess[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const wrapped: Record<string, unknown> = { ...actual };
  for (const name of ["existsSync", "readFileSync", "writeFileSync", "renameSync", "mkdirSync", "chmodSync", "unlinkSync", "readdirSync", "statSync", "openSync"]) {
    const original = actual[name as keyof typeof actual];
    if (typeof original !== "function") throw new Error("Missing actual filesystem function " + name);
    wrapped[name] = (...args: unknown[]) => {
      if (capture.enabled) {
        for (const value of (name === "renameSync" ? args.slice(0, 2) : args.slice(0, 1))) {
          if (typeof value !== "string") throw new Error("Uncaptured non-string storage path");
          const path = resolve(value);
          // All storage effects must stay inside this task-owned fixture even on regression.
          if (path !== capture.parent && !path.startsWith(capture.parent + sep)) {
            throw new Error("Refused non-fixture storage access " + name);
          }
          capture.accesses.push({ operation: name, path });
        }
      }
      return Reflect.apply(original, undefined, args);
    };
  }
  return wrapped;
});

it("default manager resolves namespaced storage before legacy overrides, including migration and custom registry probes", async () => {
  await assertConstructorIsolation(async (input) => {
    const envNames = ["CLINE_DIR", "CLINE_DATA_DIR", "CLINE_PROVIDER_SETTINGS_PATH"] as const;
    const prior = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
    process.env.CLINE_DIR = input.original;
    process.env.CLINE_DATA_DIR = input.original;
    process.env.CLINE_PROVIDER_SETTINGS_PATH = join(input.original, "settings", "providers.json");
    try {
      const { registerStorageNamespace } = await import("@cline/shared/storage");
      registerStorageNamespace({
        validatePath: (path) => {
          const absolute = resolve(path);
          if (!absolute.startsWith(resolve(input.derivative) + sep) && absolute !== resolve(input.derivative)) {
            throw new Error("Test namespace refuses non-derivative storage");
          }
          return absolute;
        },
        resolvePath: (kind) => {
          if (kind === "providerSettings") return input.providerPath;
          if (kind === "data") return input.derivative;
          if (kind === "root") return dirname(input.derivative);
          return join(input.derivative, kind);
        },
        globalRulesPaths: () => [],
      });
      // Import before enabling constructor-only capture. Module loading is a separate open boundary.
      const { ProviderSettingsManager } = await import("@cline/core");
      capture.parent = resolve(input.parent);
      capture.accesses = [];
      capture.enabled = true;
      try {
        const manager = new ProviderSettingsManager();
        const state = manager.read();
        assert.equal(manager.getFilePath(), input.providerPath);
        return {
          filePath: manager.getFilePath(), providers: state.providers,
          accesses: structuredClone(capture.accesses), acknowledgedUnchanged: true,
        };
      } finally { capture.enabled = false; }
    } finally {
      for (const name of envNames) {
        const value = prior[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
