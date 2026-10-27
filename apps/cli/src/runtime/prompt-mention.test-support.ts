// SPDX-License-Identifier: Apache-2.0
// Independent test-only scanner. Receives input and dependencies, never expectations.
export type MentionResult = { prompt: string; userImages: string[]; userFiles: string[] };
export type MentionDependencies = {
  stat(path: string): { isFile(): boolean };
  resolve(path: string): string;
  basename(path: string): string;
  image(path: string): boolean;
  load(path: string): string;
};
export function modelMentions(input: string, deps: MentionDependencies, fault = ""): MentionResult {
  const found: { start: number; end: number; path: string }[] = [];
  for (let offset = 0; offset < input.length; offset++) {
    if (input[offset] !== "@") continue;
    const start = offset;
    let cursor = offset + 1;
    const quoted = input[cursor] === '"';
    if (quoted) cursor++;
    const pathStart = cursor;
    while (cursor < input.length && (quoted ? input[cursor] !== '"' && input[cursor] !== "\r" && input[cursor] !== "\n" : !/\s/.test(input[cursor]!))) cursor++;
    if (quoted && input[cursor] !== '"') continue;
    const path = input.slice(pathStart, cursor);
    const drive = path.length > 2 && /[a-z]/i.test(path[0]!) && path[1] === ":" && (path[2] === "/" || path[2] === "\\");
    const prefixed = path.startsWith("/") || path.startsWith("./") || path.startsWith("../") || path.startsWith("~/") || path.startsWith("\\\\");
    if ((!drive || fault === "ignore-drive") && !prefixed) continue;
    found.push({ start, end: cursor + (quoted ? 1 : 0), path });
    offset = cursor;
  }
  const result: MentionResult = { prompt: input, userImages: [], userFiles: [] };
  const images: string[] = [], files: string[] = [];
  for (const mention of [...found].reverse()) {
    try {
      const path = deps.resolve(mention.path);
      if (fault !== "omit-stat" && !deps.stat(path).isFile()) continue;
      const name = fault === "wrong-name" ? "other.dat" : deps.basename(path);
      if (deps.image(path)) {
        if (fault === "omit-image") continue;
        const data = deps.load(path);
        if (fault === "duplicate-load") deps.load(path);
        images.push(data);
        result.prompt = result.prompt.slice(0, mention.start) + `[image: ${name}]` + result.prompt.slice(mention.end);
      } else {
        files.push(fault === "wrong-file" ? deps.resolve("other.md") : path);
        result.prompt = result.prompt.slice(0, mention.start) + `[file: ${name}]` + result.prompt.slice(mention.end);
      }
    } catch { /* An inaccessible mention remains literal, matching the existing contract. */ }
  }
  result.userImages = images.reverse();
  result.userFiles = fault === "reverse-files" ? files : files.reverse();
  if (fault === "changed-text") result.prompt += " changed";
  return result;
}
