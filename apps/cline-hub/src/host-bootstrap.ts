// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeQbrainStorage } from "@cline/qbrain-governance/host-storage";
import { initializeQbrainHubNamespace } from "@cline/qbrain-governance/hub-namespace";
import {
	getHubDaemonLaunchSpec,
	registerHubDaemonLaunchSpec,
} from "@cline/shared";

initializeQbrainStorage();
initializeQbrainHubNamespace();
// Bundled dashboards inherit the CLI host's registration. Source dashboards use
// the same checkout's CLI entrypoint with this absolute Bun executable.
if (
	!getHubDaemonLaunchSpec() &&
	basename(process.execPath).toLowerCase().includes("bun")
) {
	const entry = fileURLToPath(
		new URL("../../cli/src/index.ts", import.meta.url),
	);
	if (existsSync(entry))
		registerHubDaemonLaunchSpec({
			launcher: process.execPath,
			argsPrefix: [entry],
		});
}
