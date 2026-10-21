// SPDX-License-Identifier: Apache-2.0
import { getProviderAuthHandler } from "@cline/core";
import {
	assertDirectProvider,
	requireDirectProvider,
} from "@cline/qbrain-governance/cloud-policy";
import type { JsonRecord } from "./types";

export function assertDesktopDirectProvider(providerId: string): void {
	const normalized = providerId.trim();
	assertDirectProvider(normalized);
	assertDirectProvider(
		getProviderAuthHandler(normalized)?.storageProviderId ?? normalized,
	);
}

/** Check every identity before normalization can hide a conflicting alias. */
export function assertDesktopSessionProvider(
	config: JsonRecord,
	requireSelection = false,
): void {
	const nested =
		config.providerConfig && typeof config.providerConfig === "object"
			? (config.providerConfig as JsonRecord)
			: undefined;
	for (const id of [
		config.provider,
		config.providerId,
		nested?.providerId,
		nested?.routingProviderId,
	]) {
		if (id === undefined || id === null) continue;
		if (typeof id !== "string")
			throw new Error("Model provider must be a provider identifier.");
		assertDesktopDirectProvider(id);
	}
	if (requireSelection)
		requireDirectProvider(
			(config.provider ?? config.providerId) as string | undefined,
		);
}
