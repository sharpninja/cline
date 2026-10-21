// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ignore, { type Ignore } from "ignore";

const exec = promisify(execFile);
const digest = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const slash = (path: string): string => path.split(sep).join("/");
const order = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface SourceFingerprintFile {
  readonly path: string;
  readonly workingHash: string | null;
  readonly staged: readonly { readonly mode: string; readonly objectId: string; readonly stage: number }[];
}
export interface WorkspaceFingerprint {
  readonly workspacePath: string;
  readonly policyDigest: string;
  readonly revision: string;
  readonly hash: string;
  readonly files: readonly SourceFingerprintFile[];
}
export interface FingerprintOptions {
  workspacePath: string;
  policyDigest: string;
}

/** Never expose raw file contents, git diagnostics or credentials in this error. */
export class WorkspaceFingerprintError extends Error {
  readonly code = "source_fingerprint_unavailable";
  constructor() { super("Unable to capture a stable, scoped source fingerprint. Resolve source access or workspace boundaries before verification."); }
}

type Layer = { directory: string; kind: "git" | "cline"; matcher: Ignore; hash: string };
type GitState = { revision: string; entries: Map<string, SourceFingerprintFile["staged"]>; excludePath?: string };
const forbiddenDirectories = new Set([".git", "node_modules", ".mcpserver", ".worktrees", ".creds", ".ssh", ".aws", ".azure", ".next"]);
function hardExcluded(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts[parts.length - 1];
  return parts.some(part => forbiddenDirectories.has(part)) ||
    path.toLowerCase().startsWith("docs/receipts/") || path.toLowerCase() === "docs/receipts" ||
    name === "agents-readme-first.yaml" || name === ".env" || name.startsWith(".env.") ||
    [".npmrc", ".netrc", ".pypirc", ".git-credentials", ".envrc"].includes(name) || /^\.(credentials?|secrets?)(\.|$)/.test(name) ||
    /\.(pem|key|pfx|p12|keystore)$/.test(name) || /^(credentials?|secrets?)(\.|$)/.test(name);
}
function inRoot(root: string, path: string): boolean {
  const name = relative(root, path);
  return name === "" || (!isAbsolute(name) && name !== ".." && !name.startsWith(`..${sep}`));
}

