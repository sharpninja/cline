// SPDX-License-Identifier: Apache-2.0
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { captureWorkspaceFingerprint } from "../workspace-fingerprint.js";
export type Fault =
	| "none"
	| "erase-mode"
	| "omit-stat"
	| "omit-read"
	| "inode-drift"
	| "split-newline"
	| "omit-index"
	| "wrong-object"
	| "wrong-reply";
type Node = { bytes: Buffer; mode: bigint; ino: bigint };
type GitReply = { args: string[]; stdout: string };
const objectId = "1".repeat(40);
const policyDigest = "a".repeat(64);
const absent = () =>
	Object.assign(new Error("fixture path absent"), { code: "ENOENT" });

// A stateful filesystem and independently scripted Git transport, not a fingerprint model.
// Neither receives expected hashes, expected results, test names or assertion callbacks.
export class PlatformFixture {
	readonly root: string;
	readonly files = new Map<string, Node>();
	readonly calls: {
		method: string;
		path?: string;
		args?: string[];
		mode?: string;
		bytesHex?: string;
	}[] = [];
	readonly replies: GitReply[] = [];
	gitEnabled = false;
	constructor(
		readonly fault: Fault,
		root = resolve(tmpdir(), "qb-faithful-platform-fixture"),
	) {
		this.root = root;
	}
	owns(path: unknown): boolean {
		return (
			typeof path === "string" &&
			(path === this.root ||
				path.startsWith(`${this.root}\\`) ||
				path.startsWith(`${this.root}/`))
		);
	}
	add(path: string, text: string): void {
		this.files.set(join(this.root, path), {
			bytes: Buffer.from(text),
			mode: 0o100644n,
			ino: BigInt(this.files.size + 1),
		});
	}
	stat(node?: Node) {
		const mode = node
			? this.fault === "erase-mode"
				? 0o100644n
				: node.mode
			: 0o40755n;
		return {
			mode,
			ino: node?.ino ?? 100n,
			dev: 1n,
			size: BigInt(node?.bytes.length ?? 0),
			mtimeNs: 1n,
			ctimeNs: 1n,
			isFile: () => !!node,
			isDirectory: () => !node,
			isSymbolicLink: () => false,
		};
	}
	async invoke(method: string, args: unknown[]): Promise<unknown> {
		const path = String(args[0]);
		const node = this.files.get(path);
		this.calls.push({ method, path });
		if (method === "mkdir" && path === this.root) return;
		if (method === "writeFile") {
			this.add(path.slice(this.root.length + 1), String(args[1]));
			this.calls.push({
				method: "write-effect",
				path,
				bytesHex: this.files.get(path)?.bytes.toString("hex"),
			});
			return;
		}
		if (method === "realpath" && path === this.root) return this.root;
		if (method === "readdir" && path === this.root)
			return [...this.files.keys()].map((full) => ({
				name: full.slice(this.root.length + 1),
				isFile: () => true,
				isDirectory: () => false,
				isSymbolicLink: () => false,
			}));
		if (method === "lstat") {
			if (this.fault === "omit-stat" && node) throw absent();
			if (
				node ||
				path === this.root ||
				(this.gitEnabled && path === join(this.root, ".git"))
			) {
				const stat = this.stat(node);
				this.calls.push({
					method: "stat-result",
					path,
					mode: stat.mode.toString(8),
				});
				return stat;
			}
			throw absent();
		}
		if (method === "chmod" && node) {
			node.mode = 0o100000n | BigInt(Number(args[1]));
			this.calls.push({
				method: "chmod-effect",
				path,
				mode: node.mode.toString(8),
			});
			return;
		}
		if (method === "open" && node)
			return {
				stat: async () => {
					this.calls.push({ method: "handle.stat", path });
					const stat = this.stat(node);
					return this.fault === "inode-drift"
						? { ...stat, ino: stat.ino + 1n }
						: stat;
				},
				readFile: async () => {
					this.calls.push({
						method: "handle.readFile",
						path,
						bytesHex: node.bytes.toString("hex"),
					});
					if (this.fault === "omit-read") throw absent();
					return Buffer.from(node.bytes);
				},
				close: async () => {
					this.calls.push({ method: "handle.close", path });
				},
			};
		throw absent();
	}
	scriptCapture(): void {
		if (!this.gitEnabled) return;
		let records = [...this.files.keys()].map(
			(path) =>
				`100644 ${this.fault === "wrong-object" ? "2".repeat(40) : objectId} 0\t${path.slice(this.root.length + 1)}\0`,
		);
		if (this.fault === "omit-index") records = records.slice(1);
		let index = records.join("");
		if (this.fault === "split-newline") index = index.split("\n").join("\0");
		for (let stateRead = 0; stateRead < 4; stateRead++)
			this.replies.push(
				{
					args: ["rev-parse", "--verify", "HEAD"],
					stdout: `${"a".repeat(40)}\n`,
				},
				{
					args: ["ls-files", "--stage", "-z"],
					stdout:
						this.fault === "wrong-reply" ? "invalid-index-response" : index,
				},
				{
					args: ["rev-parse", "--git-path", "info/exclude"],
					stdout: ".git/info/exclude\n",
				},
			);
	}
	gitSync(file: string, args: string[]): string {
		this.calls.push({ method: "execFileSync", args: [file, ...args] });
		if (file !== "git") throw new Error("unexpected fixture executable");
		if (args.join(" ") === "init -q") {
			this.gitEnabled = true;
			return "";
		}
		if (this.gitEnabled && args.join(" ") === "add .") return "";
		throw new Error("unexpected fixture Git setup request/order");
	}
	async git(
		file: string,
		args: string[],
	): Promise<{ stdout: string; stderr: string }> {
		this.calls.push({ method: "execFile", args: [file, ...args] });
		const reply = this.replies.shift();
		if (
			file !== "git" ||
			!reply ||
			JSON.stringify(args) !==
				JSON.stringify(["-c", "core.fsmonitor=false", ...reply.args])
		)
			throw new Error("unexpected Git dependency request/order");
		return { stdout: reply.stdout, stderr: "" };
	}
	async capture() {
		this.scriptCapture();
		const result = await captureWorkspaceFingerprint({
			workspacePath: this.root,
			policyDigest,
		}).catch((error: unknown) => {
			console.log(
				"PLATFORM_BINDING_CAPTURE_FAILURE",
				JSON.stringify({
					fault: this.fault,
					calls: this.calls,
					remainingGitReplies: this.replies.length,
				}),
			);
			throw error;
		});
		// Only project actual production observations into the frozen runner's structural type.
		return {
			hash: result.hash,
			files: result.files.map((file) => ({
				path: file.path,
				staged: file.staged.map((entry) => ({ ...entry })),
			})),
		};
	}
}
