// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { CompletionScope } from "./index.js";
import {
	captureWorkspaceFingerprint,
	changedSourcePaths,
	type WorkspaceFingerprint,
} from "./workspace-fingerprint.js";

/** Internal projection of the already authenticated workspace-policy read. */
export interface VerificationCheck {
	id: string;
	argv: readonly string[];
	cwd: string;
	required: boolean;
	triggers: readonly ("code" | "doc")[];
	suiteKind:
		| "build"
		| "typecheck"
		| "unit"
		| "integration"
		| "e2e"
		| "packaging"
		| "other";
	scope: "turn" | "phaseGate";
	pathGlobs: readonly string[];
}
export interface HostVerificationPolicy {
	policyDigest: string;
	document: { workspacePath: string; policy: { checks: VerificationCheck[] } };
}
export interface TestCounts {
	passed: number;
	failed: number;
	skipped: number;
	total: number;
}
export interface VerificationRecord {
	id: string;
	scope: CompletionScope;
	status: "passed" | "failed";
	fingerprint: string;
	policyDigest: string;
	startedAtUtc: string;
	finishedAtUtc: string;
	exitCode: number | null;
	reason?: string;
	counts?: TestCounts;
}
export interface VerificationRunOptions {
	workspacePath: string;
	baseline: WorkspaceFingerprint;
	scope: CompletionScope;
	/** Must invoke the pinned authenticated reader, never accept model policy JSON. */
	readPolicy(): Promise<HostVerificationPolicy>;
	phaseClosing?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}
export class VerificationError extends Error {
	constructor(readonly code: string) {
		super(`Verification blocked: ${code}`);
	}
}
const badPolicy = (): never => {
	throw new VerificationError("policy_configuration");
};
const relativePath = (value: unknown): value is string =>
	typeof value === "string" &&
	!!value.trim() &&
	!isAbsolute(value) &&
	!/^[a-z]:/i.test(value) &&
	!value.includes("\\") &&
	!value.includes("\0") &&
	!value.split("/").includes("..");
const docPath = (path: string): boolean =>
	/\.(md|mdx|rst|adoc|txt)$/i.test(path);
function validatePolicy(policy: HostVerificationPolicy, root: string): void {
	if (
		!policy ||
		!/^[a-f0-9]{64}$/i.test(policy.policyDigest) ||
		!policy.document ||
		typeof policy.document.workspacePath !== "string" ||
		!isAbsolute(policy.document.workspacePath) ||
		resolve(policy.document.workspacePath) !== resolve(root) ||
		!Array.isArray(policy.document.policy?.checks)
	)
		badPolicy();
	const ids = new Set<string>();
	for (const check of policy.document.policy.checks) {
		if (
			!check ||
			typeof check.id !== "string" ||
			!check.id.trim() ||
			ids.has(check.id.toLowerCase()) ||
			!Array.isArray(check.argv) ||
			check.argv.length === 0 ||
			typeof check.argv[0] !== "string" ||
			!check.argv[0].trim() ||
			check.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
			!relativePath(check.cwd) ||
			typeof check.required !== "boolean" ||
			!["turn", "phaseGate"].includes(check.scope) ||
			![
				"build",
				"typecheck",
				"unit",
				"integration",
				"e2e",
				"packaging",
				"other",
			].includes(check.suiteKind) ||
			!Array.isArray(check.triggers) ||
			!check.triggers.length ||
			check.triggers.some(
				(trigger) => trigger !== "code" && trigger !== "doc",
			) ||
			!Array.isArray(check.pathGlobs) ||
			check.pathGlobs.some(
				(glob) => !relativePath(glob) || glob.startsWith("!"),
			)
		)
			badPolicy();
		ids.add(check.id.toLowerCase());
	}
}

