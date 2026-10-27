import {
	createLocalHubScheduleRuntimeHandlers,
	HubScheduleCommandService,
	HubScheduleService,
} from "@cline/core";
import { requireDirectProvider } from "@cline/qbrain-governance/cloud-policy";
import {
	ONE_TIME_SCHEDULE_CRON_PATTERN,
	ONE_TIME_SCHEDULE_RUN_AT_METADATA_KEY,
	readHubScheduleMode,
} from "@cline/shared";
import { asTrimmedString, toPositiveInt } from "./utils";
import { providerSettingsManager } from "./deps";
import { admitSchedulePair, readExplicitSchedulePair, requireDirectSchedulePair } from "./qbrain-schedule-admission";
import { readRegisteredScheduleCatalog } from "./qbrain-schedule-catalog";

let scheduleService: HubScheduleService | undefined;
let scheduleCommands: HubScheduleCommandService | undefined;

function getCommands(): HubScheduleCommandService {
	if (!scheduleService || !scheduleCommands) {
		scheduleService = new HubScheduleService({
			runtimeHandlers: createDirectScheduleRuntimeHandlers(),
		});
		scheduleCommands = new HubScheduleCommandService(scheduleService);
	}
	return scheduleCommands;
}

async function clientCommand(
	hubCommand: string,
	payload?: Record<string, unknown>,
	workspaceRoot = process.cwd(),
): Promise<Record<string, unknown>> {
	const reply = await getCommands().handleCommand(
		{
			version: "v1",
			clientId: "cline-hub-schedules",
			command: hubCommand as never,
			payload,
		},
		{
			clientId: "cline-hub-schedules",
			workspaceContext: { workspaceRoot, cwd: workspaceRoot },
		},
	);
	if (!reply.ok) {
		throw new Error(
			reply.error?.message ?? `hub command failed: ${hubCommand}`,
		);
	}
	return (reply.payload ?? {}) as Record<string, unknown>;
}

function routineScheduleTiming(
	args?: Record<string, unknown>,
): { cronPattern: string; metadata?: Record<string, number> } | undefined {
	if (args?.schedule_type === "once") {
		const runAt =
			typeof args.run_at === "number" ? args.run_at : Number(args?.run_at);
		return Number.isFinite(runAt)
			? {
					cronPattern: ONE_TIME_SCHEDULE_CRON_PATTERN,
					metadata: { [ONE_TIME_SCHEDULE_RUN_AT_METADATA_KEY]: runAt },
				}
			: undefined;
	}
	const cronPattern = asTrimmedString(args?.cron_pattern);
	return cronPattern ? { cronPattern } : undefined;
}

function asTrimmedStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const values = value
		.map((item) => asTrimmedString(item))
		.filter((item): item is string => item !== undefined);
	return values.length > 0 ? values : undefined;
}

