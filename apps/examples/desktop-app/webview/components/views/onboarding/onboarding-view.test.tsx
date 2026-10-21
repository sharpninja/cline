// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProvider } from "@/contexts/account-context";
import type { Provider } from "@/lib/provider-schema";
import { OnboardingView, sortProvidersForApiKeySetup } from "./onboarding-view";

const { invoke, openExternalUrl } = vi.hoisted(() => ({
	invoke: vi.fn(),
	openExternalUrl: vi.fn(),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke, subscribe: vi.fn(() => () => {}) },
	openExternalUrl,
}));

class StorageStub implements Storage {
	readonly #values = new Map<string, string>();
	get length() {
		return this.#values.size;
	}
	clear() {
		this.#values.clear();
	}
	getItem(key: string) {
		return this.#values.get(key) ?? null;
	}
	key(index: number) {
		return [...this.#values.keys()][index] ?? null;
	}
	removeItem(key: string) {
		this.#values.delete(key);
	}
	setItem(key: string, value: string) {
		this.#values.set(key, value);
	}
}

function makeProvider(overrides: Partial<Provider> = {}): Provider {
	return {
		id: "anthropic",
		name: "Anthropic",
		models: 4,
		color: "#000",
		letter: "A",
		enabled: false,
		...overrides,
	};
}

describe("sortProvidersForApiKeySetup", () => {
	it("drops OAuth-managed providers and ranks popular ones first", () => {
		const sorted = sortProvidersForApiKeySetup([
			makeProvider({ id: "zai", name: "Z AI" }),
			makeProvider({ id: "cline", name: "Cline" }),
			makeProvider({ id: "openai-codex", name: "ChatGPT" }),
			makeProvider({ id: "openrouter", name: "OpenRouter" }),
			makeProvider({ id: "anthropic", name: "Anthropic" }),
			makeProvider({ id: "baseten", name: "Baseten" }),
		]);
		expect(sorted.map((provider) => provider.id)).toEqual([
			"anthropic",
			"openrouter",
			"baseten",
			"zai",
		]);
	});

	it("drops providers the API-key form cannot fully configure", () => {
		const apiKeyField = {
			path: "apiKey",
			label: "API Key",
			type: "password" as const,
		};
		const sorted = sortProvidersForApiKeySetup([
			makeProvider({
				id: "vertex",
				name: "Google Vertex AI",
				configFields: [
					{ path: "gcp.projectId", label: "Project", type: "text" },
					apiKeyField,
				],
			}),
			makeProvider({
				id: "bedrock",
				name: "AWS Bedrock",
				configFields: [
					{ path: "aws.region", label: "Region", type: "text" },
					apiKeyField,
				],
			}),
			makeProvider({
				id: "claude-code",
				name: "Claude Code",
				configFields: [],
			}),
			makeProvider({
				id: "ollama",
				name: "Ollama",
				configFields: [
					apiKeyField,
					{ path: "baseUrl", label: "Base URL", type: "url" },
				],
			}),
			makeProvider({ id: "anthropic", name: "Anthropic" }),
		]);
		expect(sorted.map((provider) => provider.id)).toEqual([
			"anthropic",
			"ollama",
		]);
	});
});

describe("OnboardingView", () => {
	let container: HTMLDivElement;
	let root: Root;
	beforeEach(() => {
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			value: new StorageStub(),
		});
		Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
		invoke.mockReset();
		invoke.mockImplementation(async (command: string) =>
			command === "list_provider_catalog"
				? { providers: [makeProvider()], settingsPath: "/tmp/providers.json" }
				: { sessions: [] },
		);
		container = document.createElement("div");
		document.body.appendChild(container);
		root = createRoot(container);
	});
	afterEach(async () => {
		await act(async () => root.unmount());
		container.remove();
	});
	function button(text: string) {
		const b = Array.from(container.querySelectorAll("button")).find(
			(x) => x.textContent?.trim() === text,
		);
		if (!b) throw new Error(`button not found: ${text}`);
		return b;
	}
	async function render() {
		const done = vi.fn();
		await act(async () =>
			root.render(
				<AccountProvider>
					<OnboardingView onComplete={done} />
				</AccountProvider>,
			),
		);
		return done;
	}
	it("keeps welcome composition and opens an active direct-provider form", async () => {
		await render();
		expect(container.textContent).toContain("Build software your way");
		expect(
			container.querySelector('[data-welcome-hero-variant="bot-only"]'),
		).not.toBeNull();
		expect(
			container.querySelector(
				'[data-onboarding-grid="welcome"] [data-welcome-hero-variant="grid-only"]',
			),
		).not.toBeNull();
		await act(async () => button("Get started").click());
		expect(container.textContent).toContain("Set up cline-qb");
		expect(
			container.querySelector('[data-onboarding-option="cline"]'),
		).toBeNull();
		expect(
			container
				.querySelector('[data-onboarding-option="api-key"]')
				?.getAttribute("data-selected"),
		).toBe("true");
		expect(
			container
				.querySelector("[data-onboarding-option-content]")
				?.hasAttribute("inert"),
		).toBe(false);
		expect(
			container.querySelector('[data-onboarding-content="panel"]'),
		).not.toBeNull();
		expect(
			container
				.querySelector("[data-onboarding-api-key-form]")
				?.getAttribute("aria-hidden"),
		).toBe("false");
	});
	it("completes without connecting when skipped", async () => {
		const done = await render();
		await act(async () => button("Get started").click());
		await act(async () => button("Skip").click());
		expect(done).toHaveBeenCalledOnce();
	});
});