/** Source ownership is specified by signed pathGlobs, never test-runner includes. */
export function selectVerificationChecks(
	policy: HostVerificationPolicy,
	before: WorkspaceFingerprint,
	current: WorkspaceFingerprint,
	phaseClosing: boolean,
) {
	validatePolicy(policy, current.workspacePath);
	const changed = changedSourcePaths(before, current);
	const codeChanged = changed.some((path) => !docPath(path));

	const checks = policy.document.policy.checks
		.filter(
			(check) =>
				check.required &&
				(phaseClosing ||
					(check.scope === "turn" &&
						changed.some(
							(path) =>
								check.triggers.includes(docPath(path) ? "doc" : "code") &&
								(check.pathGlobs.length === 0 ||
									check.pathGlobs.some((glob) =>
										minimatch(path, glob, {
											dot: true,
											nonegate: true,
											nocomment: true,
										}),
									)),
						))),
		)
		.map((check) =>
			Object.freeze({
				...check,
				argv: Object.freeze([...check.argv]),
				triggers: Object.freeze([...check.triggers]),
				pathGlobs: Object.freeze([...check.pathGlobs]),
			}),
		)
		.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if ((codeChanged || phaseClosing) && checks.length === 0) badPolicy();
	return { development: changed.length > 0, codeChanged, checks };
}

/** Recognize executed-test summaries, including Bun workspace wrappers. */
export function parseTestCounts(output: string): TestCounts | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal ANSI control sequences from runner output.
	const text = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const summaries: TestCounts[] = [];
	const loose = { passed: 0, failed: 0, skipped: 0, total: 0 };
	let hasLoose = false;
	// Parallel workspace commands can interleave TAP footers. Never combine
	// one workspace's pass count with another workspace's total/failure count.
	type Tap = Partial<
		Record<"tests" | "pass" | "fail" | "cancelled" | "skipped" | "todo", number>
	>;
	const tapStreams = new Map<string, Tap>();
	const finishTap = (tap: Tap): boolean => {
		if (
			["tests", "pass", "fail", "cancelled", "skipped", "todo"].some(
				(key) => tap[key as keyof Tap] === undefined,
			)
		)
			return false;
		summaries.push({
			passed: tap.pass!,
			failed: tap.fail! + tap.cancelled!,
			skipped: tap.skipped! + tap.todo!,
			total: tap.tests!,
		});
		return true;
	};
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine;
		let stream = "";
		// bun -F prefixes each child line; --sequential uses the pipe spelling.
		// Repeated wrappers are possible when a script invokes another workspace.
		for (;;) {
			// A native Rust summary is not a package named test running result.
			if (/^\s*test result:/.test(line)) break;
			const prefix =
				/^((?:@[\w.-]+\/)?[\w.-]+)(?: ([\w:.-]+): |:([\w:.-]+)\s+\| ?)/.exec(
					line,
				);
			if (!prefix) break;
			stream += `${prefix[1]}:${prefix[2] ?? prefix[3]}/`;
			line = line.slice(prefix[0].length);
		}
		const tapField = /^# (tests|pass|fail|cancelled|skipped|todo)\b/.exec(line);
		if (tapField) {
			const value =
				/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
			if (!value) return undefined;
			const key = value[1] as keyof Tap;
			let tap = tapStreams.get(stream) ?? {};
			if (key === "tests" && tap.tests !== undefined) {
				if (!finishTap(tap)) return undefined;
				tap = {};
			}
			if (tap[key] !== undefined) return undefined;
			tap[key] = Number(value[2]);
			tapStreams.set(stream, tap);
			continue;
		}
		if (/^\s*test result:/.test(line)) {
			const rust =
				/^\s*test result: (ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored; (\d+) measured; (\d+) filtered out; finished in \S+\s*$/.exec(
					line,
				);
			if (
				!rust ||
				(rust[1] === "ok" && Number(rust[3]) !== 0) ||
				(rust[1] === "FAILED" && Number(rust[3]) === 0)
			)
				return undefined;
			const passed = Number(rust[2]);
			const failed = Number(rust[3]);
			const skipped = Number(rust[4]) + Number(rust[5]) + Number(rust[6]);
			summaries.push({
				passed,
				failed,
				skipped,
				total: passed + failed + skipped,
			});
			continue;
		}
		const dotnet =
			/Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/i.exec(
				line,
			);
		if (dotnet) {
			summaries.push({
				failed: +dotnet[1],
				passed: +dotnet[2],
				skipped: +dotnet[3],
				total: +dotnet[4],
			});
			continue;
		}
		if (/^\s*Tests(?::|\s)/.test(line)) {
			const summary =
				/^\s*Tests:?\s+(.*?)\s*(?:\((\d+)\)|,?\s*(\d+)\s+total)\s*$/.exec(line);
			if (!summary) return undefined;
			const counts = {
				passed: 0,
				failed: 0,
				skipped: 0,
				total: Number(summary[2] ?? summary[3]),
			};
			const kinds = new Set<string>();
			let duplicate = false;
			const remainder = summary[1]
				.replace(
					/(\d+)\s+(passed|failed|skipped|todo|pending)\b/g,
					(_match, count: string, kind: string) => {
						if (kinds.has(kind)) duplicate = true;
						kinds.add(kind);
						counts[
							kind === "passed"
								? "passed"
								: kind === "failed"
									? "failed"
									: "skipped"
						] += Number(count);
						return "";
					},
				)
				.replace(/[\s,|]/g, "");
			if (duplicate || remainder || !kinds.size) return undefined;
			summaries.push(counts);
			continue;
		}
		const standalone =
			/^\s*(\d+)\s+(pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|todo|pending)(?:\s*\([^\n]*\))?\s*$/i.exec(
				line,
			);
		if (standalone) {
			hasLoose = true;
			const count = Number(standalone[1]);
			const kind = standalone[2].toLowerCase().startsWith("pass")
				? "passed"
				: standalone[2].toLowerCase().startsWith("fail")
					? "failed"
					: "skipped";
			loose[kind] += count;
			loose.total += count;
		}
	}
	for (const tap of tapStreams.values()) if (!finishTap(tap)) return undefined;
	if (hasLoose) summaries.push(loose);
	if (
		!summaries.length ||
		summaries.some(
			(value) =>
				Object.values(value).some(
					(count) => !Number.isSafeInteger(count) || count < 0,
				) || value.total !== value.passed + value.failed + value.skipped,
		)
	)
		return undefined;
	const totals = summaries.reduce(
		(sum, value) => ({
			passed: sum.passed + value.passed,
			failed: sum.failed + value.failed,
			skipped: sum.skipped + value.skipped,
			total: sum.total + value.total,
		}),
		{ passed: 0, failed: 0, skipped: 0, total: 0 },
	);
	return Object.values(totals).every(Number.isSafeInteger) ? totals : undefined;
}

