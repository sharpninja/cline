// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import {
	assertDirectProvider,
	isClineCloudProvider,
	requireDirectProvider,
} from "./cloud-policy";
describe("TEST-QB-017 hosted provider aliases", () => {
	it.each([
		"cline",
		"cline-pass",
		"cline-cloud",
		" CLINE-CLOUD ",
	])("rejects %s", (id) => {
		expect(isClineCloudProvider(id)).toBe(true);
		expect(() => assertDirectProvider(id)).toThrow(/unavailable/);
		expect(() => requireDirectProvider(id)).toThrow(/unavailable/);
	});
	it.each([
		"anthropic",
		"openrouter",
		"claude-code",
		"my-cline-proxy",
	])("preserves explicit direct provider %s", (id) => {
		expect(isClineCloudProvider(id)).toBe(false);
		expect(requireDirectProvider(id)).toBe(id);
	});
});
