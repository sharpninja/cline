import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../utils/types";
import {
	createClineAccountService,
	loadClineAccountSnapshot,
	loadIndividualSubscriptionPlans,
} from "./cline-account";

describe("cline-qb account service refusal", () => {
	afterEach(() => vi.unstubAllGlobals());
	it.each([
		[
			"expired OAuth",
			createClineAccountService,
			{
				auth: {
					accessToken: "fixture",
					refreshToken: "fixture-refresh",
					expiresAt: 1,
				},
			},
		],
		[
			"invalid OAuth",
			createClineAccountService,
			{
				auth: { accessToken: "fixture", refreshToken: "invalid", expiresAt: 1 },
			},
		],
		["account snapshot", loadClineAccountSnapshot, { apiKey: "fixture" }],
		[
			"subscription plans",
			loadIndividualSubscriptionPlans,
			{ apiKey: "fixture" },
		],
	] as const)("blocks %s with actionable refusal and no network", async (_name, operation, settings) => {
		const network = vi.fn(() => {
			throw new Error("Prohibited network");
		});
		vi.stubGlobal("fetch", network);
		const config = { providerId: "cline", apiKey: "fixture" } as Config;
		await expect(
			operation({
				config,
				clineProviderSettings: { provider: "cline", ...settings },
			}),
		).rejects.toMatchObject({
			code: "cline_cloud_disabled",
			message:
				"Cline account services are unavailable in cline-qb. Configure a direct model provider.",
		});
		expect(network).not.toHaveBeenCalled();
	});
});
describe("isClineAccountCreditsErrorMessage", () => {
	it("matches the raw insufficient_credits JSON payload from the Cline API 402", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage(
				'{"code":"insufficient_credits","current_balance":-0.14,"message":"Not enough credits available"}',
			),
		).toBe(true);
	});

	it("matches the insufficient_credits payload wrapped in an error prefix", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage(
				'Error: {"code":"insufficient_credits","current_balance":0,"message":"Not enough credits available"}',
			),
		).toBe(true);
	});

	it("matches the plain human-readable Cline API message", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage("Not enough credits available"),
		).toBe(true);
	});

	it("matches the legacy insufficient balance phrasing", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(
			isClineAccountCreditsErrorMessage(
				"Insufficient balance. Your Cline credits balance is $0.00.",
			),
		).toBe(true);
	});

	it("does not match unrelated errors", async () => {
		const { isClineAccountCreditsErrorMessage } = await import(
			"./cline-account"
		);
		expect(isClineAccountCreditsErrorMessage("Payment Required")).toBe(false);
		expect(
			isClineAccountCreditsErrorMessage(
				"Your credit balance is too low to access the Anthropic API.",
			),
		).toBe(false);
		expect(
			isClineAccountCreditsErrorMessage("insufficient balance on gateway"),
		).toBe(false);
	});
});