export async function handleRoutineScheduleCommand(
	command: string,
	args?: Record<string, unknown>,
	workspaceRoot = process.cwd(),
): Promise<unknown> {
	const commandHub = (hubCommand: string, payload?: Record<string, unknown>) =>
		clientCommand(hubCommand, payload, workspaceRoot);
	if (command === "list_routine_schedules") {
		const [schedules, activeExecutions, upcomingRuns] = await Promise.all([
			commandHub("schedule.list", {
				limit: toPositiveInt(args?.limit) ?? 200,
			}),
			commandHub("schedule.active"),
			commandHub("schedule.upcoming", { limit: 30 }),
		]);
		const scheduleRows = Array.isArray(schedules.schedules)
			? schedules.schedules
			: [];
		const lastExecutions = await Promise.all(
			scheduleRows.map(async (schedule) => {
				const scheduleId = asTrimmedString(
					(schedule as Record<string, unknown>).scheduleId,
				);
				if (!scheduleId) return undefined;
				const reply = await commandHub("schedule.list_executions", {
					scheduleId,
					limit: 1,
				});
				return Array.isArray(reply.executions)
					? reply.executions[0]
					: undefined;
			}),
		);
		return {
			schedules: scheduleRows,
			activeExecutions: activeExecutions.executions ?? [],
			upcomingRuns: upcomingRuns.runs ?? [],
			lastExecutions: lastExecutions.filter(Boolean),
		};
	}

	if (command === "create_routine_schedule") {
		const name = asTrimmedString(args?.name);
		const timing = routineScheduleTiming(args);
		const prompt = asTrimmedString(args?.prompt);
		const routineWorkspaceRoot = asTrimmedString(args?.workspace_root);
		if (!name || !timing || !prompt || !routineWorkspaceRoot) {
			throw new Error(
				"createSchedule requires name, timing, prompt, and workspace_root",
			);
		}
		const created = await commandHub("schedule.create", {
			name,
			...timing,
			prompt,
			modelSelection: await directScheduleSelection(args),
			mode: readHubScheduleMode(args, "yolo"),
			workspaceRoot: routineWorkspaceRoot,
			cwd: asTrimmedString(args?.cwd),
			systemPrompt: asTrimmedString(args?.system_prompt),
			maxIterations: toPositiveInt(args?.max_iterations),
			timeoutSeconds: toPositiveInt(args?.timeout_seconds),
			maxParallel: toPositiveInt(args?.max_parallel) ?? 1,
			enabled: args?.enabled !== false,
			tags: asTrimmedStringArray(args?.tags),
		});
		return { schedule: created.schedule ?? null };
	}

	const scheduleId = asTrimmedString(args?.schedule_id);
	if (!scheduleId) throw new Error(`${command} requires schedule_id`);
	if (command === "update_routine_schedule") {
		const mode = readHubScheduleMode(args);
		const name = asTrimmedString(args?.name);
		const timing = routineScheduleTiming(args);
		const prompt = asTrimmedString(args?.prompt);
		const routineWorkspaceRoot = asTrimmedString(args?.workspace_root);
		if (!name || !timing || !prompt || !routineWorkspaceRoot) {
			throw new Error(
				"updateSchedule requires schedule_id, name, timing, prompt, and workspace_root",
			);
		}
				const hasSelection = !!args && (Object.prototype.hasOwnProperty.call(args, "modelSelection") ||
			["provider", "providerId", "model", "modelId"].some((key) => args[key] !== undefined));
		if (hasSelection) validateDirectScheduleSelection(args);
		const existing = await commandHub("schedule.get", { scheduleId });
		const selection = await directScheduleSelection(hasSelection ? args : existing.schedule as Record<string, unknown>);
		const reply = await commandHub("schedule.update", {
			scheduleId,
			name,
			...timing,
			prompt,
			modelSelection: selection,
			...(mode === undefined ? {} : { mode }),
			workspaceRoot: routineWorkspaceRoot,
			cwd: asTrimmedString(args?.cwd) ?? null,
			systemPrompt:
				args?.system_prompt === null
					? null
					: asTrimmedString(args?.system_prompt),
			maxIterations:
				args?.max_iterations === null
					? null
					: toPositiveInt(args?.max_iterations),
			timeoutSeconds:
				args?.timeout_seconds === null
					? null
					: toPositiveInt(args?.timeout_seconds),
			maxParallel: toPositiveInt(args?.max_parallel) ?? 1,
			enabled: args?.enabled !== false,
			tags: asTrimmedStringArray(args?.tags) ?? [],
		});
		return { schedule: reply.schedule ?? null };
	}
	if (command === "pause_routine_schedule") {
		const reply = await commandHub("schedule.disable", { scheduleId });
		return { schedule: reply.schedule ?? null };
	}
	if (command === "resume_routine_schedule") {
		const existing = await commandHub("schedule.get", { scheduleId });
		await assertStoredSchedule(existing.schedule);
		const reply = await commandHub("schedule.enable", { scheduleId });
		return { schedule: reply.schedule ?? null };
	}
	if (command === "trigger_routine_schedule") {
		const existing = await commandHub("schedule.get", { scheduleId });
		if (!existing.schedule)
			throw new Error(`schedule not found: ${scheduleId}`);
		await assertStoredSchedule(existing.schedule);
		const reply = await commandHub("schedule.trigger", {
			scheduleId,
			wait: false,
		});
		return { execution: reply.execution ?? null };
	}
	if (command === "delete_routine_schedule") {
		const reply = await commandHub("schedule.delete", { scheduleId });
		return { deleted: reply.deleted === true };
	}
	throw new Error(`unsupported routine schedule command: ${command}`);
}

function validateDirectScheduleSelection(args?: Record<string, unknown>) {
	if (!args || (!Object.prototype.hasOwnProperty.call(args, "modelSelection") && !asTrimmedString(args.providerId ?? args.provider))) {
		throw new Error("Select both a direct model provider and model explicitly in Settings.");
	}
	return requireDirectSchedulePair(readExplicitSchedulePair(args));
}
async function directScheduleSelection(args?: Record<string, unknown>) {
	validateDirectScheduleSelection(args);
	return admitSchedulePair(args, (providerId) =>
		readRegisteredScheduleCatalog(providerId, providerSettingsManager),
	);
}
async function assertStoredSchedule(value: unknown): Promise<void> {
	if (!value || typeof value !== "object")
		throw new Error("Schedule not found.");
	const pair = readExplicitSchedulePair(value);
	requireDirectSchedulePair(pair);
	await admitSchedulePair(value, (providerId) =>
		readRegisteredScheduleCatalog(providerId, providerSettingsManager),
	);
}

export function createDirectScheduleRuntimeHandlers(): ReturnType<
	typeof createLocalHubScheduleRuntimeHandlers
> {
	let runtime:
		| ReturnType<typeof createLocalHubScheduleRuntimeHandlers>
		| undefined;
	const admitted = new Set<string>();
	return {
		async startSession(request, options) {
			requireDirectProvider(request.provider);
			if (!request.model?.trim())
				throw new Error(
					"Configure an explicit direct provider model for this schedule.",
				);
			runtime ??= createLocalHubScheduleRuntimeHandlers();
			const result = await runtime.startSession(request, options);
			admitted.add(result.sessionId);
			return result;
		},
		async sendSession(id, request) {
			if (!runtime || !admitted.has(id))
				throw new Error(
					"Scheduled session has no direct-provider admission. Start a new governed schedule run.",
				);
			return runtime.sendSession(id, request);
		},
		async abortSession(id) {
			return runtime && admitted.has(id)
				? runtime.abortSession(id)
				: { applied: false };
		},
		async stopSession(id) {
			if (!runtime || !admitted.has(id)) return { applied: false };
			const result = await runtime.stopSession(id);
			admitted.delete(id);
			return result;
		},
	};
}