/** Read the named regular file itself, refusing links and changes during reading. */
async function readStable(path: string, source = false): Promise<Buffer> {
  const before = await fs.lstat(path, { bigint: true });
  if (!before.isFile()) throw new WorkspaceFingerprintError();
  const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new WorkspaceFingerprintError();
    const bytes = await handle.readFile();
    const after = await fs.lstat(path, { bigint: true });
    if (!after.isFile() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) throw new WorkspaceFingerprintError();
    return source ? Buffer.concat([Buffer.from(`file\0${before.mode & 0o111n}\0`), bytes]) : bytes;
  } finally { await handle.close(); }
}
async function optionalFile(path: string): Promise<Buffer | undefined> {
  try { return await readStable(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function git(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await exec("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}
async function gitState(root: string): Promise<GitState> {
  try { await fs.lstat(join(root, ".git")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: "non-git", entries: new Map() }; throw error; }
  let revision: string;
  try { revision = (await git(root, ["rev-parse", "--verify", "HEAD"])).trim(); }
  catch {
    // A valid unborn repository has a symbolic HEAD and no committed tree.
    const branch = (await git(root, ["symbolic-ref", "-q", "HEAD"])).trim();
    if (!branch.startsWith("refs/heads/")) throw new WorkspaceFingerprintError();
    revision = `unborn:${branch}`;
  }
  const entries = new Map<string, SourceFingerprintFile["staged"]>();
  const index = await git(root, ["ls-files", "--stage", "-z"]);
  for (const entry of index.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) ([a-f0-9]{40,64}) ([0-3])\t([\s\S]+)$/.exec(entry);
    if (!match || !match[4] || isAbsolute(match[4]) || match[4].split("/").includes("..")) throw new WorkspaceFingerprintError();
    const [, mode, objectId, stage, path] = match;
    entries.set(path, [...(entries.get(path) ?? []), { mode, objectId, stage: Number(stage) }]);
  }
  const excludePath = resolve(root, (await git(root, ["rev-parse", "--git-path", "info/exclude"])).trim());
  return { revision, entries, excludePath };
}

async function scan(root: string, policyDigest: string): Promise<WorkspaceFingerprint> {
  const before = await gitState(root);
  const layers: Layer[] = [];
  const files = new Map<string, string>();
  const directories = new Set<string>([""]);
  const links: { path: string; full: string; target: string }[] = [];
  async function addRules(directory: string, kind: Layer["kind"], path: string): Promise<void> {
    const bytes = await optionalFile(path);
    if (bytes) layers.push({ directory, kind, matcher: ignore({ ignorecase: process.platform === "win32" }).add(bytes.toString("utf8")), hash: digest(bytes) });
  }
  function excluded(path: string, isDirectory = false): boolean {
    if (hardExcluded(path)) return true;
    // Check parents too: a child cannot re-include an excluded parent directory.
    const parts = path.split("/");
    for (let end = 1; end <= parts.length; end++) {
      const prefix = parts.slice(0, end).join("/");
      const candidate = prefix + (end < parts.length || isDirectory ? "/" : "");
      for (const kind of ["git", "cline"] as const) {
        let ignored = false;
        for (const layer of layers) {
          if (layer.kind !== kind || (layer.directory && !candidate.startsWith(`${layer.directory}/`))) continue;
          const local = layer.directory ? candidate.slice(layer.directory.length + 1) : candidate;
          if (!local) continue;
          const result = layer.matcher.test(local);
          if (result.ignored) ignored = true;
          else if (result.unignored) ignored = false;
        }
        if (ignored) return true;
      }
    }
    return false;
  }
  if (before.excludePath) await addRules("", "git", before.excludePath);
  async function walk(directory: string): Promise<void> {
    const full = join(root, directory);
    await addRules(directory, "git", join(full, ".gitignore"));
    await addRules(directory, "cline", join(full, ".clineignore"));
    for (const entry of (await fs.readdir(full, { withFileTypes: true })).sort((a, b) => order(a.name, b.name))) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (excluded(path, entry.isDirectory())) continue;
      const target = join(root, path);
      if (entry.isDirectory()) { directories.add(path); await walk(path); }
      else if (entry.isFile()) files.set(path, digest(await readStable(target, true)));
      else if (entry.isSymbolicLink()) {
        const value = await fs.readlink(target);
        const resolved = resolve(dirname(target), value);
        if (!inRoot(root, resolved)) throw new WorkspaceFingerprintError();
        links.push({ path, full: target, target: resolved });
        files.set(path, digest(`symlink\0${value}`));
      } else throw new WorkspaceFingerprintError();
    }
  }
  await walk("");
  for (const link of links) {
    const target = await fs.realpath(link.full);
    const name = slash(relative(root, target));
    if (!inRoot(root, target) || excluded(slash(relative(root, link.target))) || excluded(name) || (!files.has(name) && !directories.has(name))) throw new WorkspaceFingerprintError();
  }
  const after = await gitState(root);
  const describeGit = (state: GitState) => [state.revision, [...state.entries.entries()]];
  if (!same(describeGit(before), describeGit(after))) throw new WorkspaceFingerprintError();
  const paths = new Set([...files.keys(), ...before.entries.keys()].filter(path => !excluded(path)));
  const entries = [...paths].sort(order).map(path => Object.freeze({
    path, workingHash: files.get(path) ?? null,
    staged: Object.freeze((before.entries.get(path) ?? []).map(entry => Object.freeze({ ...entry }))),
  }));
  const rules = layers.map(layer => [layer.directory, layer.kind, layer.hash]);
  const hash = digest(JSON.stringify([1, root, policyDigest, before.revision, rules, entries]));
  return Object.freeze({ workspacePath: root, policyDigest, revision: before.revision, hash, files: Object.freeze(entries) });
}

/** Two matching whole-workspace scans are required; never trust model file lists. */
export async function captureWorkspaceFingerprint(options: FingerprintOptions): Promise<WorkspaceFingerprint> {
  const { workspacePath, policyDigest } = options;
  try {
    if (!isAbsolute(workspacePath) || !/^[a-f0-9]{64}$/i.test(policyDigest)) throw new WorkspaceFingerprintError();
    const root = await fs.realpath(workspacePath);
    let previous = await scan(root, policyDigest);
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await scan(root, policyDigest);
      if (current.hash === previous.hash) return current;
      previous = current;
    }
    throw new WorkspaceFingerprintError();
  } catch { throw new WorkspaceFingerprintError(); }
}

/** Host-owned comparison used by operation classification and package selection. */
export function changedSourcePaths(before: WorkspaceFingerprint, after: WorkspaceFingerprint): string[] {
  if (before.workspacePath !== after.workspacePath) throw new WorkspaceFingerprintError();
  const old = new Map(before.files.map(file => [file.path, file]));
  const next = new Map(after.files.map(file => [file.path, file]));
  return [...new Set([...old.keys(), ...next.keys()])].filter(path => !same(old.get(path), next.get(path))).sort(order);
}