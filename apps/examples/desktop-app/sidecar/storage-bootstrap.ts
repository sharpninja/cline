// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { initializeQbrainStorage } from "@cline/qbrain-governance/host-storage";
import { initializeQbrainHubNamespace } from "@cline/qbrain-governance/hub-namespace";
import {
	isBunEmbeddedModulePath,
	registerHubDaemonLaunchSpec,
} from "@cline/shared";

// Must evaluate before importing storage-bearing services, including daemon mode.
initializeQbrainStorage();
initializeQbrainHubNamespace();
const entry = process.argv[1];
const compiled =
	isBunEmbeddedModulePath(import.meta.url) ||
	(!!entry && isBunEmbeddedModulePath(entry));
if (!compiled && (!entry || !existsSync(resolve(entry)))) {
	throw new Error(
		"cline-qb desktop requires an existing absolute self-launch entrypoint.",
	);
}
const conditions = process.execArgv.filter((arg) =>
	arg.startsWith("--conditions="),
);
registerHubDaemonLaunchSpec({
	launcher: process.execPath,
	argsPrefix: compiled ? [] : [...conditions, resolve(entry!)],
});
