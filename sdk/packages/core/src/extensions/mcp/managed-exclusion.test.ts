// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	parseMcpServerRegistration,
	resolveMcpServerRegistrations,
	setMcpServerDisabled,
} from "./config-loader";
import {
	createDefaultMcpServerClientFactory,
	probeMcpServerConnection,
} from "./client";
import { authorizeMcpServerOAuth } from "./oauth";
import { InMemoryMcpManager } from "./manager";

const transports = [
	{ type: "stdio", command: "synthetic-mcp" },
	{ type: "sse", url: "https://mcp.example.test/sse" },
	{ type: "streamableHttp", url: "https://mcp.example.test/mcp" },
] as const;
const blocked = /remote.config.*unavailable/i;
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function settings() {
	const root = await mkdtemp(join(tmpdir(), "qb-managed-mcp-"));
	roots.push(root);
	const filePath = join(root, "settings.json");
	await writeFile(
		filePath,
		JSON.stringify({
			mcpServers: {
				managed: {
					transport: transports[2],
					remoteConfigured: true,
					oauth: {
						tokens: { access_token: "synthetic-token", token_type: "Bearer" },
					},
				},
				personal: { transport: transports[2] },
			},
		}),
	);
	return filePath;
}
function client() {
	return {
		connect: vi.fn(async () => {}),
		disconnect: vi.fn(async () => {}),
		listTools: vi.fn(async () => [{ name: "echo", inputSchema: {} }]),
		callTool: vi.fn(async () => ({ ok: true })),
	};
}

describe("managed MCP exclusion (AC-QB-016/017/018)", () => {
	for (const transport of transports) {
		for (const nested of [true, false]) {
			it(`preserves ${transport.type} provenance in ${nested ? "nested" : "legacy"} settings`, () => {
				const raw = {
					...(nested ? { transport } : transport),
					remoteConfigured: true,
				};
				expect(parseMcpServerRegistration("managed", raw)).toMatchObject({
					remoteConfigured: true,
				});
				expect(
					parseMcpServerRegistration("personal", {
						...raw,
						remoteConfigured: false,
					}),
				).toMatchObject({ remoteConfigured: false });
			});
		}
		it(`rejects managed ${transport.type} before client creation, including enable and replay`, async () => {
			const factory = vi.fn(async () => client());
			const manager = new InMemoryMcpManager({ clientFactory: factory });
			const registration = parseMcpServerRegistration("managed", {
				transport,
				remoteConfigured: true,
			});
			await manager.registerServer(registration);
			await manager.setServerDisabled("managed", false);
			for (let attempt = 0; attempt < 2; attempt++) {
				await expect(manager.connectServer("managed")).rejects.toThrow(blocked);
				await expect(manager.listTools("managed")).rejects.toThrow(blocked);
				await expect(
					manager.callTool({ serverName: "managed", toolName: "echo" }),
				).rejects.toThrow(blocked);
			}
			expect(factory).not.toHaveBeenCalled();
			expect(manager.listServers()[0]).toMatchObject({
				status: "disconnected",
				lastError: expect.stringMatching(blocked),
				toolCount: 0,
			});
			expect(() => createDefaultMcpServerClientFactory()(registration)).toThrow(
				blocked,
			);
		});
	}
	it("disconnects a connected personal server if its provenance changes and invalidates cached tools", async () => {
		const c = client();
		const factory = vi.fn(async () => c);
		const manager = new InMemoryMcpManager({ clientFactory: factory });
		const raw = { transport: transports[2] };
		await manager.registerServer(parseMcpServerRegistration("server", raw));
		expect(await manager.listTools("server")).toHaveLength(1);
		await manager.registerServer(
			parseMcpServerRegistration("server", { ...raw, remoteConfigured: true }),
		);
		expect(c.disconnect).toHaveBeenCalledTimes(1);
		await expect(manager.listTools("server")).rejects.toThrow(blocked);
		await expect(
			manager.callTool({ serverName: "server", toolName: "echo" }),
		).rejects.toThrow(blocked);
		expect(c.callTool).not.toHaveBeenCalled();
		expect(factory).toHaveBeenCalledTimes(1);
		await manager.registerServer(
			parseMcpServerRegistration("server", { ...raw, remoteConfigured: false }),
		);
		await expect(
			manager.callTool({ serverName: "server", toolName: "echo" }),
		).resolves.toEqual({ ok: true });
	});
	it("refuses cached tools while disconnect is pending or fails after a provenance change", async () => {
		const c = client();
		let failDisconnect!: (error: Error) => void;
		c.disconnect = vi.fn(
			() =>
				new Promise<void>((_resolve, reject) => {
					failDisconnect = reject;
				}),
		);
		const manager = new InMemoryMcpManager({ clientFactory: async () => c });
		const raw = { transport: transports[2] };
		await manager.registerServer(parseMcpServerRegistration("server", raw));
		await manager.listTools("server");
		const update = manager.registerServer(
			parseMcpServerRegistration("server", { ...raw, remoteConfigured: true }),
		);
		const observed = expect(update).rejects.toThrow("disconnect failed");
		await vi.waitFor(() => expect(c.disconnect).toHaveBeenCalledTimes(1));
		try {
			await expect(manager.listTools("server")).rejects.toThrow(blocked);
		} finally {
			failDisconnect(new Error("disconnect failed"));
			await observed;
		}
		await expect(manager.listTools("server")).rejects.toThrow(blocked);
		await expect(
			manager.callTool({ serverName: "server", toolName: "echo" }),
		).rejects.toThrow(blocked);
		expect(c.callTool).not.toHaveBeenCalled();
		expect(manager.listServers()[0].toolCount).toBe(0);
	});
	it("retains provenance after persisted enable without disabling personal siblings", async () => {
		const filePath = await settings();
		setMcpServerDisabled({ filePath, name: "managed", disabled: false });
		const registrations = resolveMcpServerRegistrations({ filePath });
		expect(registrations.find((r) => r.name === "managed")).toMatchObject({
			remoteConfigured: true,
		});
		const c = client();
		const factory = vi.fn(async () => c);
		const manager = new InMemoryMcpManager({ clientFactory: factory });
		for (const registration of registrations)
			await manager.registerServer(registration);
		await expect(manager.connectServer("managed")).rejects.toThrow(blocked);
		await expect(
			manager.callTool({ serverName: "personal", toolName: "echo" }),
		).resolves.toEqual({ ok: true });
		expect(factory).toHaveBeenCalledTimes(1);
	});
	it("refuses passive probes and interactive OAuth before any network, browser or settings mutation", async () => {
		const filePath = await settings();
		const before = await readFile(filePath, "utf8");
		const fetch = vi.fn(async () => {
			throw new Error("Unexpected network");
		});
		const openExternal = vi.fn(async () => {});
		await expect(
			probeMcpServerConnection({ filePath, serverName: "managed", fetch }),
		).rejects.toThrow(blocked);
		await expect(
			authorizeMcpServerOAuth({
				filePath,
				serverName: "managed",
				fetch,
				openUrl: openExternal,
				callbackPorts: [0],
				timeoutMs: 100,
			}),
		).rejects.toThrow(blocked);
		expect(fetch).not.toHaveBeenCalled();
		expect(openExternal).not.toHaveBeenCalled();
		expect(await readFile(filePath, "utf8")).toBe(before);
	});
});
