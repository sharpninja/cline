// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import ts from "typescript";
import { DEFAULT_CHAT_CONFIG } from "@/hooks/chat-session/constants";
import {
	applyDesktopExecutionSelection,
	recoverLocalDesktopConfig,
} from "./desktop-execution-recovery";
const page = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
const direct = {
	...DEFAULT_CHAT_CONFIG,
	provider: "anthropic",
	model: "chosen-model",
	apiKey: "test-only-key",
	cwd: "/explicit",
	workspaceRoot: "/explicit",
};
const legacy = {
	...DEFAULT_CHAT_CONFIG,
	executionTarget: "cloud" as const,
	provider: "cline",
	model: "hosted",
	apiKey: "old",
	providerAuth: { providerId: "cline" },
	repoUrl: "https://example.invalid/repo",
	branch: "old",
	cwd: "/sandbox",
	workspaceRoot: "/sandbox",
};
describe("TEST-QB-067: requires_explicit_direct_desktop_recovery", () => {
	it("page has no hosted flag fetch or subscription paths", () => {
		expect(page).not.toMatch(
			/\b(?:get_feature_flags|feature_flags_changed|setCloudAgentsFlagEnabled)\b/,
		);
	});
	it("page has no hosted default or account-backed recovery imports", () => {
		expect(page).not.toMatch(
			/\b(?:CLINE_DEFAULT_MODEL_ID|openPersonalGitHubInstallUrl|openGitHubConnect)\b/,
		);
	});
	it("page has no automatic hosted-to-local conversion", () => {
		expect(page).not.toContain('handleExecutionTargetChange("local")');
	});
	it("explicit direct recovery preserves the exact chosen pair and workspace", () => {
		expect(recoverLocalDesktopConfig(legacy, direct)).toMatchObject({
			provider: "anthropic",
			model: "chosen-model",
			apiKey: "test-only-key",
			cwd: "/explicit",
			workspaceRoot: "/explicit",
			executionTarget: "local",
			repoUrl: undefined,
			branch: undefined,
		});
		expect(legacy.provider).toBe("cline");
	});
	it("explicit direct recovery drops stale hosted auth metadata", () => {
		expect(
			recoverLocalDesktopConfig(legacy, direct).providerAuth,
		).toBeUndefined();
	});
	it("explicit alternate-auth recovery keeps only selected direct auth", () => {
		const auth = { providerId: "codex", capabilities: ["oauth"] };
		expect(
			recoverLocalDesktopConfig(legacy, {
				...direct,
				provider: "codex",
				providerAuth: auth,
			}).providerAuth,
		).toEqual(auth);
	});
	it.each([
		"cline",
		" CLINE ",
		"cline-cloud",
		"cline-pass",
	])("poisoned remembered provider %s stays incomplete", (provider) => {
		expect(
			recoverLocalDesktopConfig(legacy, { ...direct, provider }),
		).toMatchObject({
			provider: "",
			model: "",
			apiKey: "",
			providerAuth: undefined,
		});
	});
	it("missing provider cannot carry an orphan model or credential", () => {
		expect(
			recoverLocalDesktopConfig(legacy, { ...direct, provider: "" }),
		).toMatchObject({ provider: "", model: "", apiKey: "" });
	});
	it("missing model remains missing and is never filled from the old session", () => {
		expect(
			recoverLocalDesktopConfig(legacy, { ...direct, model: "" }).model,
		).toBe("");
	});
});

describe("TEST-QB-067: page execution selection effects", () => {
	const setup = () => ({
		target: "local" as "local" | "cloud",
		hasHostedSession: false,
		persistLocal: vi.fn(),
		changeToLocal: vi.fn(),
		startNewSession: vi.fn(),
		reportBlocked: vi.fn(),
	});
	it("page parses before its policy assertions can count as evidence", () => {
		const parsed = ts.createSourceFile(
			"page.tsx",
			page,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		) as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] };
		expect(parsed.parseDiagnostics).toEqual([]);
	});
	it("the page dispatches through the tested execution selector", () => {
		expect(page).toMatch(/applyDesktopExecutionSelection\(\{/);
		expect(page).toMatch(/recoverLocalDesktopConfig\(/);
	});
	it("hosted target cannot mutate config, preferences or history", () => {
		const options = setup();
		options.target = "cloud";
		applyDesktopExecutionSelection(options);
		expect(options.reportBlocked).toHaveBeenCalledWith(
			expect.stringMatching(/Cloud is unavailable/),
		);
		expect(options.persistLocal).not.toHaveBeenCalled();
		expect(options.changeToLocal).not.toHaveBeenCalled();
		expect(options.startNewSession).not.toHaveBeenCalled();
	});
	it("hosted history requires a new session, not conversion", () => {
		const options = setup();
		options.hasHostedSession = true;
		applyDesktopExecutionSelection(options);
		expect(options.persistLocal).toHaveBeenCalledOnce();
		expect(options.startNewSession).toHaveBeenCalledOnce();
		expect(options.changeToLocal).not.toHaveBeenCalled();
		expect(options.reportBlocked).not.toHaveBeenCalled();
	});
	it("missing new-session capability leaves history and preferences intact", () => {
		const options = {
			...setup(),
			hasHostedSession: true,
			startNewSession: undefined,
		};
		applyDesktopExecutionSelection(options);
		expect(options.reportBlocked).toHaveBeenCalledWith(
			expect.stringMatching(/Open a new session/),
		);
		expect(options.changeToLocal).not.toHaveBeenCalled();
		expect(options.persistLocal).not.toHaveBeenCalled();
	});
	it("explicit permitted target persists once and changes the composer once", () => {
		const options = setup();
		applyDesktopExecutionSelection(options);
		expect(options.persistLocal).toHaveBeenCalledOnce();
		expect(options.changeToLocal).toHaveBeenCalledOnce();
		expect(options.startNewSession).not.toHaveBeenCalled();
		expect(options.reportBlocked).not.toHaveBeenCalled();
	});
	it("hosted sandbox paths cannot leak into a new empty local selection", () => {
		expect(
			recoverLocalDesktopConfig(legacy, {
				...direct,
				cwd: "",
				workspaceRoot: "",
			}),
		).toMatchObject({ cwd: "", workspaceRoot: "", sessionId: undefined });
	});
	it("auth metadata for a different provider cannot accompany the selected pair", () => {
		expect(
			recoverLocalDesktopConfig(legacy, {
				...direct,
				providerAuth: { providerId: "cline" },
			}).providerAuth,
		).toBeUndefined();
	});
});

it("TEST-QB-067: successful environment switch cannot reopen the old hosted thread environment", () => {
	const options = {
		target: "local" as const,
		hasHostedSession: true,
		environmentChanged: true,
		persistLocal: vi.fn(),
		changeToLocal: vi.fn(),
		startNewSession: vi.fn(),
		reportBlocked: vi.fn(),
	};
	applyDesktopExecutionSelection(options);
	expect(options.persistLocal).toHaveBeenCalledOnce();
	expect(options.startNewSession).not.toHaveBeenCalled();
	expect(options.changeToLocal).not.toHaveBeenCalled();
	expect(options.reportBlocked).not.toHaveBeenCalled();
});
