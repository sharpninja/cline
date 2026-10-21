// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ keyboard: vi.fn() }));
vi.mock("@opentui-ui/dialog/react", () => ({
	useDialogKeyboard: calls.keyboard,
}));
vi.mock("../../hooks/use-theme", () => ({
	useDialogPalette: () => ({
		act: "green",
		textOnSelection: "white",
		muted: "gray",
	}),
}));

import { HubUpdateRequiredContent } from "./hub-update-required";

beforeEach(() => vi.clearAllMocks());
describe("TEST-QB-016/017: hub mismatch cannot install upstream CLI", () => {
	it.each([
		"enter",
		"return",
		"escape",
	])("%s dismisses without update authorization", (name) => {
		const resolve = vi.fn(),
			dismiss = vi.fn();
		const tree = HubUpdateRequiredContent({
			dialogId: "fixture",
			resolve,
			dismiss,
			hubCoreVersion: "future",
		} as never);
		const handler = calls.keyboard.mock.calls[0]?.[0];
		expect(handler).toBeTypeOf("function");
		handler({ name });
		expect(resolve).not.toHaveBeenCalled();
		expect(dismiss).toHaveBeenCalledOnce();
		expect(JSON.stringify(tree)).toContain("matching reviewed cline-qb build");
		expect(JSON.stringify(tree)).not.toContain("Update and restart");
	});
});
