import { afterEach, beforeEach, describe, it, mock } from "bun:test"
import * as actualDiskStorage from "@core/storage/disk"
import * as actualRemoteConfigUtils from "@core/storage/remote-config/utils"
import * as assert from "assert"
import sinon from "sinon"
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { AuthService } from "@/services/auth/AuthService"

// bun loads real ESM, so sinon cannot stub the `@core/storage/disk` and
// `@core/storage/remote-config/utils` namespace exports ("ES Modules cannot be
// stubbed"). Inject module-level sinon stubs via mock.module so the full sinon
// stub API keeps working. `AuthService`/`ClineAccountService` statics and the
// `accountService` instance method are still sinon-stubbed directly below.
const isRemoteConfigEnabledStub: sinon.SinonStub = sinon.stub()
const applyRemoteConfigStub: sinon.SinonStub = sinon.stub()
const clearRemoteConfigStub: sinon.SinonStub = sinon.stub()
const writeRemoteConfigToCacheStub: sinon.SinonStub = sinon.stub()
const readRemoteConfigFromCacheStub: sinon.SinonStub = sinon.stub()
const deleteRemoteConfigFromCacheStub: sinon.SinonStub = sinon.stub()
const diskMock = () => ({
	...actualDiskStorage,
	writeRemoteConfigToCache: writeRemoteConfigToCacheStub,
	readRemoteConfigFromCache: readRemoteConfigFromCacheStub,
	deleteRemoteConfigFromCache: deleteRemoteConfigFromCacheStub,
})
const utilsMock = () => ({
	...actualRemoteConfigUtils,
	isRemoteConfigEnabled: isRemoteConfigEnabledStub,
	applyRemoteConfig: applyRemoteConfigStub,
	clearRemoteConfig: clearRemoteConfigStub,
})
// Register both the alias form (this test's imports) and the relative form the
// SUT (remote-config/fetch.ts) uses, since bun's mock.module matches specifiers.
mock.module("@core/storage/disk", diskMock)
mock.module("@/core/storage/disk", diskMock)
mock.module("../disk", diskMock)
mock.module("@core/storage/remote-config/utils", utilsMock)
mock.module("@/core/storage/remote-config/utils", utilsMock)
mock.module("./utils", utilsMock)

import * as remoteConfigFetch from "@core/storage/remote-config/fetch"

describe("fetchRemoteConfig", () => {
	let sandbox: sinon.SinonSandbox
	let accountService: ClineAccountService
	let authServiceStub: Partial<AuthService>
	let fetchUserRemoteConfigStub: sinon.SinonStub

	beforeEach(() => {
		sandbox = sinon.createSandbox()
		authServiceStub = {}
		sandbox.stub(AuthService, "getInstance").returns(authServiceStub as AuthService)
		accountService = new ClineAccountService()
		sandbox.stub(ClineAccountService, "getInstance").returns(accountService)
		fetchUserRemoteConfigStub = sandbox.stub(accountService, "fetchUserRemoteConfig")

		// Reset and (re)configure the module-level sinon stubs injected above.
		isRemoteConfigEnabledStub.reset()
		applyRemoteConfigStub.reset()
		clearRemoteConfigStub.reset()
		writeRemoteConfigToCacheStub.reset()
		readRemoteConfigFromCacheStub.reset()
		deleteRemoteConfigFromCacheStub.reset()
		isRemoteConfigEnabledStub.returns(true)
		applyRemoteConfigStub.resolves()
		writeRemoteConfigToCacheStub.resolves()
		readRemoteConfigFromCacheStub.resolves({ version: "v1" })
		deleteRemoteConfigFromCacheStub.resolves()
	})

	afterEach(() => {
		sandbox.restore()
	})

	for (const provider of ["anthropic", "cline", "cline-pass"]) {
		it(`clears runtime policy without discovery, cache or credentials for ${provider}`, async () => {
			Object.assign(authServiceStub, {
				getActiveOrganizationId: () => "org-current",
				getAuthToken: () => Promise.resolve("synthetic"),
			})
			fetchUserRemoteConfigStub.resolves({ organizationId: "org-target", value: '{"version":"v1"}' })
			const controller = {
				accountService: { switchAccount: sandbox.stub().resolves() },
				stateManager: {
					getApiConfiguration: sandbox.stub().returns({ actModeApiProvider: provider }),
					setSecret: sandbox.stub(),
				},
				mcpHub: {},
				setRemoteConfigAvailable: sandbox.stub(),
				setRemoteConfigCoreIntegration: sandbox.stub().resolves(),
				postStateToWebview: sandbox.stub().resolves(),
			}
			await remoteConfigFetch.fetchRemoteConfig(controller as any)
			assert.ok(fetchUserRemoteConfigStub.notCalled)
			assert.ok(controller.accountService.switchAccount.notCalled)
			assert.ok(controller.stateManager.setSecret.notCalled)
			assert.ok(readRemoteConfigFromCacheStub.notCalled)
			assert.ok(writeRemoteConfigToCacheStub.notCalled)
			assert.ok(deleteRemoteConfigFromCacheStub.notCalled)
			assert.ok(applyRemoteConfigStub.notCalled)
			assert.ok(clearRemoteConfigStub.calledOnce)
			assert.ok(controller.setRemoteConfigAvailable.calledOnceWithExactly(false))
			assert.ok(controller.setRemoteConfigCoreIntegration.calledOnceWithExactly(undefined))
			assert.ok(controller.postStateToWebview.calledOnce)
		})
	}

	it("propagates runtime cleanup failures without hosted fallback or false state publication", async () => {
		clearRemoteConfigStub.rejects(new Error("cleanup failed"))
		fetchUserRemoteConfigStub.resolves(undefined)
		const controller = {
			stateManager: { getApiConfiguration: () => ({ actModeApiProvider: "anthropic" }) },
			setRemoteConfigAvailable: sandbox.stub(),
			setRemoteConfigCoreIntegration: sandbox.stub().resolves(),
			postStateToWebview: sandbox.stub().resolves(),
		}
		await assert.rejects(remoteConfigFetch.fetchRemoteConfig(controller as any), /cleanup failed/)
		assert.ok(fetchUserRemoteConfigStub.notCalled)
		assert.ok(controller.postStateToWebview.notCalled)
	})
})
