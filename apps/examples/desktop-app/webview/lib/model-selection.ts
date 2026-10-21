import {
	assertDirectProvider,
	isClineCloudProvider,
	rejectClineAccount,
} from "@cline/qbrain-governance/cloud-policy";
export const MODEL_SELECTION_STORAGE_KEY = "cline-qb.code.model-selection.v1";

export type ModelSelectionStorage = {
	lastProvider: string;
	lastModelByProvider: Record<string, string>;
};

function sanitizeStringRecord(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return Object.fromEntries(
		Object.entries(value).filter(
			([key, entry]) =>
				typeof key === "string" &&
				!isClineCloudProvider(key) &&
				typeof entry === "string" &&
				entry.trim().length > 0,
		),
	);
}

export function parseModelSelectionStorage(
	raw: string | null,
): ModelSelectionStorage {
	const empty: ModelSelectionStorage = {
		lastProvider: "",
		lastModelByProvider: {},
	};
	if (!raw) {
		return empty;
	}

	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return empty;
		}

		const shaped = parsed as {
			lastProvider?: unknown;
			lastModelByProvider?: unknown;
		};

		if ("lastProvider" in shaped || "lastModelByProvider" in shaped) {
			return {
				lastProvider:
					typeof shaped.lastProvider === "string" &&
					!isClineCloudProvider(shaped.lastProvider)
						? shaped.lastProvider.trim()
						: "",
				lastModelByProvider: sanitizeStringRecord(shaped.lastModelByProvider),
			};
		}

		return {
			lastProvider: "",
			lastModelByProvider: sanitizeStringRecord(parsed),
		};
	} catch {
		return empty;
	}
}

export function readModelSelectionStorageFromWindow(
	scope: ExecutionTarget = "local",
): ModelSelectionStorage {
	if (scope !== "cloud" && typeof window !== "undefined") {
		try {
			return parseModelSelectionStorage(
				window.localStorage.getItem(MODEL_SELECTION_STORAGE_KEY),
			);
		} catch {}
	}
	return { lastProvider: "", lastModelByProvider: {} };
}

export function writeModelSelectionStorageToWindow(
	value: ModelSelectionStorage,
	scope: ExecutionTarget = "local",
): void {
	if (scope === "cloud") rejectClineAccount();
	assertDirectProvider(value.lastProvider);
	if (typeof window === "undefined") {
		return;
	}
	window.localStorage.setItem(
		modelSelectionStorageKey(scope),
		JSON.stringify(value),
	);
}

export const REASONING_SELECTION_STORAGE_KEY =
	"cline-qb.code.reasoning-selection.v1";

export const REASONING_SELECTION_VALUES = [
	"none",
	"low",
	"medium",
	"high",
	"xhigh",
] as const;

export type ReasoningSelectionValue =
	(typeof REASONING_SELECTION_VALUES)[number];

/** Last reasoning effort picked for each provider, like `lastModelByProvider`. */
export function readReasoningSelectionStorageFromWindow(): Record<
	string,
	ReasoningSelectionValue
> {
	if (typeof window === "undefined") {
		return {};
	}
	try {
		const parsed = JSON.parse(
			window.localStorage.getItem(REASONING_SELECTION_STORAGE_KEY) ?? "null",
		) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return {};
		}
		return Object.fromEntries(
			Object.entries(parsed).filter(
				(entry): entry is [string, ReasoningSelectionValue] =>
					(REASONING_SELECTION_VALUES as readonly string[]).includes(
						entry[1] as string,
					),
			),
		);
	} catch {
		return {};
	}
}

export function writeReasoningSelectionToWindow(
	providerId: string,
	value: ReasoningSelectionValue,
): void {
	if (typeof window === "undefined") {
		return;
	}
	window.localStorage.setItem(
		REASONING_SELECTION_STORAGE_KEY,
		JSON.stringify({
			...readReasoningSelectionStorageFromWindow(),
			[providerId]: value,
		}),
	);
}

export type ExecutionTarget = "local" | "cloud";
export const EXECUTION_TARGET_STORAGE_KEY = "cline-qb.code.execution-target.v1";

function modelSelectionStorageKey(scope: ExecutionTarget): string {
	// Cloud has a different model catalog; keep the local provider/model intact.
	return scope === "cloud"
		? "cline-qb.code.cloud-model-selection.v1"
		: MODEL_SELECTION_STORAGE_KEY;
}

export function readExecutionTargetFromWindow(): ExecutionTarget {
	return "local";
}

export function writeExecutionTargetToWindow(target: ExecutionTarget): void {
	if (target === "cloud") rejectClineAccount();
	try {
		if (typeof window !== "undefined") {
			window.localStorage.setItem(
				EXECUTION_TARGET_STORAGE_KEY,
				JSON.stringify({ target }),
			);
		}
	} catch {
		// Ignore localStorage persistence failures.
	}
}
