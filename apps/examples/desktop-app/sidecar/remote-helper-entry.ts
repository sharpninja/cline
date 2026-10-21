// SPDX-License-Identifier: Apache-2.0
// Executable host policy must be installed before importing SDK consumers.
import "./storage-bootstrap";
import { runRemoteHelperEntrypoint } from "@cline/core/remote/helper";
import {
	disableCurrentDirectoryExecutableSearch,
	ensureLoopbackProxyBypass,
} from "@cline/shared";
disableCurrentDirectoryExecutableSearch();
ensureLoopbackProxyBypass();
void (async () => {
	if (!(await runRemoteHelperEntrypoint()))
		throw new Error("A remote helper command is required");
})().catch((error) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