function commandEnvironment(): NodeJS.ProcessEnv {
	const allowed =
		/^(PATH|PATHEXT|HOME|USERPROFILE|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|TERM|CI|DOTNET_ROOT|BUN_INSTALL)$/i;
	return Object.fromEntries(
		Object.entries(process.env).filter(([key]) => allowed.test(key)),
	);
}
type ProcessResult = {
	exitCode: number | null;
	reason?: string;
	output: string;
};
function execute(
	check: VerificationCheck,
	cwd: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<ProcessResult> {
	if (signal?.aborted)
		return Promise.resolve({ exitCode: null, reason: "cancelled", output: "" });
	return new Promise((resolveProcess) => {
		let output = "",
			bytes = 0,
			reason: string | undefined;
		const child = spawn(check.argv[0], check.argv.slice(1), {
			cwd,
			env: commandEnvironment(),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stop = (why: string) => {
			reason ??= why;
			if (!child.pid) return;
			if (process.platform === "win32") {
				const kill = spawn(
					"taskkill",
					["/PID", String(child.pid), "/T", "/F"],
					{ stdio: "ignore", shell: false },
				);
				kill.on("error", () => child.kill());
			} else {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {
					child.kill("SIGKILL");
				}
			}
		};
		const collect = (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 4 * 1024 * 1024) {
				stop("output_limit");
				return;
			}
			output += chunk.toString("utf8");
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const cancel = () => stop("cancelled");
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		child.on("error", () => {
			reason ??= "launch_failed";
		});
		child.on("close", (exitCode, closedSignal) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			if (closedSignal) reason ??= "signal";
			resolveProcess({ exitCode, reason, output });
		});
	});
}

/** Run only authenticated policy commands and keep receipts tied to exact state. */
export async function runVerification(options: VerificationRunOptions) {
	const {
		workspacePath: requestedRoot,
		timeoutMs = 600000,
		signal,
		phaseClosing,
		readPolicy,
	} = options;
	const baseline = structuredClone(options.baseline);
	const scope = Object.freeze({
		workspaceId: options.scope.workspaceId,
		sessionId: options.scope.sessionId,
		turnId: options.scope.turnId,
	});
	if (
		Object.values(scope).some(
			(value) => typeof value !== "string" || !value.trim(),
		) ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1
	)
		badPolicy();
	const workspacePath = await fs.realpath(requestedRoot);
	const policy = structuredClone(await readPolicy());
	validatePolicy(policy, workspacePath);
	const current = await captureWorkspaceFingerprint({
		workspacePath,
		policyDigest: policy.policyDigest,
	});
	const selection = selectVerificationChecks(
		policy,
		baseline,
		current,
		phaseClosing === true,
	);
	const records: VerificationRecord[] = [];
	for (const check of selection.checks) {
		const cwd = await fs.realpath(resolve(workspacePath, check.cwd));
		const local = relative(workspacePath, cwd);
		if (isAbsolute(local) || local === ".." || local.startsWith(`..${sep}`))
			throw new VerificationError("working_directory_boundary");
		const startedAtUtc = new Date().toISOString();
		const outcome = await execute(check, cwd, timeoutMs, signal);
		let reason = outcome.reason;
		const counts = parseTestCounts(outcome.output);
		if (!reason && outcome.exitCode !== 0) reason = "exit_failed";
		if (
			!reason &&
			["unit", "integration", "e2e"].includes(check.suiteKind) &&
			(!counts ||
				counts.total === 0 ||
				counts.failed !== 0 ||
				counts.skipped !== 0)
		)
			reason = "test_evidence_invalid";
		try {
			const after = await captureWorkspaceFingerprint({
				workspacePath,
				policyDigest: policy.policyDigest,
			});
			if (after.hash !== current.hash) reason = "source_changed";
		} catch {
			reason = "source_unavailable";
		}
		try {
			const fresh = await readPolicy();
			validatePolicy(fresh, workspacePath);
			if (fresh.policyDigest !== policy.policyDigest) reason = "policy_changed";
		} catch {
			reason = "policy_unavailable";
		}
		records.push(
			Object.freeze({
				id: check.id,
				scope,
				status: reason ? "failed" : "passed",
				fingerprint: current.hash,
				policyDigest: policy.policyDigest,
				startedAtUtc,
				finishedAtUtc: new Date().toISOString(),
				exitCode: outcome.exitCode,
				...(reason ? { reason } : {}),
				...(counts ? { counts: Object.freeze(counts) } : {}),
			}),
		);
		if (
			reason &&
			[
				"source_changed",
				"source_unavailable",
				"policy_changed",
				"policy_unavailable",
				"timeout",
				"cancelled",
				"output_limit",
				"launch_failed",
			].includes(reason)
		)
			break;
	}
	return Object.freeze({
		configured: true,
		development: selection.development,
		codeChanged: selection.codeChanged,
		fingerprint: current.hash,
		policyDigest: policy.policyDigest,
		requiredIds: Object.freeze(selection.checks.map((check) => check.id)),
		records: Object.freeze(records),
	});
}
