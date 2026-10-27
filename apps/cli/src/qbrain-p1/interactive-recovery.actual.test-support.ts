// SPDX-License-Identifier: Apache-2.0
// Test-only SDK surface for isolated CLI factory binding, never SDK acceptance.
// Only source tag and scripted error classification are used by the nine cases.
export const SessionSource = { CLI: "cli" } as const;
export function isSessionNotFoundError(error: unknown): boolean {
 return error !== null && typeof error === "object" &&
  "missingSession" in error && error.missingSession === true;
}
function unused(name: string): never {
 throw new Error("Outside isolated interactive recovery binding: " + name);
}
export function createSessionCompactionState(..._args: unknown[]): never {
 return unused("createSessionCompactionState");
}
export function projectSessionCompactionState(..._args: unknown[]): never {
 return unused("projectSessionCompactionState");
}
export function readSessionCheckpointHistory(..._args: unknown[]): never {
 return unused("readSessionCheckpointHistory");
}
