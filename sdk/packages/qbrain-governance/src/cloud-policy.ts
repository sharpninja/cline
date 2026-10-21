// SPDX-License-Identifier: Apache-2.0
export const CLINE_ACCOUNT_DISABLED_MESSAGE =
	"Cline account services are unavailable in cline-qb. Configure a direct model provider.";

export class ClineCloudDisabledError extends Error {
	readonly code = "cline_cloud_disabled";
	constructor() {
		super(CLINE_ACCOUNT_DISABLED_MESSAGE);
		this.name = "ClineCloudDisabledError";
	}
}
export function rejectClineAccount(): never {
	throw new ClineCloudDisabledError();
}

export function isClineCloudProvider(providerId: string): boolean {
	const normalized = providerId.trim().toLowerCase();
	return (
		normalized === "cline" ||
		normalized === "cline-pass" ||
		normalized === "cline-cloud"
	);
}

export function assertDirectProvider(providerId: string): void {
	if (isClineCloudProvider(providerId)) rejectClineAccount();
}

export function requireDirectProvider(providerId: string | undefined): string {
	const selected = providerId?.trim();
	if (!selected)
		throw new Error(
			"No model provider configured. Configure a direct model provider with cline-qb auth.",
		);
	assertDirectProvider(selected);
	return selected;
}
