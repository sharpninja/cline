// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AccountView } from "./account-view";
const { invoke, openExternalUrl } = vi.hoisted(() => ({
	invoke: vi.fn(),
	openExternalUrl: vi.fn(),
}));
vi.mock("@/lib/desktop-client", () => ({
	desktopClient: { invoke },
	openExternalUrl,
}));
it("explains account exclusion without account queries, sign-in, billing links, or remote images", async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	invoke.mockResolvedValue({
		signedIn: false,
		code: "ACCOUNT_NOT_AUTHENTICATED",
	});
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		await act(async () => root.render(<AccountView />));
		expect(container.textContent).toContain(
			"Cline account services are unavailable",
		);
		expect(container.textContent).toContain("direct model provider");
		expect(container.querySelector("button, a, img")).toBeNull();
		expect(invoke).not.toHaveBeenCalled();
		expect(openExternalUrl).not.toHaveBeenCalled();
	} finally {
		await act(async () => root.unmount());
		container.remove();
		vi.unstubAllGlobals();
	}
});
