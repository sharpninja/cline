// SPDX-License-Identifier: Apache-2.0
import { basename, resolve } from "node:path";
import { strict as assert, AssertionError } from "node:assert";
import { describe, expect, it, vi } from "vitest";
import { modelMentions, type MentionResult } from "./prompt-mention.test-support";
const state = vi.hoisted(() => ({
  queue: [] as { kind: string; path: string; value?: string | boolean; error?: string }[],
  effects: [] as { kind: string; path: string }[],
}));
function take(kind: string, path: string) {
  state.effects.push({ kind, path });
  const response = state.queue.shift();
  if (!response || response.kind !== kind || response.path !== path) throw new Error("wrong/missing dependency response");
  if (response.error) throw new Error(response.error);
  return response.value;
}
vi.mock("node:fs", () => ({ statSync: (path: string) => ({ isFile: () => take("stat", path) === true }) }));
vi.mock("../utils/image-attachments", () => ({
  isImagePath: (path: string) => path.endsWith(".png"),
  loadImageAsDataUrl: (path: string) => take("load", path),
}));
vi.mock("@cline/core", () => ({
  buildWorkspaceMetadata: () => { throw new Error("metadata outside mention contract"); },
  isSkillsToolAvailable: () => { throw new Error("skills outside mention contract"); },
  mergeRulesForSystemPrompt: () => { throw new Error("rules outside mention contract"); },
  readGlobalSettings: () => { throw new Error("settings outside mention contract"); },
}));
vi.mock("@cline/shared", () => ({ buildClineSystemPrompt: () => { throw new Error("system prompt outside mention contract"); } }));
type Step = (typeof state.queue)[number];
type Scenario = { name: string; input: string; responses: Step[]; expected: MentionResult; effects: {kind: string;path: string}[]; faults: string[] };
const image = resolve("F:/synthetic-c-mention/hero.png");
const note = resolve("F:/synthetic-c-mention/notes.md");
const spaced = resolve("F:/synthetic-c-mention/notes with spaces.md");
const other = resolve("F:/synthetic-c-mention/second.md");
const data = "data:image/png;base64,aGVsbG8=";
const step = (kind: string, path: string, value?: boolean | string): Step => ({ kind, path, value });
const effect = (kind: string, path: string) => ({kind,path});
const scenarios: Scenario[] = [
  { name: "drive forward slash image", input: `@${image.replaceAll(String.fromCharCode(92),"/")} describe this image`, responses: [step("stat",image,true),step("load",image,data)], expected: {prompt:"[image: hero.png] describe this image",userImages:[data],userFiles:[]}, effects:[effect("stat",image),effect("load",image)],faults:["ignore-drive","omit-stat","wrong-name","omit-image","duplicate-load","changed-text"] },
  { name: "drive relative stays literal", input:"inspect @F:notes.md",responses:[],expected:{prompt:"inspect @F:notes.md",userImages:[],userFiles:[]},effects:[],faults:["changed-text"] },
  { name: "original image mention", input: `@${image} describe this image`, responses: [step("stat",image,true),step("load",image,data)], expected: {prompt:"[image: hero.png] describe this image",userImages:[data],userFiles:[]}, effects:[effect("stat",image),effect("load",image)],faults:["ignore-drive","omit-stat","wrong-name","omit-image","duplicate-load","changed-text"] },
  { name: "original text mention", input: `summarize @${note}`,responses:[step("stat",note,true)],expected:{prompt:"summarize [file: notes.md]",userImages:[],userFiles:[note]},effects:[effect("stat",note)],faults:["ignore-drive","omit-stat","wrong-name","wrong-file","changed-text"] },
  { name: "original quoted mention", input: `summarize @"${spaced}"`,responses:[step("stat",spaced,true)],expected:{prompt:"summarize [file: notes with spaces.md]",userImages:[],userFiles:[spaced]},effects:[effect("stat",spaced)],faults:["ignore-drive","omit-stat","wrong-name","wrong-file","changed-text"] },
  { name:"two files preserve source order",input:`@${note} then @${other}`,responses:[step("stat",other,true),step("stat",note,true)],expected:{prompt:"[file: notes.md] then [file: second.md]",userImages:[],userFiles:[note,other]},effects:[effect("stat",other),effect("stat",note)],faults:["ignore-drive","omit-stat","wrong-name","wrong-file","reverse-files","changed-text"] },
  { name:"relative path retained",input:"inspect @./notes.md",responses:[step("stat",resolve("./notes.md"),true)],expected:{prompt:"inspect [file: notes.md]",userImages:[],userFiles:[resolve("./notes.md")]},effects:[effect("stat",resolve("./notes.md"))],faults:["omit-stat","wrong-name","wrong-file","changed-text"] },
  { name:"POSIX rooted image retained",input:"@/synthetic-c-mention/hero.png describe",responses:[step("stat",resolve("/synthetic-c-mention/hero.png"),true),step("load",resolve("/synthetic-c-mention/hero.png"),data)],expected:{prompt:"[image: hero.png] describe",userImages:[data],userFiles:[]},effects:[effect("stat",resolve("/synthetic-c-mention/hero.png")),effect("load",resolve("/synthetic-c-mention/hero.png"))],faults:["omit-stat","wrong-name","omit-image","duplicate-load","changed-text"] },
  { name:"missing file stays literal",input:`inspect @${note}`,responses:[{kind:"stat",path:note,error:"ENOENT"}],expected:{prompt:`inspect @${note}`,userImages:[],userFiles:[]},effects:[effect("stat",note)],faults:["ignore-drive","omit-stat","changed-text"] },
  { name:"directory stays literal",input:`inspect @${note}`,responses:[step("stat",note,false)],expected:{prompt:`inspect @${note}`,userImages:[],userFiles:[]},effects:[effect("stat",note)],faults:["ignore-drive","omit-stat","changed-text"] },
];
async function run(scenario: Scenario, mode: string, fault = "", responses = scenario.responses) {
  state.queue = structuredClone(responses); state.effects = [];
  const result = mode === "Production"
    ? await (await import("./prompt")).buildUserInputMessage(scenario.input)
    : modelMentions(scenario.input, {stat:(path)=>({isFile:()=>take("stat",path)===true}),resolve,basename,image:(path)=>path.endsWith(".png"),load:(path)=>String(take("load",path))},fault);
  return { result, effects: structuredClone(state.effects), remaining: structuredClone(state.queue) };
}
function assertObserved(scenario: Scenario, observed: Awaited<ReturnType<typeof run>>) {
  assert.equal(observed.result.prompt,scenario.expected.prompt);
  assert.deepEqual(observed.result.userImages,scenario.expected.userImages);
  assert.deepEqual(observed.result.userFiles,scenario.expected.userFiles);
  assert.deepEqual(observed.effects,scenario.effects);
  assert.deepEqual(observed.remaining,[]);
}
async function rejects(scenario: Scenario, fault: string, responses?: Step[]) {
  let rejection: unknown;
  try { assertObserved(scenario,await run(scenario,"Mock",fault,responses)); } catch(error) { rejection=error; }
  expect(rejection).toBeInstanceOf(AssertionError);
}
const mode=process.env.CLINE_MENTION_PROVIDER ?? "Mock";
describe(`original file-mention contract (${mode})`,()=>{
  for(const scenario of scenarios) {
    it(scenario.name,async()=>{const observed=await run(scenario,mode); console.log("C_MENTION "+JSON.stringify({name:scenario.name,mode,observed}));assertObserved(scenario,observed);});
    for(const fault of scenario.faults) it(`${scenario.name} rejects ${fault}`,()=>rejects(scenario,fault));
  }
  for(const [name,responses] of [
    ["missing",[]],
    ["wrong stat",[step("stat",image,false),step("load",image,data)]],
    ["wrong image bytes",[step("stat",image,true),step("load",image,"data:image/png;base64,d3Jvbmc=")]],
    ["reordered",[step("load",image,data),step("stat",image,true)]],
    ["wrong callback path",[step("stat",note,true),step("load",image,data)]],
  ] as [string,Step[]][]) it(`original image rejects ${name} responses`,()=>rejects(scenarios[0]!,"",responses));
});
