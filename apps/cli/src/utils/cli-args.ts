// SPDX-License-Identifier: Apache-2.0
function isBooleanLikeAutoApproveValue(value: string | undefined): boolean {
	if (!value) {
		return false;
	}
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "false";
}

export function normalizeCliArgs(args: string[]): string[] {
	const normalized: string[] = [];
	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token === "--autoapprove" || token === "--auto-approve") {
			const nextToken = args[index + 1];
			if (isBooleanLikeAutoApproveValue(nextToken)) {
				normalized.push("--auto-approve", nextToken);
				index += 1;
				continue;
			}
			normalized.push("--auto-approve", "true");
			continue;
		}
		if (token.startsWith("--autoapprove=")) {
			normalized.push(token.replace(/^--autoapprove=/, "--auto-approve="));
			continue;
		}
		if (token === "--thinking") {
			const nextToken = args[index + 1];
			if (nextToken !== undefined && !nextToken.startsWith("-")) {
				normalized.push("--thinking", nextToken);
				index += 1;
				continue;
			}
			normalized.push("--thinking", "medium");
			continue;
		}
		if (token === "--reasoning-effort") {
			const nextToken = args[index + 1];
			// Legacy spelling is normalized to --thinking and intentionally relies
			// on commanderToParsedArgs for level validation, so invalid values behave
			// the same as `--thinking <value>` and `--thinking=<value>`.
			if (nextToken !== undefined && !nextToken.startsWith("-")) {
				normalized.push("--thinking", nextToken);
				index += 1;
				continue;
			}
			normalized.push("--thinking", "medium");
			continue;
		}
		if (token.startsWith("--reasoning-effort=")) {
			normalized.push(token.replace(/^--reasoning-effort=/, "--thinking="));
			continue;
		}
		normalized.push(token);
	}
	return normalized;
}

export const normalizeAutoApproveArgs = normalizeCliArgs;