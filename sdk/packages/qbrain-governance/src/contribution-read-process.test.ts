// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const probe = `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, relative, isAbsolute } from 'node:path';
import { registerStorageNamespace } from '@cline/shared/storage';
import { createQbrainStorageNamespace } from './dist/storage-policy.js';
import { UnifiedConfigFileWatcher, createSkillsConfigDefinition, createRulesConfigDefinition } from '../core/dist/index.js';
const home = process.argv[1];
const upstream = join(home, '.cline');
const root = join(home, 'project');
fs.mkdirSync(upstream);
fs.mkdirSync(root);
fs.writeFileSync(join(upstream, 'SKILL.md'), 'private upstream fixture');
fs.writeFileSync(join(upstream, 'managed.json'), '{}');
fs.symlinkSync(upstream, join(root, 'skill-link'), 'junction');
const managed = join(root, '.cline');
fs.mkdirSync(join(managed, 'plugin'), {recursive: true});
fs.symlinkSync(join(upstream, 'managed.json'), join(managed, 'plugin', 'managed.json'));
const read = fs.promises.readFile;
let forbiddenReads = 0;
fs.promises.readFile = async function(path, ...args) {
  const child = relative(upstream, fs.realpathSync(path));
  if (child === '' || (child !== '..' && !child.startsWith('../') && !child.startsWith('..\\\\') && !isAbsolute(child))) {
    forbiddenReads++;
    throw new Error('TEST GUARD: forbidden content read');
  }
  return read.call(this, path, ...args);
};
syncBuiltinESMExports();
try { await fs.promises.readFile(join(upstream, 'SKILL.md'), 'utf8'); }
catch (error) { if (!error.message.includes('TEST GUARD:')) throw error; }
if (forbiddenReads !== 1) throw new Error('Read guard self-check failed');
forbiddenReads = 0;
registerStorageNamespace(createQbrainStorageNamespace({homeDir: home, env: {}}));
const custom = {type:'custom', directories:[root], discoverFiles:async()=>[{directoryPath:root,fileName:'SKILL.md',filePath:join(root,'skill-link','SKILL.md')}], parseFile:()=>{throw new Error('Private data reached parser');}, resolveId:()=> 'bad'};
const results = [];
for (const definition of [createSkillsConfigDefinition({directories:[root]}), createRulesConfigDefinition({directories:[managed]}), custom]) {
  const watcher = new UnifiedConfigFileWatcher([definition]);
  try { await watcher.refreshAll(); results.push('unexpected success'); }
  catch(error) { results.push(error.message); }
  finally {watcher.stop();}
}
console.log(JSON.stringify({results,forbiddenReads}));
`;
it("TEST-QB-053: built discovery rejects nested upstream symlinks before content reads", () => {
	const home = mkdtempSync(join(tmpdir(), "qb-nested-read-"));
	try {
		const child = spawnSync(
			process.execPath,
			["--input-type=module", "-e", probe, home],
			{ encoding: "utf8", timeout: 30000 },
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		const result = JSON.parse(child.stdout.trim());
		expect(result.forbiddenReads).toBe(0);
		expect(result.results).toHaveLength(3);
		for (const message of result.results)
			expect(message).toMatch(/upstream Cline/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
