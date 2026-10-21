// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, join } from "node:path";

/** Build a child environment without carrying operator credentials or state. */
export function startupFixtureEnvironment(
	root: string,
	inherited: NodeJS.ProcessEnv,
	extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
	if (!isAbsolute(root)) throw new Error("Fixture root must be absolute");
	for (const key of Object.keys(extra)) {
		if (!/^(https?_proxy|all_proxy|no_proxy)$/i.test(key))
			throw new Error("Unsupported fixture override: " + key);
	}
	const env: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"Path",
		"SystemRoot",
		"WINDIR",
		"ComSpec",
		"PATHEXT",
		"LANG",
		"LC_ALL",
		"TZ",
	]) {
		if (inherited[key] !== undefined) env[key] = inherited[key];
	}
	const fixtureHome = join(root, "home");
	return {
		...env,
		...extra,
		HOME: fixtureHome,
		USERPROFILE: fixtureHome,
		XDG_CONFIG_HOME: join(fixtureHome, ".config"),
		XDG_DATA_HOME: join(fixtureHome, ".local", "share"),
		XDG_CACHE_HOME: join(fixtureHome, ".cache"),
		XDG_STATE_HOME: join(fixtureHome, ".local", "state"),
		APPDATA: join(fixtureHome, "AppData", "Roaming"),
		LOCALAPPDATA: join(fixtureHome, "AppData", "Local"),
		TEMP: join(root, "tmp"),
		TMP: join(root, "tmp"),
		TMPDIR: join(root, "tmp"),
		CLINE_QB_DIR: join(root, "state"),
		CLINE_QB_DATA_DIR: join(root, "state", "data"),
		CLINE_QB_HUB_DISCOVERY_PATH: join(root, "hub.json"),
		CLINE_QB_HUB_PORT: "0",
		CLINE_QB_HUB_HOST: "127.0.0.1",
		CLINE_QB_SIDECAR_PORT: "0",
		CLINE_QB_SIDECAR_HOST: "127.0.0.1",
		// Existing SDK escape hatch prevents account-database shell discovery from
		// sourcing profiles outside the temporary home. Never inherited from caller.
		CLINE_SIDECAR_SKIP_SHELL_PATH: "1",
		NEXT_TELEMETRY_DISABLED: "1",
	};
}
