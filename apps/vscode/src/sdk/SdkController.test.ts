import { describe, expect, it, vi } from "vitest"
import { telemetryService } from "@/services/telemetry"
import { isClineManagedProvider } from "@/shared/utils/cline"
import { Controller as SdkController } from "./SdkController"
import { createTaskProxy, type TaskProxy } from "./task-proxy"
import { resolveWorkspaceManagerPaths, resolveWorkspaceRootPath } from "./workspace-root"

describe("isClineManagedProvider", () => {
	it("treats both Cline account providers as Cline providers", () => {
		expect(isClineManagedProvider("cline")).toBe(true)
		expect(isClineManagedProvider("cline-pass")).toBe(true)
		expect(isClineManagedProvider("anthropic")).toBe(false)
		expect(isClineManagedProvider(undefined)).toBe(false)
	})
})

describe("resolveWorkspaceRootPath", () => {
	it("uses the first non-empty workspace path when available", () => {
		expect(resolveWorkspaceRootPath(["", "/workspace"], "/Users/tester/Desktop")).toBe("/workspace")
	})

	it("falls back to Desktop when no workspace folder is open", () => {
		expect(resolveWorkspaceRootPath([], "/Users/tester/Desktop")).toBe("/Users/tester/Desktop")
	})
})

vi.mock("@/services/telemetry", () => ({
	telemetryService: {
		captureRemoteConfigSessionGate: vi.fn(),
	},
}))

const { buildBaseStateMock } = vi.hoisted(() => ({
	buildBaseStateMock: vi.fn(async () => ({ taskHistory: [] })),
}))
vi.mock("@core/controller/state/getStateToPostToWebview", () => ({
	getStateToPostToWebview: buildBaseStateMock,
}))

