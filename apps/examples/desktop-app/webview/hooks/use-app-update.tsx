"use client";
import { toast } from "@/hooks/use-toast";

export type AppUpdateStatus = {
	state: "disabled" | "idle" | "checking" | "downloading" | "ready" | "error";
	version?: string | null;
	error?: string | null;
};
export const DISABLED_UPDATE_MESSAGE =
	"Automatic updates are disabled in cline-qb. Install a matching reviewed build.";
const disabledStatus: AppUpdateStatus = Object.freeze({ state: "disabled" });

/** Product policy is unconditional; stale native or persisted state cannot enable updates. */
export function useAppUpdateStatus(): AppUpdateStatus {
	return disabledStatus;
}
export async function checkForUpdateNow(): Promise<AppUpdateStatus | null> {
	return disabledStatus;
}
export async function checkForUpdateAndNotify(): Promise<void> {
	toast({
		title: "Automatic updates disabled",
		description: DISABLED_UPDATE_MESSAGE,
	});
}
export async function restartToApplyUpdate(): Promise<boolean> {
	await checkForUpdateAndNotify();
	return false;
}
/** No background update polling, native invocation, download or staged-update notification. */
export function useAppUpdate(): void {}
