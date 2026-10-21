// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { HubUpdateRequiredDialog } from "./hub-update-required-dialog";

const transport = vi.hoisted(() => ({
	invoke: vi.fn(),
	deliver: undefined as undefined | ((value: unknown) => void),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: {
		invoke: transport.invoke,
		subscribe: (_event: string, callback: (value: unknown) => void) => {
			transport.deliver = callback;
			return () => {
				transport.deliver = undefined;
			};
		},
	},
}));
vi.mock("@/components/ui/alert-dialog", () => {
	const Part = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	return {
		AlertDialog: ({
			open,
			children,
		}: {
			open: boolean;
			children: ReactNode;
		}) => (open ? <div>{children}</div> : null),
		AlertDialogAction: Part,
		AlertDialogCancel: Part,
		AlertDialogContent: Part,
		AlertDialogDescription: Part,
		AlertDialogFooter: Part,
		AlertDialogHeader: Part,
		AlertDialogTitle: Part,
	};
});
beforeEach(() => {
	transport.invoke.mockReset();
	localStorage.clear();
});
it.each([
	"build_mismatch",
	"unsupported_protocol",
])("shows matching-build guidance for %s without checking or installing an app update", async (reason) => {
	const container = document.createElement("div");
	const root = createRoot(container);
	try {
		await act(async () => {
			root.render(<HubUpdateRequiredDialog />);
		});
		for (let replay = 0; replay < 2; replay++) {
			await act(async () => {
				transport.deliver?.({ reason, hubBuildId: "other-build" });
			});
			expect(container.textContent).toContain(
				"matching reviewed cline-qb build",
			);
			expect(container.textContent).not.toContain("Update and restart");
			expect(container.textContent).not.toContain("Checking for updates");
			expect(transport.invoke).not.toHaveBeenCalled();
		}
	} finally {
		await act(async () => {
			root.unmount();
		});
	}
});
