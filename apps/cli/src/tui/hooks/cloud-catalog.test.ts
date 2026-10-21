// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../../utils/types";

const calls = vi.hoisted(() => ({
	state: vi.fn(),
	manager: vi.fn(),
	settings: vi.fn(),
	recommended: vi.fn(async () => ({
		recommended: [],
		free: [],
		clinePass: [],
	})),
	models: vi.fn(async () => ({ models: [] })),
	refresh: vi.fn(async () => {}),
	resolve: vi.fn(async () => ({
		knownModels: { fixture: { id: "fixture", name: "Fixture" } },
	})),
	keyboard: vi.fn(),
	list: vi.fn(async () => ({ providers: [], settingsPath: "fixture" })),
	open: vi.fn(async () => {}),
}));
vi.mock("react", async (original) => ({
	...(await original<typeof import("react")>()),
	useState: (value: unknown) => [
		typeof value === "function" ? value() : value,
		calls.state,
	],
	useEffect: (effect: () => unknown) => {
		effect();
	},
	useCallback: (callback: unknown) => callback,
	useMemo: (factory: () => unknown) => factory(),
	useRef: (current: unknown) => ({ current }),
}));
vi.mock("@cline/core", async (original) => ({
	...(await original<typeof import("@cline/core")>()),
	fetchClineRecommendedModels: calls.recommended,
	getLocalProviderModels: calls.models,
	refreshProviderModelsFromSource: calls.refresh,
	resolveProviderConfig: calls.resolve,
	ProviderSettingsManager: class {
		constructor() {
			calls.manager();
		}
		getProviderSettings(id: string) {
			return calls.settings(id);
		}
		getProviderConfig() {
			return {};
		}
	},
}));
vi.mock("../../utils/provider-catalog", () => ({
	listLocalProviders: calls.list,
}));
vi.mock("../../utils/open", () => ({ default: calls.open }));
vi.mock("../views/onboarding/keyboard", () => ({
	useOnboardingKeyboard: calls.keyboard,
}));
vi.mock("../components/searchable-list", () => ({
	useSearchableList: () => ({ items: [], selectedIndex: 0, search: "" }),
}));
vi.mock("./use-theme", () => ({
	useTheme: () => ({ accents: { success: "green" } }),
	useDialogPalette: () => ({}),
}));
vi.mock("../components/dialogs/loading-dialog", () => ({
	withLoadingDialog: async (_d: unknown, _s: string, action: () => unknown) =>
		action(),
}));
vi.mock("@opentui/react", () => ({
	useKeyboard: vi.fn(),
	useTerminalDimensions: () => ({ width: 80, height: 30 }),
	useRenderer: vi.fn(),
}));
vi.mock("@opentui-ui/dialog/react", () => ({ useDialogKeyboard: vi.fn() }));
vi.mock("opentui-spinner/react", () => ({}));

import { useClineRecommendedModels } from "../components/model-selector/cline-model-picker";
import { useOnboardingController } from "../views/onboarding/controller";
import { useModelSelector } from "./use-model-selector";

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());
const config = (providerId: string) =>
	({
		providerId,
		modelId: "fixture",
		knownModels: {},
		apiKey: "fixture",
	}) as Config;
const picker = (providerId: string, choice = vi.fn(async () => undefined)) =>
	useModelSelector({
		dialog: { choice } as never,
		config: config(providerId),
		termHeight: 30,
		onModelChange: vi.fn(async () => {}),
		refocusTextarea: vi.fn(),
	});
describe("TEST-QB-016/017: CLI model catalogs", () => {
	it("recommendation hook makes no hosted request and finishes loading", () => {
		const result = useClineRecommendedModels();
		expect(calls.recommended).not.toHaveBeenCalled();
		expect(result).toEqual({ data: null, loading: false });
	});
	it("onboarding mount never requests hosted model lists or recommendations", async () => {
		useOnboardingController({ onComplete: vi.fn(), onExit: vi.fn() });
		await Promise.resolve();
		expect(calls.recommended).not.toHaveBeenCalled();
		expect(calls.models).not.toHaveBeenCalled();
	});
	it.each([
		"cline",
		"cline-pass",
		" CLINE ",
	])("model picker refuses %s before any catalog or credentials", async (provider) => {
		await expect(picker(provider)()).rejects.toThrow(
			"Configure a direct model provider",
		);
		expect(calls.manager).not.toHaveBeenCalled();
		expect(calls.refresh).not.toHaveBeenCalled();
		expect(calls.resolve).not.toHaveBeenCalled();
		expect(calls.recommended).not.toHaveBeenCalled();
	});
	it("forged cloud provider choice cannot reach credential resolution", async () => {
		const choice = vi.fn().mockResolvedValueOnce("cline");
		await expect(
			picker("anthropic", choice)({ startWithProviderChange: true }),
		).rejects.toThrow("Configure a direct model provider");
		expect(calls.manager).not.toHaveBeenCalled();
		expect(calls.refresh).not.toHaveBeenCalled();
	});
	it("direct-provider picker still resolves its own models", async () => {
		await picker("anthropic")();
		expect(calls.refresh).toHaveBeenCalledWith(expect.anything(), "anthropic");
		expect(calls.resolve).toHaveBeenCalledWith(
			"anthropic",
			expect.anything(),
			expect.anything(),
		);
		expect(calls.recommended).not.toHaveBeenCalled();
	});
});

it("onboarding menu excludes disabled providers", () => {
	const controller = useOnboardingController({
		onComplete: vi.fn(),
		onExit: vi.fn(),
	});
	expect(controller.menuOptions.map((o) => o.value)).toEqual(
		expect.arrayContaining(["openai-codex", "byo"]),
	);
	expect(controller.menuOptions.map((o) => o.value)).not.toContain("cline");
	expect(controller.menuOptions.map((o) => o.value)).not.toContain(
		"cline-pass",
	);
});
it.each([
	"cline",
	"cline-pass",
])("onboarding refuses forged %s catalog requests", (id) => {
	useOnboardingController({ onComplete: vi.fn(), onExit: vi.fn() });
	const handlers = calls.keyboard.mock.calls.at(-1)![0];
	expect(() => handlers.loadModelsForProvider(id)).toThrow(
		"Configure a direct model provider",
	);
	expect(calls.refresh).not.toHaveBeenCalled();
	expect(calls.resolve).not.toHaveBeenCalled();
});
it("onboarding legacy subscription action cannot open a hosted page", () => {
	useOnboardingController({ onComplete: vi.fn(), onExit: vi.fn() });
	const handlers = calls.keyboard.mock.calls.at(-1)![0];
	handlers.openClinePassSubscriptionPage();
	expect(calls.open).not.toHaveBeenCalled();
	expect(calls.state).toHaveBeenCalledWith(
		expect.stringContaining("Configure a direct model provider"),
	);
});
it("onboarding explicit direct selection still resolves its catalog", async () => {
	useOnboardingController({ onComplete: vi.fn(), onExit: vi.fn() });
	const handlers = calls.keyboard.mock.calls.at(-1)![0];
	handlers.loadModelsForProvider("anthropic");
	await vi.waitFor(() =>
		expect(calls.resolve).toHaveBeenCalledWith(
			"anthropic",
			expect.anything(),
			expect.anything(),
		),
	);
	expect(calls.recommended).not.toHaveBeenCalled();
});
