import { join } from "node:path";
import { resolveClineDataDir } from "@cline/shared/storage";
import { rejectClineAccount } from "@cline/qbrain-governance/cloud-policy";
/** Legacy shape retained for clients; hosted sessions are unavailable. */
export type DesktopSettings = { cloudSessionsEnabled: boolean };
export function resolveDesktopSettingsPath(): string {
	return join(resolveClineDataDir(), "settings", "code-settings.json");
}
/** Never load, migrate or rewrite saved cloud enablement. */
export function readDesktopSettings(): DesktopSettings {
	return { cloudSessionsEnabled: false };
}
export function writeDesktopSettings(settings: DesktopSettings): void {
	if (settings.cloudSessionsEnabled) rejectClineAccount();
}
export function setCloudSessionsEnabled(enabled: boolean): DesktopSettings {
	if (enabled) rejectClineAccount();
	return readDesktopSettings();
}