describe("SDK remote-config coordination", () => {
	it("posts the current remote-config revision to the webview", async () => {
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: true,
			currentRemoteConfigRevision: 7,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: { listHistory: async () => [] },
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => ({ epoch: 1, nextSeq: () => 1 }) },
		}

		await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledWith(
			expect.objectContaining({ isRemoteConfigAvailable: true, currentRemoteConfigRevision: 7 }),
		)
	})

	it("rebuilds the snapshot when the epoch moves while the state is being built", async () => {
		buildBaseStateMock.mockClear()
		const minter = { epoch: 1, nextSeq: () => 1 }
		const controller = {
			stateManager: {
				getGlobalSettingsKey: () => undefined,
				getRemoteConfigSettings: () => ({}),
				setGlobalState: vi.fn(),
			},
			backgroundCommandRunning: false,
			backgroundCommandTaskId: undefined,
			foregroundCommands: { isRunning: false },
			isRemoteConfigAvailable: false,
			currentRemoteConfigRevision: undefined,
			ensureWorkspaceManager: async () => undefined,
			taskHistory: {
				listHistory: async () => {
					// A conversation boundary (follow-up on an idle session) bumps the
					// epoch while this snapshot's transcript copy is already taken.
					minter.epoch = 2
					return []
				},
			},
			sessions: { getActiveSession: () => undefined },
			turnStateTracker: { get: () => undefined },
			messageTranslatorState: { getMinter: () => minter },
			getStateToPostToWebview: SdkController.prototype.getStateToPostToWebview,
		}

		const state = await SdkController.prototype.getStateToPostToWebview.call(controller as never)

		expect(buildBaseStateMock).toHaveBeenCalledTimes(2)
		expect(state.epoch).toBe(2)
	})

	it("keys refreshes by the current user and organization", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({ user: { uid: "user-1" } }),
				getActiveOrganizationId: () => "org-1",
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("user-1:org-1", {})
	})

	it("uses a stable signed-out identity so startup refresh can settle", async () => {
		const refresh = vi.fn().mockResolvedValue(true)
		const controller = {
			authService: {
				getInfo: () => ({}),
				getActiveOrganizationId: () => null,
			},
			remoteConfigRefreshCoordinator: { refresh },
		}

		await SdkController.prototype.refreshRemoteConfig.call(controller as never)

		expect(refresh).toHaveBeenCalledWith("signed-out:no-org", {})
	})

	it("does not attach hosted policy refresh to auth callbacks", async () => {
		const events: string[] = []
		const controller = {
			authService: { handleAuthCallback: vi.fn(async () => events.push("auth")) },
			refreshRemoteConfig: vi.fn(async () => {
				events.push("refresh")
				return true
			}),
			postStateToWebview: vi.fn(async () => events.push("post")),
		}

		await SdkController.prototype.handleAuthCallback.call(controller as never, "token", "cline")

		expect(events).toEqual(["auth", "post"])
	})

	it("rejects a managed toggle without refreshing or ending local work", async () => {
		const controller = {
			refreshRemoteConfig: vi.fn().mockResolvedValue(true),
			sessions: { endActiveSession: vi.fn() },
			postStateToWebview: vi.fn(),
		}
		await expect(SdkController.prototype.rematerializeRemoteConfig.call(controller as never)).rejects.toMatchObject({
			code: "cline_cloud_disabled",
		})
		expect(controller.refreshRemoteConfig).not.toHaveBeenCalled()
		expect(controller.sessions.endActiveSession).not.toHaveBeenCalled()
		expect(controller.postStateToWebview).not.toHaveBeenCalled()
	})

	it.each([null, "org-current", "org-new"])("ignores legacy organization %s when starting local work", async (org) => {
		vi.mocked(telemetryService.captureRemoteConfigSessionGate).mockClear()
		const controller = {
			waitForInitialRemoteConfig: vi.fn().mockResolvedValue(undefined),
			refreshRemoteConfig: vi.fn().mockRejectedValue(new Error("hosted service unavailable")),
			authService: { getActiveOrganizationId: vi.fn(() => org) },
			stateManager: { getGlobalStateKey: vi.fn(() => "org-previous") },
			remoteConfigBundle: { metadata: { organizationId: "org-current" } },
		}
		await expect(
			SdkController.prototype["ensureRemoteConfigForSessionStart"].call(controller as never),
		).resolves.toBeUndefined()
		expect(controller.waitForInitialRemoteConfig).toHaveBeenCalledOnce()
		expect(controller.refreshRemoteConfig).not.toHaveBeenCalled()
		expect(controller.authService.getActiveOrganizationId).not.toHaveBeenCalled()
		expect(controller.stateManager.getGlobalStateKey).not.toHaveBeenCalled()
		expect(telemetryService.captureRemoteConfigSessionGate).not.toHaveBeenCalled()
	})

	it("cannot publish a hosted integration or restore availability", async () => {
		const controller = Object.create(SdkController.prototype)
		controller.remoteConfigRevision = 0
		const integration = { prepared: { bundle: { remoteConfig: {} } }, dispose: vi.fn().mockResolvedValue(undefined) }
		await expect(controller.setRemoteConfigCoreIntegration(integration)).rejects.toMatchObject({
			code: "cline_cloud_disabled",
		})
		controller.setRemoteConfigAvailable(true)
		expect(controller.isRemoteConfigAvailable).toBe(false)
		expect(controller.remoteConfig).toBeUndefined()
		expect(controller.remoteConfigBundle).toBeUndefined()
		expect(controller.currentRemoteConfigRevision).toBe(0)
		expect(integration.dispose).toHaveBeenCalledOnce()
	})

	it("awaits disposal of an old integration when clearing runtime policy", async () => {
		const controller = Object.create(SdkController.prototype)
		controller.remoteConfigRevision = 3
		let release!: () => void
		const disposed = new Promise<void>((resolve) => {
			release = resolve
		})
		controller.remoteConfigCoreIntegration = { dispose: vi.fn(() => disposed) }
		let settled = false
		const clearing = controller.setRemoteConfigCoreIntegration(undefined).then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(controller.remoteConfigCoreIntegration).toBeUndefined()
		expect(settled).toBe(false)
		release()
		await clearing
		expect(controller.currentRemoteConfigRevision).toBe(4)
	})

	it("does not enter task startup until initial remote config is ready", async () => {
		let finishPolicyCheck!: () => void
		const policyReady = new Promise<void>((resolve) => {
			finishPolicyCheck = resolve
		})
		const events: string[] = []
		const initTask = vi.fn(async () => {
			events.push("task")
			return "task-id"
		})
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => {
				await policyReady
				events.push("policy")
			}),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { initTask },
		}

		const taskPromise = SdkController.prototype.initTask.call(controller as never, "start immediately")
		await Promise.resolve()
		expect(initTask).not.toHaveBeenCalled()
		expect(controller.turnStateTracker.set).not.toHaveBeenCalled()

		finishPolicyCheck()
		const taskId = await taskPromise

		expect(taskId).toBe("task-id")
		expect(events).toEqual(["policy", "task"])
		expect(initTask).toHaveBeenCalledWith("start immediately", undefined, undefined, undefined, undefined)
	})

	describe("after a Cline sign-in error offers to retry a prompt", () => {
		function controllerShowingSignInError(options: { existingTask?: boolean } = {}) {
			const controller = {
				task: undefined as TaskProxy | undefined,
				turnStateTracker: { set: vi.fn(), get: () => ({ phase: "error" }) },
				messageTranslatorState: { clearTurnOutcome: vi.fn() },
				messages: { appendAndEmit: vi.fn() },
				sessions: { getActiveSession: () => undefined },
				postStateToWebview: vi.fn(async () => {}),
				initTask: vi.fn(async () => "task-id"),
				followups: { askResponse: vi.fn(async () => {}) },
				cancelTask: vi.fn(async () => {}),
				askResponse(prompt?: string, images?: string[], files?: string[]) {
					return SdkController.prototype.askResponse.call(controller as never, prompt, images, files)
				},
			}
			const openTask = (taskId: string) => {
				controller.task = createTaskProxy(taskId, controller.askResponse, controller.cancelTask)
				return controller.task
			}
			if (options.existingTask) {
				openTask("existing-task")
			}
			SdkController.prototype["emitClineAuthError"].call(controller as never, "original prompt")
			const errorTask = controller.task
			if (!errorTask) {
				throw new Error("The sign-in error did not leave a task to answer")
			}
			return { controller, errorTask, openTask }
		}

		it("restarts a new task with the original prompt when Retry is clicked", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("yesButtonClicked")
			expect(controller.initTask).toHaveBeenCalledWith("original prompt", undefined, undefined)
			expect(controller.followups.askResponse).not.toHaveBeenCalled()
		})

		it("restarts a new task with a revised prompt submitted from the composer", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("messageResponse", "revised prompt", ["img"])
			expect(controller.initTask).toHaveBeenCalledWith("revised prompt", ["img"], undefined)
			expect(controller.followups.askResponse).not.toHaveBeenCalled()
		})

		it("keeps the original prompt when the revised submission has attachments but no text", async () => {
			const { controller, errorTask } = controllerShowingSignInError()
			await errorTask.handleWebviewAskResponse("messageResponse", "  ", ["img"])
			expect(controller.initTask).toHaveBeenCalledWith("original prompt", ["img"], undefined)
		})

		it("continues an existing conversation with a message submitted from the composer", async () => {
			const { controller, errorTask } = controllerShowingSignInError({ existingTask: true })
			await errorTask.handleWebviewAskResponse("messageResponse", "follow-up")
			expect(controller.initTask).not.toHaveBeenCalled()
			expect(controller.task).toBe(errorTask)
			expect(controller.followups.askResponse).toHaveBeenCalledWith(
				"follow-up",
				undefined,
				undefined,
				"messageResponse",
				"error",
			)

			// The follow-up answered the error, so a later approval continues the conversation.
			await errorTask.handleWebviewAskResponse("yesButtonClicked")
			expect(controller.initTask).not.toHaveBeenCalled()
		})

		it("does not restart the failed prompt from a task opened afterwards", async () => {
			const { controller, openTask } = controllerShowingSignInError()
			const historyTask = openTask("history-task")
			await historyTask.handleWebviewAskResponse("yesButtonClicked", "resume here")
			expect(controller.initTask).not.toHaveBeenCalled()
			expect(controller.followups.askResponse).toHaveBeenCalledWith(
				"resume here",
				undefined,
				undefined,
				"yesButtonClicked",
				"error",
			)
		})
	})

	it("waits for initial remote config before resuming an existing task", async () => {
		const events: string[] = []
		const controller = {
			waitForInitialRemoteConfig: vi.fn(async () => events.push("policy")),
			turnStateTracker: { set: vi.fn() },
			messageTranslatorState: { clearTurnOutcome: vi.fn() },
			taskStart: { reinitExistingTaskFromId: vi.fn(async () => events.push("resume")) },
		}

		await SdkController.prototype.reinitExistingTaskFromId.call(controller as never, "task-id")

		expect(events).toEqual(["policy", "resume"])
	})
})

