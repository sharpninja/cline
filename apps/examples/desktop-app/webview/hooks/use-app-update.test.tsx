// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke: mocks.invoke },
	isTauriAvailable: () => true,
}));
vi.mock("@/hooks/use-toast", () => ({ toast: mocks.toast }));
beforeEach(() => {
	mocks.invoke.mockReset();
	mocks.toast.mockReset();
});
describe("cline-qb disabled updater — TEST-QB-016/017", () => {
	it.each([
		"ready",
		"idle",
		"error",
	])("ignores an upstream %s response and never invokes native update", async (state) => {
		mocks.invoke.mockResolvedValue({
			state,
			version: "99.0.0",
			error: "remote detail",
		});
		const { checkForUpdateAndNotify, checkForUpdateNow } = await import(
			"./use-app-update"
		);
		const status = await checkForUpdateNow();
		expect(status?.state).toBe("disabled");
		await checkForUpdateAndNotify();
		expect(mocks.invoke).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith(
			expect.objectContaining({
				title: "Automatic updates disabled",
				description: expect.stringContaining("matching reviewed build"),
			}),
		);
		expect(mocks.toast.mock.calls[0]?.[0].action).toBeUndefined();
	});
	it("reports disabled state even when the native bridge is unavailable", async () => {
		mocks.invoke.mockRejectedValue(new Error("no bridge"));
		const { checkForUpdateAndNotify } = await import("./use-app-update");
		await checkForUpdateAndNotify();
		expect(mocks.invoke).not.toHaveBeenCalled();
		expect(mocks.toast).toHaveBeenCalledWith(
			expect.objectContaining({ title: "Automatic updates disabled" }),
		);
	});
	it("refuses stale restart-to-install actions without invoking native restart", async () => {
		const { restartToApplyUpdate } = await import("./use-app-update");
		expect(await restartToApplyUpdate()).toBe(false);
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
	it("mounts and remounts without update polling or ready notifications", async () => {
		const { useAppUpdate, useAppUpdateStatus } = await import(
			"./use-app-update"
		);
		const interval = vi.spyOn(globalThis, "setInterval");
		const container = document.createElement("div");
		function Probe() {
			useAppUpdate();
			return <span>{useAppUpdateStatus().state}</span>;
		}
		for (let pass = 0; pass < 2; pass++) {
			const root = createRoot(container);
			await act(async () => {
				root.render(<Probe />);
			});
			expect(container.textContent).toBe("disabled");
			await act(async () => {
				root.unmount();
			});
		}
		expect(interval).not.toHaveBeenCalled();
		expect(mocks.invoke).not.toHaveBeenCalled();
		expect(mocks.toast).not.toHaveBeenCalled();
		interval.mockRestore();
	});
});
