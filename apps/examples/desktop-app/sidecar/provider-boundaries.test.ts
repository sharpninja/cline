// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
	settings: vi.fn(),
	config: vi.fn(),
	load: vi.fn(),
	saveVoice: vi.fn(),
	add: vi.fn(),
	update: vi.fn(),
	stream: vi.fn(),
	transcribe: vi.fn(),
	backend: vi.fn(),
	importer: vi.fn(),
	importMany: vi.fn(),
	connect: vi.fn(),
	command: vi.fn(),
	voice: undefined as { providerId: string; modelId: string } | undefined,
}));
vi.mock("@cline/core", async () => ({
	...(await vi.importActual<typeof import("@cline/core")>("@cline/core")),
	ProviderSettingsManager: class {
		constructor() {
			calls.settings();
		}
		getVoiceInputSettings() {
			return calls.voice;
		}
		getProviderConfig(...args: unknown[]) {
			calls.config(...args);
			return undefined;
		}
	},
	getProviderAuthHandler: (id: string) =>
		id === "alias-cloud" ? { storageProviderId: "cline" } : undefined,
	ensureCustomProvidersLoaded: calls.load,
	saveVoiceInputSettings: calls.saveVoice,
	addLocalProvider: calls.add,
	updateLocalProvider: calls.update,
	createConfiguredStreamingTranscriptionSession: calls.stream,
	transcribeConfiguredVoiceInput: calls.transcribe,
	resolveSessionBackend: calls.backend,
	SessionImportService: class {
		constructor() {
			calls.importer();
		}
		importMany = calls.importMany;
	},
}));
vi.mock("./context", async () => ({
	...(await vi.importActual<typeof import("./context")>("./context")),
	ensureSharedHubClient: async () => {
		calls.connect();
		return { command: calls.command };
	},
}));
import { handleCommand } from "./commands";
import { createSidecarContext } from "./context";
let dir: string;
beforeEach(() => {
	vi.clearAllMocks();
	dir = mkdtempSync(join(tmpdir(), "qb-provider-boundary-"));
	vi.stubEnv("CLINE_DATA_DIR", dir);
	calls.voice = undefined;
	calls.command.mockResolvedValue({
		ok: true,
		payload: { schedule: { id: "scheduled" } },
	});
	calls.saveVoice.mockImplementation(async (_manager, selection) => ({
		voiceInput: selection,
	}));
	calls.add.mockImplementation(async (_manager, selection) => selection);
	calls.update.mockImplementation(async (_manager, selection) => selection);
	calls.stream.mockResolvedValue({ token: "test-session-token" });
	calls.transcribe.mockResolvedValue({ text: "test words" });
	calls.importMany.mockResolvedValue([]);
	calls.backend.mockResolvedValue({});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new Error("unexpected network");
		}),
	);
});
afterEach(() => {
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	rmSync(dir, { recursive: true, force: true });
});
const routine = {
	name: "test",
	prompt: "test",
	workspace_root: "/tmp/workspace",
	cron_pattern: "0 * * * *",
	schedule_id: "schedule-1",
};
describe("explicit direct provider selection", () => {
	it.each([
		"create_routine_schedule",
		"update_routine_schedule",
		"import_sessions",
	])("rejects missing or excluded targets before %s performs work", async (command) => {
		for (const provider of [
			undefined,
			"",
			"cline",
			" CLINE-PASS ",
			"alias-cloud",
		]) {
			await expect(
				handleCommand(createSidecarContext(dir), command, {
					...routine,
					selections: [{ tool: "claude-code", sourceId: "test" }],
					provider,
					model: "direct-model",
				}),
			).rejects.toThrow(/direct model provider|No model provider configured/);
		}
		expect(calls.connect).not.toHaveBeenCalled();
		expect(calls.command).not.toHaveBeenCalled();
		expect(calls.backend).not.toHaveBeenCalled();
		expect(calls.importer).not.toHaveBeenCalled();
	});
	it.each([
		"create_routine_schedule",
		"update_routine_schedule",
		"import_sessions",
	])("rejects an absent model before %s without substituting a Cline default", async (command) => {
		await expect(
			handleCommand(createSidecarContext(dir), command, {
				...routine,
				selections: [{ tool: "claude-code", sourceId: "test" }],
				provider: "openai",
			}),
		).rejects.toThrow(/model/i);
		expect(calls.connect).not.toHaveBeenCalled();
		expect(calls.backend).not.toHaveBeenCalled();
	});
	it.each([
		"create_routine_schedule",
		"update_routine_schedule",
	])("preserves the explicit provider and model in %s", async (command) => {
		await handleCommand(createSidecarContext(dir), command, {
			...routine,
			provider: "openai",
			model: "chosen-model",
		});
		expect(calls.command).toHaveBeenCalledWith(
			command === "create_routine_schedule"
				? "schedule.create"
				: "schedule.update",
			expect.objectContaining({
				modelSelection: { providerId: "openai", modelId: "chosen-model" },
			}),
		);
	});
	it("preserves explicit import execution selection", async () => {
		await handleCommand(createSidecarContext(dir), "import_sessions", {
			selections: [{ tool: "claude-code", sourceId: "test" }],
			provider: "openai",
			model: "chosen-model",
		});
		expect(calls.importMany).toHaveBeenCalledWith(
			expect.any(Array),
			expect.any(Function),
			{ provider: "openai", model: "chosen-model" },
		);
	});
	it.each([
		"save_voice_input_settings",
		"add_provider",
		"update_provider_models",
		"list_provider_models",
		"list_transcription_models",
	])("rejects cloud IDs and storage aliases in %s before settings access", async (command) => {
		for (const provider of ["cline", " CLINE-PASS ", "alias-cloud"]) {
			await expect(
				handleCommand(createSidecarContext(dir), command, {
					provider,
					provider_id: provider,
					model: "test",
				}),
			).rejects.toThrow(/unavailable in cline-qb/);
		}
		for (const fn of [
			calls.settings,
			calls.load,
			calls.saveVoice,
			calls.add,
			calls.update,
		])
			expect(fn).not.toHaveBeenCalled();
	});
	it.each([
		"create_streaming_transcription_session",
		"transcribe_audio",
	])("rejects excluded saved voice targets in %s before provider config or transport", async (command) => {
		for (const providerId of ["cline", "CLINE-PASS", "alias-cloud"]) {
			calls.voice = { providerId, modelId: "test" };
			await expect(
				handleCommand(createSidecarContext(dir), command, {
					audioBase64: "aGVsbG8=",
				}),
			).rejects.toThrow(/unavailable in cline-qb/);
		}
		for (const fn of [calls.config, calls.stream, calls.transcribe])
			expect(fn).not.toHaveBeenCalled();
	});
	it.each([
		"create_streaming_transcription_session",
		"transcribe_audio",
	])("keeps explicit direct-provider voice execution in %s", async (command) => {
		calls.voice = { providerId: "openai", modelId: "chosen-model" };
		await expect(
			handleCommand(createSidecarContext(dir), command, {
				audioBase64: "aGVsbG8=",
			}),
		).resolves.toBeDefined();
		expect(
			command === "transcribe_audio" ? calls.transcribe : calls.stream,
		).toHaveBeenCalledOnce();
	});
	it("allows clearing voice selection and configuring a direct provider", async () => {
		const ctx = createSidecarContext(dir);
		await handleCommand(ctx, "save_voice_input_settings", {
			provider: "",
			model: "",
		});
		expect(calls.saveVoice).toHaveBeenCalledWith(expect.anything(), undefined);
		await handleCommand(ctx, "add_provider", {
			provider_id: "self-hosted",
			base_url: "https://owned.example",
		});
		expect(calls.add).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ providerId: "self-hosted" }),
		);
	});
});

it.each([
	"create_streaming_transcription_session",
	"transcribe_audio",
])("revalidates voice selection when %s rereads it", async (command) => {
	calls.voice = { providerId: "openai", modelId: "test" };
	const operation =
		command === "transcribe_audio" ? calls.transcribe : calls.stream;
	operation.mockImplementationOnce(async (manager) => {
		calls.voice = { providerId: "cline", modelId: "test" };
		const selection = manager.getVoiceInputSettings();
		manager.getProviderConfig(selection.providerId);
		return { text: "unexpected" };
	});
	await expect(
		handleCommand(createSidecarContext(dir), command, {
			audioBase64: "aGVsbG8=",
		}),
	).rejects.toThrow(/unavailable in cline-qb/);
	expect(calls.config).toHaveBeenCalledTimes(1);
	expect(calls.config).toHaveBeenCalledWith("openai", {
		includeKnownModels: false,
	});
});