describe("hasWorkspaceCheckpointForMessage", () => {
	const messages = [
		{ ts: 1, type: "say", say: "task", text: "start" },
		{ ts: 2, type: "say", say: "text", text: "done" },
		{ ts: 3, type: "say", say: "user_feedback", text: "continue" },
	]
	const sdkMessages = [
		{ role: "user", content: "start" },
		{ role: "assistant", content: "done" },
		{ role: "user", content: "continue" },
	]

	it("reads the live conversation of the active session", async () => {
		const readLiveMessages = vi.fn().mockResolvedValue(sdkMessages)
		const readMessages = vi.fn().mockResolvedValue([])
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: {
				getActiveSession: () => ({
					sessionId: "task-a",
					sdkHost: {
						get: async () => ({
							metadata: { checkpoint: { history: [{ ref: "checkpoint-b", createdAt: 1, runCount: 2 }] } },
						}),
						readLiveMessages,
						readMessages,
					},
				}),
			},
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(true)
		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(false)
		expect(readLiveMessages).toHaveBeenCalledWith("task-a")
		expect(readMessages).not.toHaveBeenCalled()
	})

	it("agrees with editMessageAndRegenerate on which messages exist while the transcript lags", async () => {
		// The persisted transcript is written after Core reports the turn done,
		// so it can still lack the newest user message while its checkpoint exists.
		const readLiveMessages = vi.fn().mockResolvedValue(sdkMessages)
		const readMessages = vi.fn().mockResolvedValue(sdkMessages.slice(0, 2))
		const restore = vi.fn().mockRejectedValue(new Error("stop at restore"))
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: {
				getActiveSession: () => ({
					sessionId: "task-a",
					isRunning: false,
					sdkHost: {
						get: async () => ({
							cwd: "C:/work",
							metadata: { checkpoint: { history: [{ ref: "checkpoint-b", createdAt: 1, runCount: 2 }] } },
						}),
						readLiveMessages,
						readMessages,
						restore,
					},
				}),
			},
			taskHistory: { findHistoryItem: async () => undefined },
			getWorkspaceRoot: async () => "C:/work",
			stateManager: { getGlobalSettingsKey: () => "act" },
			sessionConfigBuilder: { build: async () => ({ providerId: "anthropic", apiKey: "key", modelId: "model" }) },
			resolveContextMentions: async (text: string) => text,
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(true)
		await expect(
			SdkController.prototype.editMessageAndRegenerate.call(controller as never, {
				messageTs: 3,
				text: "continue, edited",
				restoreWorkspace: true,
			}),
		).rejects.toThrow("stop at restore")
		expect(restore).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "task-a", checkpointRunCount: 2 }))
		expect(readMessages).not.toHaveBeenCalled()
	})

	it("uses and disposes a temporary host for a history task", async () => {
		const tempHost = {
			get: vi.fn().mockResolvedValue({
				metadata: { checkpoint: { history: [{ ref: "checkpoint-a", createdAt: 1, runCount: 1 }] } },
			}),
			readMessages: vi.fn().mockResolvedValue(sdkMessages),
			dispose: vi.fn().mockRejectedValue(new Error("cleanup failed")),
		}
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: { getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost: vi.fn().mockResolvedValue(tempHost),
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(true)
		expect(tempHost.get).toHaveBeenCalledWith("task-a")
		expect(tempHost.dispose).toHaveBeenCalledWith("workspaceCheckpointForMessage")
	})

	it("reports no checkpoint when the host cannot be read", async () => {
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => messages } },
			sessions: { getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost: vi.fn().mockRejectedValue(new Error("host unavailable")),
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 1)).resolves.toBe(false)
	})

	it("reports no checkpoint for messages that did not start a run", async () => {
		const answerMessages = [
			{ ts: 1, type: "say", say: "task", text: "start" },
			{ ts: 2, type: "ask", ask: "followup", text: "which file?" },
			{ ts: 3, type: "say", say: "user_feedback", text: "src/index.ts" },
		]
		const createRemoteConfigAwareSessionHost = vi.fn()
		const controller = {
			task: { taskId: "task-a", messageStateHandler: { getClineMessages: () => answerMessages } },
			sessions: { getActiveSession: () => undefined },
			createRemoteConfigAwareSessionHost,
		}

		await expect(SdkController.prototype.hasWorkspaceCheckpointForMessage.call(controller as never, 3)).resolves.toBe(false)
		expect(createRemoteConfigAwareSessionHost).not.toHaveBeenCalled()
	})
})

describe("resolveWorkspaceManagerPaths", () => {
	it("returns the host's workspace folder paths, dropping blank entries", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace", "  ", "/other"], "/Users/tester/Desktop")).toEqual([
			"/workspace",
			"/other",
		])
	})

	it("falls back to a single root when no workspace folder is open", () => {
		// Legacy-parity: an empty VS Code window must still yield a usable root
		// so @-mention file search doesn't fail with workspace_unavailable.
		expect(resolveWorkspaceManagerPaths([], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(undefined, "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
		expect(resolveWorkspaceManagerPaths(["", "   "], "/Users/tester/Desktop")).toEqual(["/Users/tester/Desktop"])
	})

	it("prefers real workspace folders over the fallback", () => {
		expect(resolveWorkspaceManagerPaths(["/workspace"], "/Users/tester/Desktop")).toEqual(["/workspace"])
	})

	it("returns no roots when the fallback is also unavailable", () => {
		expect(resolveWorkspaceManagerPaths([], undefined)).toEqual([])
		expect(resolveWorkspaceManagerPaths([], "  ")).toEqual([])
	})
})
