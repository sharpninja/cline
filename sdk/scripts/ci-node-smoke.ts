#!/usr/bin/env bun

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";

async function runCommand(
	cmd: string[],
	options: {
		cwd: string;
		env?: Record<string, string | undefined>;
		captureStdout?: boolean;
		timeoutMs?: number;
	},
): Promise<string> {
	const captureStdout = options.captureStdout === true;
	let timedOut = false;
	const proc = Bun.spawn(cmd, {
		cwd: options.cwd,
		env: {
			...process.env,
			...options.env,
		},
		stdout: captureStdout ? "pipe" : "inherit",
		stderr: "inherit",
	});
	const stdoutPromise =
		captureStdout && proc.stdout
			? new Response(proc.stdout).text()
			: Promise.resolve("");
	const timeout = setTimeout(
		() => {
			timedOut = true;
			proc.kill();
		},
		options.timeoutMs ?? 5 * 60_000,
	);
	timeout.unref();
	const exitCode = await proc.exited.finally(() => clearTimeout(timeout));
	const stdout = await stdoutPromise;
	if (exitCode !== 0) {
		if (timedOut) {
			throw new Error(
				`${cmd.join(" ")} timed out after ${options.timeoutMs ?? 5 * 60_000}ms`,
			);
		}
		throw new Error(`${cmd.join(" ")} exited with code ${exitCode}`);
	}
	return stdout.trim();
}

async function packWorkspace(
	workspace: "core" | "agents" | "llms" | "shared",
	packDir: string,
): Promise<string> {
	const destination = await mkdtemp(join(packDir, `${workspace}-`));
	await runCommand(["bun", "pm", "pack", "--destination", destination], {
		cwd: join(root, `packages/${workspace}`),
		timeoutMs: 2 * 60_000,
	});
	const files = (await readdir(destination)).filter((file) =>
		file.endsWith(".tgz"),
	);
	if (files.length !== 1) {
		throw new Error(
			`Expected one tarball for ${workspace}, found ${files.length}`,
		);
	}
	return join(destination, files[0]);
}

async function main(): Promise<void> {
	const packDir = await mkdtemp(join(tmpdir(), "cline-node-smoke-packs-"));
	const smokeDir = await mkdtemp(join(tmpdir(), "cline-node-smoke-"));
	const sessionsDir = await mkdtemp(join(tmpdir(), "cline-node-sessions-"));
	const bunCacheDir = await mkdtemp(join(tmpdir(), "cline-node-bun-cache-"));
	const bunEnv = { BUN_INSTALL_CACHE_DIR: bunCacheDir };

	try {
		console.log("Packing smoke-test tarballs with Bun...");
		const tarballs = {
			core: await packWorkspace("core", packDir),
			agents: await packWorkspace("agents", packDir),
			llms: await packWorkspace("llms", packDir),
			shared: await packWorkspace("shared", packDir),
		};

		// Carry the repo root's dependency overrides into the sandbox so a broken
		// third-party release that the root already pins around (e.g. the
		// @sap-cloud-sdk 4.9.0 exports breakage) can't fail the smoke install.
		const rootPackageJson = JSON.parse(
			await readFile(join(root, "..", "package.json"), "utf8"),
		) as { overrides?: Record<string, unknown> };

		await writeFile(
			join(smokeDir, "package.json"),
			`${JSON.stringify(
				{
					name: "cline-node-smoke",
					private: true,
					type: "module",
					dependencies: {
						"@cline/core": `file:${tarballs.core}`,
						"@cline/agents": `file:${tarballs.agents}`,
						"@cline/llms": `file:${tarballs.llms}`,
						"@cline/shared": `file:${tarballs.shared}`,
					},
					// Bun distinguishes a file dependency from the same published
					// version. Force transitive SDK edges to these exact tarballs too.
					overrides: {
						...rootPackageJson.overrides,
						"@cline/core": `file:${tarballs.core}`,
						"@cline/agents": `file:${tarballs.agents}`,
						"@cline/llms": `file:${tarballs.llms}`,
						"@cline/shared": `file:${tarballs.shared}`,
					},
				},
				null,
				2,
			)}\n`,
		);

		console.log("Installing smoke-test dependencies...");
		await runCommand([bunCommand, "install", "--ignore-scripts"], {
			cwd: smokeDir,
			env: bunEnv,
			timeoutMs: 10 * 60_000,
		});

		const nodeMajor = Number(process.versions.node.split(".")[0] || "0");
		const smokeSource =
			nodeMajor >= 24
				? `
					const { SqliteSessionStore } = await import("@cline/core");
					const store = new SqliteSessionStore({ sessionsDir: process.env.CLINE_DATA_DIR });
					try {
						store.init();
						console.log("SQLite smoke test passed");
					} finally {
						store.close();
					}
				`
				: `
					const { resolveSessionBackend } = await import("@cline/core");
					await resolveSessionBackend({ backendMode: "local" });
					console.log("Node compatibility smoke test passed");
				`;
		const smokeFile = join(smokeDir, "smoke.mjs");
		await writeFile(smokeFile, `${smokeSource.trim()}\n`);

		console.log("Running smoke test...");
		await runCommand(["node", smokeFile], {
			cwd: smokeDir,
			env: {
				...bunEnv,
				CLINE_DATA_DIR: sessionsDir,
			},
			timeoutMs: 2 * 60_000,
		});
	} finally {
		await rm(packDir, { recursive: true, force: true });
		await rm(smokeDir, { recursive: true, force: true });
		await rm(sessionsDir, { recursive: true, force: true });
		await rm(bunCacheDir, { recursive: true, force: true });
	}
}

await main();
