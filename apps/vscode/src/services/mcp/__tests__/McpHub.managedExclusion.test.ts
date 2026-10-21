// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { StateManager } from "@core/storage/StateManager"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import sinon from "sinon"
import { McpHub } from "../McpHub"

const blocked = /remote.config.*unavailable/i
const configs = [
	{ type: "stdio", command: "synthetic-mcp" },
	{ type: "sse", url: "https://mcp.example.test/sse" },
	{ type: "streamableHttp", url: "https://mcp.example.test/mcp" },
] as const

describe("McpHub managed server exclusion", () => {
	let sandbox: sinon.SinonSandbox
	let network: sinon.SinonStub
	let spawn: sinon.SinonStub
	beforeEach(() => {
		sandbox = sinon.createSandbox()
		sandbox.stub(StateManager, "get").returns({ getRemoteConfigSettings: () => ({}) } as any)
		network = sandbox.stub(Client.prototype, "connect").rejects(new Error("Unexpected client connection"))
		spawn = sandbox.stub(StdioClientTransport.prototype, "start").rejects(new Error("Unexpected stdio start"))
	})
	afterEach(() => sandbox.restore())
	function hub() {
		const h = Object.create(McpHub.prototype) as any
		h.connections = []
		h.isConnecting = false
		h.clientVersion = "0.0.0"
		h.mcpOAuthManager = { startOAuthFlow: sandbox.stub().resolves(), getOrCreateProvider: sandbox.stub().resolves(undefined) }
		sandbox.stub(h, "notifyWebviewOfServerChanges").resolves()
		sandbox.stub(h, "removeAllFileWatchers")
		sandbox.stub(h, "setupFileWatcher")
		sandbox.stub(h, "checkToolListChanged")
		return h
	}
	for (const config of configs)
		for (const source of ["internal", "rpc"]) {
			it(`blocks ${config.type} ${source} before transport and retains an actionable entry`, async () => {
				const h = hub()
				const saved = { ...config, remoteConfigured: true, disabled: false }
				await expect(h.connectToServer("managed", saved, source)).rejects.toThrow(blocked)
				expect(network.called).toBe(false)
				expect(spawn.called).toBe(false)
				expect(h.connections[0].server).toMatchObject({
					name: "managed",
					status: "disconnected",
				})
				expect(h.connections[0].server.error).toMatch(blocked)
				expect(JSON.parse(h.connections[0].server.config)).toEqual(saved)
				await expect(h.callTool("managed", "echo", {}, "test")).rejects.toThrow(blocked)
			})
		}
	for (const config of configs) {
		it(`keeps explicit user-controlled ${config.type} on its normal connection path`, async () => {
			const h = hub()
			await expect(h.connectToServer("personal", { ...config, remoteConfigured: false }, "internal")).rejects.toThrow(
				/Unexpected (client connection|stdio start)/,
			)
			expect(config.type === "stdio" ? spawn.calledOnce : network.calledOnce).toBe(true)
		})
	}
	for (const method of ["updateServerConnections", "updateServerConnectionsRPC"]) {
		it(`disconnects on provenance-only change through ${method}`, async () => {
			const h = hub()
			const config = configs[2]
			h.connections = [
				{
					server: { name: "server", config: JSON.stringify(config), status: "connected", tools: [{ name: "echo" }] },
					client: {},
					transport: {},
				},
			]
			const remove = sandbox.stub(h, "deleteConnection").callsFake(async () => {
				h.connections = []
			})
			await h[method]({ server: { ...config, remoteConfigured: true } })
			expect(remove.calledOnce).toBe(true)
			expect(h.connections[0].server.status).toBe("disconnected")
			expect(h.connections[0].server.error).toMatch(blocked)
			expect(h.connections[0].server.tools ?? []).toHaveLength(0)
			expect(network.called).toBe(false)
		})
	}
	it("removes a newly managed connection before a UI notification can race a tool call", async () => {
		const h = hub()
		const request = sandbox.stub().resolves({ content: [] })
		h.telemetryService = { captureMcpToolCall: sandbox.stub() }
		h.connections = [
			{
				server: { name: "server", config: JSON.stringify(configs[2]), status: "connected" },
				client: { request },
				transport: {},
			},
		]
		sandbox.stub(h, "deleteConnection").callsFake(async () => {
			h.connections = []
		})
		h.notifyWebviewOfServerChanges.callsFake(async () => {
			if (h.connections.some((entry: any) => entry.client?.request === request)) {
				await h.callTool("server", "echo", {}, "notification-race")
			}
		})
		await h.updateServerConnections({ server: { ...configs[2], remoteConfigured: true } })
		expect(request.called).toBe(false)
		expect(h.connections[0].server.error).toMatch(blocked)
	})
	it("recognizes removal of managed provenance while ignoring tool approval changes", () => {
		const h = hub()
		const config = { ...configs[2], remoteConfigured: true }
		expect(h.configsRequireRestart(config, { ...config, remoteConfigured: false })).toBe(true)
		expect(h.configsRequireRestart(configs[2], { ...configs[2], autoApprove: ["echo"] })).toBe(false)
	})
	it("blocks explicit OAuth before flow, notification or reconnect", async () => {
		const h = hub()
		h.connections = [{ server: { name: "managed", config: JSON.stringify({ ...configs[2], remoteConfigured: true }) } }]
		sandbox.stub(h, "restartConnection").resolves()
		await expect(h.initiateOAuth("managed")).rejects.toThrow(blocked)
		expect(h.mcpOAuthManager.startOAuthFlow.called).toBe(false)
		expect(h.notifyWebviewOfServerChanges.called).toBe(false)
		expect(h.restartConnection.called).toBe(false)
	})
})
