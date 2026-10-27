import { UPSTREAM_UPDATE_DISABLED_MESSAGE } from './update-policy';
export { UPSTREAM_UPDATE_DISABLED_MESSAGE } from './update-policy';
import { realpathSync } from "node:fs";
import {
	resolveProductionHubOwnerContext,
	resolveSharedHubOwnerContext,
} from "@cline/core";
import { resolveClineBuildEnv } from "@cline/shared";
import { writeErr } from "../utils/output";
import type { KanbanInstaller } from "./kanban";



export enum PackageManager {
	NPM = "npm",
	PNPM = "pnpm",
	YARN = "yarn",
	BUN = "bun",
	NPX = "npx",
	UNKNOWN = "unknown",
}
interface InstallationInfo {
	packageManager: PackageManager;
	packageName: "cline-qb";
	updateCommand?: never;
}
interface ManualUpdateCommand {
	command: string;
	env?: Readonly<Record<string, string>>;
}

/** Installation identity only; never constructs an updater command. */
export function getInstallationInfo(
	_currentVersion?: string,
): InstallationInfo {
	let packageManager = PackageManager.UNKNOWN;
	try {
		const path = realpathSync(
			process.env.CLINE_QB_WRAPPER_PATH || process.argv[1] || "",
		).replace(/\\/g, "/");
		if (path.includes("/.npm/_npx") || path.includes("/npm/_npx"))
			packageManager = PackageManager.NPX;
		else if (path.includes("/.pnpm/global") || path.includes("/pnpm/global"))
			packageManager = PackageManager.PNPM;
		else if (path.includes("/.yarn/") || path.includes("/yarn/global"))
			packageManager = PackageManager.YARN;
		else if (
			path.includes("/.bun/bin") ||
			path.includes("/.bun/install/global/")
		)
			packageManager = PackageManager.BUN;
		else if (path.includes("/node_modules/"))
			packageManager = PackageManager.NPM;
	} catch {
		/* Unknown installation remains usable without update support. */
	}
	return { packageManager, packageName: "cline-qb" };
}
export function getPreferredKanbanInstaller(
	_currentVersion?: string,
): KanbanInstaller | undefined {
	const manager = getInstallationInfo().packageManager;
	return manager === PackageManager.NPM ||
		manager === PackageManager.PNPM ||
		manager === PackageManager.BUN
		? manager
		: undefined;
}
export function resolveCliHubOwnerContext() {
	return resolveClineBuildEnv() === "production"
		? resolveProductionHubOwnerContext()
		: resolveSharedHubOwnerContext();
}

/** Compatibility entry point: product builds never check an upstream feed. */
export function autoUpdateOnStartup(): void {
	/* Disabled regardless of environment or legacy settings. */
}
/** Pending legacy updater commands are discarded without discovery or execution. */
export async function applyDeferredUpdate(
	_pending?: ManualUpdateCommand,
): Promise<"none" | "deferred" | "started"> {
	return "none";
}
export interface CheckForUpdatesOptions {
	verbose?: boolean;
	includeKanban?: boolean;
}
export async function checkForUpdates(
	_options: CheckForUpdatesOptions = {},
): Promise<number> {
	writeErr(UPSTREAM_UPDATE_DISABLED_MESSAGE);
	return 1;
}
