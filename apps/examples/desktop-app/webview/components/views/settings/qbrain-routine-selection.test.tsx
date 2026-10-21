// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RoutineSchedulesContent } from "./routine-view";
const { invoke, catalog, models, remembered } = vi.hoisted(() => ({
	invoke: vi.fn(),
	catalog: vi.fn(),
	models: vi.fn(),
	remembered: vi.fn(),
}));
vi.mock("@/lib/desktop-client", () => ({ desktopClient: { invoke } }));
vi.mock("@/lib/provider-model-catalog", () => ({
	loadProviderModelCatalog: catalog,
	loadProviderModels: models,
}));
vi.mock("@/lib/model-selection", () => ({
	readModelSelectionStorageFromWindow: remembered,
}));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));
vi.mock("@/components/ui/dialog", () => {
	const Wrap = ({ children }: { children: ReactNode }) => <div>{children}</div>;
	return {
		Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
			open ? <div role="dialog">{children}</div> : null,
		DialogContent: Wrap,
		DialogDescription: Wrap,
		DialogFooter: Wrap,
		DialogHeader: Wrap,
		DialogTitle: Wrap,
	};
});
vi.mock("@/components/ui/tooltip", () => {
	const Wrap = ({ children }: { children: ReactNode }) => <>{children}</>;
	return { Tooltip: Wrap, TooltipTrigger: Wrap, TooltipContent: () => null };
});
vi.mock("@/components/ui/combobox", () => ({
	Combobox: ({
		items,
		value,
		onValueChange,
	}: {
		items: string[];
		value: string;
		onValueChange: (v: string) => void;
	}) => (
		<select
			data-routine-picker
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
		>
			<option value="">Choose</option>
			{Array.from(new Set([...items, ...(value ? [value] : [])])).map((v) => (
				<option key={v} value={v}>
					{v}
				</option>
			))}
		</select>
	),
	ComboboxContent: () => null,
	ComboboxEmpty: () => null,
	ComboboxInput: () => null,
	ComboboxItem: () => null,
	ComboboxList: () => null,
}));
vi.mock("@/components/ui/select", () => ({
	Select: ({
		value,
		onValueChange,
	}: {
		value: string;
		onValueChange: (v: string) => void;
	}) => (
		<select
			aria-label="Frequency"
			value={value}
			onChange={(e) => onValueChange(e.target.value)}
		>
			{["once", "daily", "weekly"].map((v) => (
				<option key={v} value={v}>
					{v}
				</option>
			))}
		</select>
	),
	SelectContent: () => null,
	SelectItem: () => null,
	SelectTrigger: () => null,
	SelectValue: () => null,
}));
let root: Root, container: HTMLDivElement;
let timestamp = Date.now();
let schedules: unknown[] = [];
const direct = {
	providerModels: { anthropic: ["direct-model"] },
	enabledProviderIds: ["anthropic"],
};
beforeEach(() => {
	Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
	timestamp += 60000;
	vi.spyOn(Date, "now").mockReturnValue(timestamp);
	vi.clearAllMocks();
	schedules = [];
	catalog.mockReset();
	catalog.mockResolvedValue(direct);
	models.mockReset();
	models.mockResolvedValue([]);
	remembered.mockReturnValue({ lastProvider: "", lastModelByProvider: {} });
	invoke.mockReset();
	invoke.mockImplementation(async (cmd: string) =>
		cmd === "list_routine_schedules"
			? {
					schedules,
					activeExecutions: [],
					upcomingRuns: [],
					lastExecutions: [],
				}
			: cmd === "get_process_context"
				? { cwd: "/test/work", workspaceRoot: "/test/work" }
				: {},
	);
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
});
async function settle() {
	await act(async () => {
		await new Promise((r) => setTimeout(r, 10));
	});
}
async function render() {
	await act(async () => root.render(<RoutineSchedulesContent />));
	await settle();
}
function button(label: string) {
	const b = Array.from(container.querySelectorAll("button")).find(
		(b) =>
			b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
	);
	if (!b) throw new Error(`No button: ${label}`);
	return b;
}
async function click(label: string) {
	await act(async () => button(label).click());
	await settle();
}
function picker(index: number) {
	return container.querySelectorAll<HTMLSelectElement>("[data-routine-picker]")[
		index
	]!;
}
async function choose(element: HTMLSelectElement, value: string) {
	await act(async () => {
		element.value = value;
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await settle();
}
async function name() {
	await act(async () => {
		const input = container.querySelector<HTMLInputElement>("#routine-name")!;
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!.call(input, "Daily direct");
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	await choose(
		container.querySelector('select[aria-label="Frequency"]')!,
		"daily",
	);
}
function writes() {
	return invoke.mock.calls.filter(
		([c]) => c === "create_routine_schedule" || c === "update_routine_schedule",
	);
}
function existing(provider?: string, model?: string) {
	return {
		scheduleId: "existing",
		name: "Existing",
		cronPattern: "0 9 * * *",
		prompt: "Review code",
		provider,
		model,
		mode: "act",
		workspaceRoot: "/test/work",
		maxParallel: 1,
		enabled: false,
		createdAt: 0,
		updatedAt: 0,
	};
}
it("TEST-QB-063: surfaces_schedule_catalog_failure_without_fallback / AC018 empty catalog does not invent a schedule provider or model", async () => {
	catalog.mockResolvedValue({ providerModels: {}, enabledProviderIds: [] });
	await render();
	await click("New Schedule");
	expect(picker(0).value).toBe("");
	expect(picker(1).value).toBe("");
	await name();
	await click("Create Schedule");
	expect(writes()).toEqual([]);
	expect(container.textContent).toMatch(/select.*provider|choose.*provider/i);
});
it("TEST-QB-063: surfaces_schedule_catalog_failure_without_fallback / AC018 catalog failure stays visible without synthetic fallback choices", async () => {
	catalog.mockRejectedValue(new Error("Catalog unavailable"));
	await render();
	await click("New Schedule");
	expect(picker(0).options.length).toBe(1);
	expect(container.textContent).toContain("Catalog unavailable");
	expect(container.textContent).toContain("Settings");
});
it("TEST-QB-063: surfaces_schedule_catalog_failure_without_fallback / AC017 stale cloud catalog and remembered selection cannot restore hosted scheduling", async () => {
	catalog.mockResolvedValue({
		providerModels: { " CLINE ": ["hosted"], ...direct.providerModels },
		enabledProviderIds: [" CLINE ", "anthropic"],
	});
	remembered.mockReturnValue({
		lastProvider: " CLINE ",
		lastModelByProvider: { " CLINE ": "hosted" },
	});
	await render();
	await click("New Schedule");
	expect(Array.from(picker(0).options).map((o) => o.value)).toEqual([
		"",
		"anthropic",
	]);
	expect(picker(0).value).toBe("");
	expect(models).not.toHaveBeenCalled();
});
it("TEST-QB-064: preserves_explicit_schedule_provider_model_selection / AC018 creates a schedule using only the explicit direct provider and model", async () => {
	await render();
	await click("New Schedule");
	expect(picker(0).value).toBe("");
	await name();
	await choose(picker(0), "anthropic");
	await choose(picker(1), "direct-model");
	await click("Create Schedule");
	expect(writes()).toHaveLength(1);
	expect(writes()[0]).toEqual([
		"create_routine_schedule",
		expect.objectContaining({
			provider: "anthropic",
			model: "direct-model",
			name: "Daily direct",
			workspace_root: "/test/work",
		}),
	]);
});
it("TEST-QB-064: preserves_explicit_schedule_provider_model_selection / AC018 editing a direct schedule preserves its exact selection despite a changed catalog", async () => {
	schedules = [existing("openrouter", "retired-model")];
	await render();
	await click("Edit Existing");
	expect(picker(0).value).toBe("openrouter");
	expect(picker(1).value).toBe("retired-model");
	await click("Save Changes");
	expect(writes()).toEqual([
		[
			"update_routine_schedule",
			expect.objectContaining({
				provider: "openrouter",
				model: "retired-model",
				schedule_id: "existing",
			}),
		],
	]);
});
it("TEST-QB-065: requires_explicit_replacement_of_hosted_schedule_selection / AC017 editing a legacy cloud schedule requires explicit direct replacement", async () => {
	schedules = [existing("cline", "hosted")];
	await render();
	await click("Edit Existing");
	expect(picker(0).value).toBe("");
	expect(picker(1).value).toBe("");
	expect(models).not.toHaveBeenCalled();
	await click("Save Changes");
	expect(writes()).toEqual([]);
	await choose(picker(0), "anthropic");
	await choose(picker(1), "direct-model");
	await click("Save Changes");
	expect(writes()).toHaveLength(1);
	expect(writes()[0][1]).toMatchObject({
		provider: "anthropic",
		model: "direct-model",
	});
});

it("TEST-QB-064: preserves_explicit_schedule_provider_model_selection / AC018 missing model cannot be silently supplied from the provider catalog", async () => {
	await render();
	await click("New Schedule");
	await name();
	await choose(picker(0), "anthropic");
	expect(picker(1).value).toBe("");
	await click("Create Schedule");
	expect(writes()).toEqual([]);
	expect(container.textContent).toContain("Choose a model");
});
it("TEST-QB-064: preserves_explicit_schedule_provider_model_selection / AC018 remembered direct selection remains usable without substitution", async () => {
	remembered.mockReturnValue({
		lastProvider: "anthropic",
		lastModelByProvider: { anthropic: "direct-model" },
	});
	await render();
	await click("New Schedule");
	expect(picker(0).value).toBe("anthropic");
	expect(picker(1).value).toBe("direct-model");
	await name();
	await click("Create Schedule");
	expect(writes()).toHaveLength(1);
	expect(writes()[0][1]).toMatchObject({
		provider: "anthropic",
		model: "direct-model",
	});
});
it("TEST-QB-063: surfaces_schedule_catalog_failure_without_fallback / AC018 a catalog with no enabled providers does not enable every provider", async () => {
	catalog.mockResolvedValue({ ...direct, enabledProviderIds: [] });
	await render();
	await click("New Schedule");
	expect(picker(0).options.length).toBe(1);
	expect(picker(0).value).toBe("");
});

it("TEST-QB-066: keeps_migrated_schedule_model_selection_atomic / AC018 partial modern model selection cannot borrow a legacy provider or model", async () => {
	schedules = [
		{
			...existing("cline", "legacy-hosted-model"),
			modelSelection: { providerId: "anthropic" },
		},
	];
	await render();
	await click("Edit Existing");
	expect(picker(0).value).toBe("anthropic");
	expect(picker(1).value).toBe("");
	await click("Save Changes");
	expect(writes()).toEqual([]);
});
it.each([
	null,
	{ providerId: 42, modelId: "valid" },
	{ providerId: "anthropic", modelId: 42 },
	{ modelId: "orphan" },
])("TEST-QB-066: keeps_migrated_schedule_model_selection_atomic / AC066 malformed structured pair remains incomplete: %j", async (modelSelection) => {
	schedules = [{ ...existing("anthropic", "legacy-model"), modelSelection }];
	await render();
	await click("Edit Existing");
	await click("Save Changes");
	expect(writes()).toEqual([]);
	expect(container.textContent).toMatch(/choose a (direct provider|model)/i);
});
