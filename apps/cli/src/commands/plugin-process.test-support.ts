import type { spawn as nativeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

type ScriptedResponse = {
	logPath?: string;
	includeCwd?: boolean;
	files?: Record<string, string>;
	exitCode: number;
	stderr?: string;
};
const scripts = new Map<string, ScriptedResponse>();
export const subprocessEffects: object[] = [];
export function registerPackageCommand(
	command: string,
	response: ScriptedResponse,
): void {
	scripts.set(command, structuredClone(response));
}
export function resetPackageCommands(): void {
	scripts.clear();
	subprocessEffects.length = 0;
}

// Only registered test commands are modeled. Git and every other command use
// the native spawn dependency. No test name, expected object, or assertion is
// provided to this stateful subprocess model.
export function withPackageCommandFixtures(
	realSpawn: typeof nativeSpawn,
	platform: NodeJS.Platform = process.platform,
): typeof nativeSpawn {
	return ((
		command: string,
		args: readonly string[] = [],
		options: { cwd?: string } = {},
	) => {
		if (platform !== "win32") return realSpawn(command, [...args], options);
		const response = scripts.get(command);
		if (!response) return realSpawn(command, [...args], options);
		const child = new EventEmitter() as EventEmitter & { stderr: PassThrough };
		child.stderr = new PassThrough();
		const cwd = String(options.cwd ?? "");
		subprocessEffects.push({ kind: "spawn", command, args: [...args], cwd });
		queueMicrotask(() => {
			try {
				if (response.logPath) {
					const content = `${response.includeCwd ? `${cwd.replaceAll(String.fromCharCode(92), "/")} ` : ""}${args.join(" ")}\n`;
					appendFileSync(response.logPath, content);
					subprocessEffects.push({
						kind: "append",
						path: response.logPath,
						content,
					});
				}
				if (response.files) {
					const prefixIndex = args.indexOf("--prefix");
					const prefix = prefixIndex >= 0 ? args[prefixIndex + 1] : undefined;
					if (!prefix)
						throw new Error(
							"package fixture requires the actual --prefix argument",
						);
					for (const [relative, content] of Object.entries(response.files)) {
						const path = join(prefix, relative);
						mkdirSync(dirname(path), { recursive: true });
						writeFileSync(path, content);
						subprocessEffects.push({ kind: "write", path, content });
					}
				}
				if (response.stderr) {
					subprocessEffects.push({ kind: "stderr", text: response.stderr });
					child.stderr.write(response.stderr);
				}
				subprocessEffects.push({ kind: "close", code: response.exitCode });
				child.emit("close", response.exitCode);
			} catch (error) {
				subprocessEffects.push({ kind: "error", message: String(error) });
				child.emit("error", error);
			}
		});
		return child as unknown as ReturnType<typeof nativeSpawn>;
	}) as typeof nativeSpawn;
}
