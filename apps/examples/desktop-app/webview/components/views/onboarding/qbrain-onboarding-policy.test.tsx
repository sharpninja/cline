// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	OnboardingView,
	sortProvidersForApiKeySetup,
	type OnboardingStep,
} from "./onboarding-view";
import { MODEL_SELECTION_STORAGE_KEY } from "@/lib/model-selection";
import type { Provider } from "@/lib/provider-schema";
const { invoke, catalog, invalidate, openExternalUrl } = vi.hoisted(() => ({
	invoke: vi.fn(),
	catalog: vi.fn(),
	invalidate: vi.fn(),
	openExternalUrl: vi.fn(),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke, subscribe: vi.fn(() => () => {}) },
	openExternalUrl,
}));
vi.mock("@/lib/provider-model-catalog", () => ({
	fetchProviderCatalog: catalog,
	invalidateProviderCatalogCache: invalidate,
}));
// Legacy signed-in identity and enabled cloud flags must not activate account setup.
vi.mock("@/contexts/account-context", () => ({
	useAccount: () => ({
		user: { email: "legacy@example.test" },
		refreshAccount: vi.fn(),
	}),
}));
vi.mock("@/hooks/use-feature-flags", () => ({
	useFeatureFlags: () => ({ flags: { "code-onboarding-github": true } }),
	isFeatureEnabled: () => true,
}));
vi.mock("@/components/import-sessions-dialog", () => ({
	ImportSessionsDialog: () => null,
}));
vi.mock("@/components/ui/select", () => ({
	Select: ({
		children,
		value,
		onValueChange,
		disabled,
	}: {
		children: ReactNode;
		value?: string;
		onValueChange: (v: string) => void;
		disabled?: boolean;
	}) => (
		<select
			aria-label="Provider"
			value={value ?? ""}
			disabled={disabled}
			onChange={(e) => onValueChange(e.target.value)}
		>
			<option value="">Choose a provider</option>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
		<option value={value}>{children}</option>
	),
	SelectTrigger: () => null,
	SelectValue: () => null,
}));
const direct: Provider = {
	id: "anthropic",
	name: "Anthropic",
	models: 1,
	color: "#000",
	letter: "A",
	enabled: false,
	defaultModelId: "chosen-model",
};
let root: Root, container: HTMLDivElement;
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	window.localStorage.clear();
	vi.clearAllMocks();
	invoke.mockReset();
	invoke.mockResolvedValue({ sessions: [] });
	catalog.mockReset();
	catalog.mockResolvedValue({ providers: [direct] });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
});
async function render(
	initialStep: OnboardingStep = "connect",
	onComplete = vi.fn(),
) {
	await act(async () =>
		root.render(
			<OnboardingView initialStep={initialStep} onComplete={onComplete} />,
		),
	);
	return onComplete;
}
function button(text: string) {
	const b = Array.from(container.querySelectorAll("button")).find(
		(x) => x.textContent?.trim() === text,
	);
	if (!b) throw new Error(`Missing ${text}`);
	return b;
}
async function selectAndType() {
	await act(async () => {
		const s = container.querySelector<HTMLSelectElement>("select")!;
		s.value = "anthropic";
		s.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await act(async () => {
		const input = container.querySelector<HTMLInputElement>(
			'input[aria-label="API key"]',
		)!;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, " test-key ");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
function expectNoAccountCommands() {
	expect(invoke.mock.calls.map(([command]) => command)).not.toEqual(
		expect.arrayContaining([
			expect.stringMatching(/cline|oauth|integration|feature_flag/),
		]),
	);
	expect(openExternalUrl).not.toHaveBeenCalled();
}

it("TEST-QB-062: offers_only_compatible_direct_onboarding_forms / AC018 key-only form excludes mandatory endpoint and alternate-auth setup", () => {
	const key = { path: "apiKey", label: "Key", type: "password" as const };
	expect(
		sortProvidersForApiKeySetup([
			{
				...direct,
				id: "required-endpoint",
				configFields: [
					key,
					{ path: "baseUrl", label: "Endpoint", type: "url", required: true },
				],
			},
			{ ...direct, id: "custom-oauth", capabilities: ["oauth"] },
			{ ...direct, id: "local-cli", capabilities: ["local-auth"] },
			{
				...direct,
				id: "optional-endpoint",
				configFields: [
					key,
					{ path: "baseUrl", label: "Endpoint", type: "url", required: false },
				],
			},
			direct,
		]).map((p) => p.id),
	).toEqual(["anthropic", "optional-endpoint"]);
});
it("TEST-QB-061: prevents_legacy_account_onboarding_reactivation / AC017 rejects every cloud provider alias even in stale catalog responses", () => {
	const cloud = [
		"cline",
		"cline-pass",
		"cline-cloud",
		" CLINE ",
		" CLINE-PASS ",
	];
	expect(
		sortProvidersForApiKeySetup([
			...cloud.map((id) => ({ ...direct, id })),
			direct,
		]).map((p) => p.id),
	).toEqual(["anthropic"]);
});
it("TEST-QB-061: prevents_legacy_account_onboarding_reactivation / AC016/017 shows direct setup without account, upsell or legacy sign-in", async () => {
	window.localStorage.setItem(
		"cline.code.account-identity.v1",
		'{"email":"legacy@example.test"}',
	);
	await render();
	expect(
		container.querySelector('[data-onboarding-option="cline"]'),
	).toBeNull();
	expect(container.textContent).not.toMatch(
		/ClinePass|Sign in with Cline|Cline API key|Signed in as/,
	);
	expect(
		container
			.querySelector("[data-onboarding-api-key-form]")
			?.getAttribute("aria-hidden"),
	).toBe("false");
	expect(button("Connect").disabled).toBe(true);
	expect((container.querySelector("select") as HTMLSelectElement).value).toBe(
		"",
	);
	expect(window.localStorage.getItem("cline.code.account-identity.v1")).toBe(
		'{"email":"legacy@example.test"}',
	);
	expectNoAccountCommands();
});
it("TEST-QB-062: offers_only_compatible_direct_onboarding_forms / AC018 saves only the explicitly selected provider then completes without cloud calls", async () => {
	const done = await render();
	await selectAndType();
	await act(async () => button("Connect").click());
	expect(invoke).toHaveBeenCalledWith("save_provider_settings", {
		provider: "anthropic",
		enabled: true,
		api_key: "test-key",
	});
	expect(invalidate).toHaveBeenCalledOnce();
	expect(container.textContent).toContain("Anthropic is connected.");
	expect(
		JSON.parse(window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY)!),
	).toMatchObject({
		lastProvider: "anthropic",
		lastModelByProvider: { anthropic: "chosen-model" },
	});
	await act(async () => button("Start building").click());
	expect(done).toHaveBeenCalledOnce();
	expectNoAccountCommands();
});
it("TEST-QB-062: offers_only_compatible_direct_onboarding_forms / AC018 failed direct setup stays actionable without selecting a fallback", async () => {
	invoke.mockRejectedValue(new Error("Credential store unavailable"));
	const done = await render();
	await selectAndType();
	await act(async () => button("Connect").click());
	expect(container.textContent).toContain("Credential store unavailable");
	expect(done).not.toHaveBeenCalled();
	expect(window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY)).toBeNull();
	expectNoAccountCommands();
});
it("TEST-QB-061: prevents_legacy_account_onboarding_reactivation / AC017 stale GitHub onboarding route cannot initialize Cline integrations", async () => {
	await render("github");
	expect(catalog).toHaveBeenCalledOnce();
	expect(container.querySelector('input[aria-label="API key"]')).not.toBeNull();
	expectNoAccountCommands();
});
it("TEST-QB-061: prevents_legacy_account_onboarding_reactivation / AC018 skipped setup does not invent a provider or claim an account connection", async () => {
	const done = await render();
	await act(async () => button("Skip").click());
	expect(done).toHaveBeenCalledOnce();
	expect(invoke).not.toHaveBeenCalled();
	expect(window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY)).toBeNull();
});
it("TEST-QB-062: offers_only_compatible_direct_onboarding_forms / AC018 catalog failure preserves recovery through Settings", async () => {
	catalog.mockRejectedValue(new Error("Catalog unavailable"));
	const done = await render();
	expect(container.textContent).toContain("Catalog unavailable");
	expect(container.textContent).toContain("Settings");
	expect(button("Connect").disabled).toBe(true);
	await act(async () => button("Skip").click());
	expect(done).toHaveBeenCalledOnce();
	expectNoAccountCommands();
});
