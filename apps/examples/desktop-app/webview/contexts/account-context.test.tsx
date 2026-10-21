// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ACCOUNT_IDENTITY_STORAGE_KEY,
	AccountProvider,
	useAccount,
} from "./account-context";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/lib/desktop-client", () => ({ desktopClient: { invoke } }));
let container: HTMLDivElement;
let root: Root;
function Probe() {
	const state = useAccount();
	return (
		<div>
			<span>
				{JSON.stringify({
					user: state.user,
					ready: state.accountReady,
					organizations: state.organizations,
					active: state.activeOrganization,
				})}
			</span>
			<button type="button" onClick={() => void state.refreshAccount()}>Refresh</button>
		</div>
	);
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	localStorage.clear();
	invoke
		.mockReset()
		.mockResolvedValue({ email: "old@example.test", displayName: "Legacy" });
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});
describe("account context exclusion", () => {
	it.each([
		null,
		"malformed",
		JSON.stringify({
			user: {
				email: "old@example.test",
				displayName: "Legacy",
				organizations: [{ active: true, name: "Old org" }],
			},
		}),
	])("ignores and preserves cached identity %s through mount/refresh/reconnect", async (raw) => {
		if (raw !== null) localStorage.setItem(ACCOUNT_IDENTITY_STORAGE_KEY, raw);
		const getItem = vi.spyOn(Storage.prototype, "getItem");
		const setItem = vi.spyOn(Storage.prototype, "setItem");
		const removeItem = vi.spyOn(Storage.prototype, "removeItem");
		for (let round = 0; round < 2; round++) {
			await act(async () =>
				root.render(
					<AccountProvider key={round}>
						<Probe />
					</AccountProvider>,
				),
			);
			await act(async () => container.querySelector("button")?.click());
			expect(container.querySelector("span")?.textContent).toBe(
				JSON.stringify({
					user: null,
					ready: true,
					organizations: [],
					active: null,
				}),
			);
		}
		expect(invoke).not.toHaveBeenCalled();
		expect(getItem).not.toHaveBeenCalled();
		expect(setItem).not.toHaveBeenCalled();
		expect(removeItem).not.toHaveBeenCalled();
		vi.restoreAllMocks();
		expect(localStorage.getItem(ACCOUNT_IDENTITY_STORAGE_KEY)).toBe(raw);
	});
});
