// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
	state: vi.fn(),
	manager: vi.fn(),
	settings: vi.fn(),
	login: vi.fn(() => new Promise(() => {})),
	device: vi.fn(() => new Promise(() => {})),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (value: unknown) => [value, calls.state],
	useEffect: (effect: () => unknown) => {
		effect();
	},
	useCallback: (callback: unknown) => callback,
	useRef: (current: unknown) => ({ current }),
}));
vi.mock("@cline/core", async (original) => ({
	...(await original<typeof import("@cline/core")>()),
	ProviderSettingsManager: class {
		constructor() {
			calls.manager();
		}
		getProviderSettings() {
			return calls.settings();
		}
	},
	loginLocalProvider: calls.login,
	startClineDeviceAuth: calls.device,
}));
vi.mock("@opentui-ui/dialog/react", () => ({ useDialogKeyboard: vi.fn() }));
vi.mock("../../hooks/use-theme", () => ({
	useDialogPalette: () => ({ act: "green", plan: "blue" }),
}));

import {
	ClinePassSubscriptionContent,
	OAuthLoginContent,
} from "./provider-picker";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
function mount(providerId: string) {
	return OAuthLoginContent({
		providerId,
		providerName: providerId,
		resolve: vi.fn(),
		dismiss: vi.fn(),
		dialogId: "fixture",
	} as Parameters<typeof OAuthLoginContent>[0]);
}
describe("TEST-QB-016/017: settings OAuth dialog cloud boundary", () => {
	it.each([
		"cline",
		"cline-pass",
		" CLINE ",
	])("refuses %s before constructing credential manager", (provider) => {
		mount(provider);
		expect(calls.state).toHaveBeenCalledWith(
			expect.stringContaining("Configure a direct model provider"),
		);
		expect(calls.manager).not.toHaveBeenCalled();
		expect(calls.settings).not.toHaveBeenCalled();
		expect(calls.login).not.toHaveBeenCalled();
		expect(calls.device).not.toHaveBeenCalled();
	});
	it("retains explicit direct-provider OAuth", () => {
		mount("openai-codex");
		expect(calls.manager).toHaveBeenCalledOnce();
		expect(calls.login).toHaveBeenCalledWith(
			"openai-codex",
			undefined,
			expect.any(Function),
		);
		expect(calls.device).not.toHaveBeenCalled();
	});
});

it("replaces the subscription browser page with actionable refusal", () => {
	const tree = ClinePassSubscriptionContent({
		providerName: "ClinePass",
		dismiss: vi.fn(),
		resolve: vi.fn(),
		dialogId: "fixture",
	} as Parameters<typeof ClinePassSubscriptionContent>[0]);
	expect(JSON.stringify(tree)).toContain("Configure a direct model provider");
	expect(JSON.stringify(tree)).not.toContain("dashboard/subscription");
	expect(calls.manager).not.toHaveBeenCalled();
});
