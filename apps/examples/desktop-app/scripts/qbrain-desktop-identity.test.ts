// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "../src-tauri");
const load = (name: string) =>
	JSON.parse(readFileSync(join(root, name), "utf8"));
const base = load("tauri.conf.json");
test.each([
	"stable",
	"beta",
	"dev",
	"nightly",
])("AC053: %s native identity is independent", (channel) => {
	const overlay =
		channel === "stable" ? {} : load(`tauri.${channel}.conf.json`);
	const config = { ...base, ...overlay };
	const suffix = channel === "stable" ? "" : `.${channel}`;
	expect(config.identifier).toBe(`ai.qbrain.clineqb${suffix}`);
	expect(config.productName).toBe(
		`cline-qb${channel === "stable" ? "" : ` ${channel}`}`,
	);
});
test.each([
	"tauri.conf.json",
	"tauri.windows.conf.json",
])("native window identity in %s is private", (name) => {
	expect(load(name).app.windows[0].title).toBe("cline-qb");
});
test.each([
	"stable",
	"beta",
	"nightly",
])("AppStream identity and filename for %s match its launcher", (channel) => {
	const suffix = channel === "stable" ? "" : `.${channel}`;
	const name = `cline-qb${channel === "stable" ? "" : ` ${channel}`}`;
	const dir = join(root, "linux", "metainfo", channel);
	const files = readdirSync(dir);
	expect(files).toEqual([`ai.qbrain.clineqb${suffix}.metainfo.xml`]);
	const xml = readFileSync(join(dir, files[0]!), "utf8");
	expect(xml).toContain(`<id>ai.qbrain.clineqb${suffix}</id>`);
	expect(xml).toContain(
		`<launchable type="desktop-id">${name}.desktop</launchable>`,
	);
});
test("native executables cannot overwrite upstream Cline or the cline-qb CLI", () => {
	expect(readFileSync(join(root, "Cargo.toml"), "utf8")).toMatch(
		/name = "cline-qb-app"/,
	);
	expect(base.bundle.externalBin).toEqual(["bin/cline-qb-sidecar"]);
});
test("Tauri and web development command use the private origin", () => {
	expect(base.build.devUrl).toBe("http://localhost:32125");
	const pkg = JSON.parse(readFileSync(join(root, "../package.json"), "utf8"));
	expect(pkg.scripts["dev:web"]).toContain("-p 32125");
});
