// SPDX-License-Identifier: Apache-2.0
// Run before modules that can construct storage services or discover a daemon.
import { initializeQbrainStorage } from "@cline/qbrain-governance/host-storage";
import { initializeQbrainHubNamespace } from "@cline/qbrain-governance/hub-namespace";
import { registerHubDaemonLaunchSpec } from "@cline/shared";
import { resolveCliLaunchSpec } from "./internal-launch";

initializeQbrainStorage();
initializeQbrainHubNamespace();
const launch = resolveCliLaunchSpec();
if (!launch)
	throw new Error(
		"Cannot resolve the absolute host executable for hub startup.",
	);
registerHubDaemonLaunchSpec({
	launcher: launch.launcher,
	argsPrefix: launch.childArgsPrefix,
});
