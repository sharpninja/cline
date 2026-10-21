// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInitialChatConfig } from "@/hooks/chat-session/constants";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import {
	readModelSelectionStorageFromWindow,
	writeModelSelectionStorageToWindow,
	readExecutionTargetFromWindow,
	writeExecutionTargetToWindow,
	readReasoningSelectionStorageFromWindow,
	writeReasoningSelectionToWindow,
} from "./model-selection";
import {
	readWorkspaceSelectionFromWindow,
	writeWorkspaceSelectionToWindow,
} from "./workspace-paths";
import { readWorkInFromWindow, writeWorkInToWindow } from "./work-in-selection";
import { readSeenWhatsNewId, markWhatsNewSeen } from "./whats-new";
import {
	hasCompletedOnboarding,
	markOnboardingCompleted,
	resetOnboarding,
} from "./onboarding";
import { readStoredAppIcon, setStoredAppIcon } from "./app-icon";
import {
	readStoredHubTheme,
	setStoredHubTheme,
	readStoredHubAccent,
	setStoredHubAccent,
	HUB_THEME_BOOTSTRAP_SCRIPT,
} from "./theme";
import {
	readStoredAppFontSize,
	setStoredAppFontSize,
	APP_FONT_SIZE_BOOTSTRAP_SCRIPT,
} from "./app-font-size";
import {
	readDesktopNotificationSettings,
	writeDesktopNotificationSettings,
} from "./desktop-notifications";
vi.mock("@/lib/desktop-client", () => ({
	isTauriAvailable: () => false,
	desktopClient: { invoke: vi.fn() },
}));
const legacy = new Map([
	[
		"cline.code.model-selection.v1",
		JSON.stringify({
			lastProvider: "cline",
			lastModelByProvider: { cline: "old-model" },
		}),
	],
	["cline.code.reasoning-selection.v1", '{"cline":"high"}'],
	["cline.code.execution-target.v1", '{"target":"cloud"}'],
	[
		"cline.code.cloud-model-selection.v1",
		'{"lastProvider":"cline","lastModelByProvider":{"cline":"old-cloud"}}',
	],
	[
		"cline.code.workspace-selection.v2",
		'{"environments":{"local":{"lastWorkspace":"/upstream","workspaces":["/upstream"]}}}',
	],
	["cline.code.work-in.v1", "worktree"],
	["cline.code.whats-new.v1", "old-release"],
	["cline.code.onboarding.v1", '{"completedAt":"2020-01-01"}'],
	["cline.code.app-icon.v1", "sunrise"],
	["cline-hub-theme", "light"],
	["cline.code.accent.v1", "pink"],
	["cline.code.font-size.v1", "20"],
	[
		"cline:desktop-notification-settings:v1",
		'{"taskCompletion":{"enabled":false,"sound":true}}',
	],
	["cline.code.account-identity.v1", '{"user":"upstream"}'],
]);
beforeEach(() => {
	window.localStorage.clear();
	for (const [key, value] of legacy) window.localStorage.setItem(key, value);
	vi.stubEnv("CLINE_API_KEY", "must-not-read-upstream");
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
		})),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
describe("cline-qb browser storage and selection", () => {
	it("ignores upstream credentials even when present before module initialization", async () => {
		vi.resetModules();
		const { getInitialChatConfig: fresh } = await import(
			"@/hooks/chat-session/constants"
		);
		expect(fresh("local").apiKey).toBe("");
	});
	it.each([
		"{",
		"null",
		"[]",
		'{"lastProvider":42}',
		'{"lastProvider":"anthropic","lastModelByProvider":false}',
	])("does not invent a selection from malformed preference %s", (raw) => {
		window.localStorage.setItem("cline-qb.code.model-selection.v1", raw);
		expect(getInitialChatConfig("local").model).toBe("");
	});
	it("keeps startup usable when browser storage is unavailable", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new DOMException("denied", "SecurityError");
		});
		expect(getInitialChatConfig("local")).toMatchObject({
			provider: "",
			model: "",
			apiKey: "",
			executionTarget: "local",
		});
	});
	it.each([
		"fresh",
		"seeded",
	] as const)("starts %s with no implicit provider, model, credential or cloud target", (mode) => {
		if (mode === "fresh") window.localStorage.clear();
		const reads = vi.spyOn(Storage.prototype, "getItem");
		expect(getInitialChatConfig("local")).toMatchObject({
			provider: "",
			model: "",
			apiKey: "",
			executionTarget: "local",
			cwd: "",
		});
		expect(reads.mock.calls.every(([key]) => key.startsWith("cline-qb."))).toBe(
			true,
		);
	});
	it.each([
		"cline",
		" CLINE-PASS ",
	])("does not restore excluded private selection %s", (provider) => {
		window.localStorage.setItem(
			"cline-qb.code.model-selection.v1",
			JSON.stringify({
				lastProvider: provider,
				lastModelByProvider: { [provider]: "old", anthropic: "retained" },
			}),
		);
		expect(getInitialChatConfig("local")).toMatchObject({
			provider: "",
			model: "",
			executionTarget: "local",
		});
		expect(readModelSelectionStorageFromWindow().lastModelByProvider).toEqual({
			anthropic: "retained",
		});
	});
	it("restores only an explicit direct selection and never substitutes a model", () => {
		writeModelSelectionStorageToWindow({
			lastProvider: "anthropic",
			lastModelByProvider: { anthropic: "chosen" },
		});
		expect(getInitialChatConfig("remote")).toMatchObject({
			provider: "anthropic",
			model: "chosen",
			apiKey: "",
			executionTarget: "local",
		});
		writeModelSelectionStorageToWindow({
			lastProvider: "anthropic",
			lastModelByProvider: {},
		});
		expect(getInitialChatConfig("local").model).toBe("");
	});
	it("refuses explicit cloud selection without changing preferences", () => {
		const before = window.localStorage.length;
		expect(() => writeExecutionTargetToWindow("cloud")).toThrow(
			/unavailable in cline-qb/,
		);
		expect(() =>
			writeModelSelectionStorageToWindow({
				lastProvider: "cline",
				lastModelByProvider: {},
			}),
		).toThrow(/unavailable in cline-qb/);
		expect(() =>
			getInitialChatConfig("local", { executionTarget: "cloud" }),
		).toThrow(/unavailable in cline-qb/);
		expect(readExecutionTargetFromWindow()).toBe("local");
		expect(readModelSelectionStorageFromWindow("cloud")).toEqual({
			lastProvider: "",
			lastModelByProvider: {},
		});
		expect(window.localStorage.length).toBe(before);
	});
	it("runs preference readers, writes, reset and early boot without accessing upstream keys", async () => {
		const read = vi.spyOn(Storage.prototype, "getItem");
		const write = vi.spyOn(Storage.prototype, "setItem");
		const remove = vi.spyOn(Storage.prototype, "removeItem");
		readReasoningSelectionStorageFromWindow();
		writeReasoningSelectionToWindow("anthropic", "high");
		expect(readWorkspaceSelectionFromWindow("local").lastWorkspace).toBe("");
		writeWorkspaceSelectionToWindow("local", {
			lastWorkspace: "/allowed",
			workspaces: ["/allowed"],
		});
		expect(readWorkInFromWindow()).toBe("local");
		writeWorkInToWindow("worktree");
		expect(readSeenWhatsNewId()).toBeNull();
		markWhatsNewSeen("new-release");
		expect(hasCompletedOnboarding()).toBe(false);
		markOnboardingCompleted();
		resetOnboarding();
		expect(readStoredAppIcon()).toBe("midnight");
		await setStoredAppIcon("chip");
		expect(readStoredHubTheme()).toBeNull();
		setStoredHubTheme("dark");
		expect(readStoredHubAccent()).toBe("violet");
		setStoredHubAccent("cyan");
		expect(readStoredAppFontSize()).toBe(15);
		setStoredAppFontSize(16);
		const notifications = readDesktopNotificationSettings();
		expect(notifications.taskCompletion.enabled).toBe(true);
		writeDesktopNotificationSettings(notifications);
		new Function(HUB_THEME_BOOTSTRAP_SCRIPT)();
		new Function(APP_FONT_SIZE_BOOTSTRAP_SCRIPT)();
		expect(
			[...read.mock.calls, ...write.mock.calls, ...remove.mock.calls].every(
				([key]) => key.startsWith("cline-qb."),
			),
		).toBe(true);
		read.mockRestore();
		for (const [key, value] of legacy)
			expect(window.localStorage.getItem(key)).toBe(value);
	});
	it("keeps sidebar persistence away from upstream cookies", async () => {
		const getter = vi
			.spyOn(Document.prototype, "cookie", "get")
			.mockReturnValue("sidebar_width=550; sidebar_state=false");
		const setter = vi.spyOn(Document.prototype, "cookie", "set");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		function Probe() {
			const state = useSidebar();
			useEffect(() => {
				state.setDesktopWidth(320);
				state.setOpen(false);
			}, [state.setDesktopWidth, state.setOpen]);
			return <span>{state.desktopWidth}</span>;
		}
		try {
			await act(async () => {
				root.render(
					<SidebarProvider>
						<Probe />
					</SidebarProvider>,
				);
			});
			expect(getter).not.toHaveBeenCalled();
			expect(setter).not.toHaveBeenCalled();
			expect(window.localStorage.getItem("cline-qb.sidebar_width")).toBe("320");
		} finally {
			await act(async () => root.unmount());
			container.remove();
		}
	});
});
