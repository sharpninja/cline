import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type {
	ClineAccountOrganization,
	ProviderSettingsManager,
} from "@cline/core";
import {
	CLINE_ACCOUNT_DISABLED_MESSAGE,
	rejectClineAccount,
} from "../utils/cloud-policy";

export const PERSONAL_ACCOUNT_VALUE = "personal";
export const ORGANIZATION_CONFIG_ID = "organization";
export function usesClineAccount(providerId: string): boolean {
	return providerId === "cline" || providerId === "cline-pass";
}
export interface AcpOrganizationState {
	organizations: ClineAccountOrganization[];
	activeOrganizationId: string | null;
}
interface ClineAccountInput {
	apiKey: string;
	providerSettingsManager: ProviderSettingsManager;
}
/** Explicit refusal; inherited account state cannot trigger reads or refresh. */
export async function fetchClineOrganizations(
	_input: ClineAccountInput,
): Promise<AcpOrganizationState | undefined> {
	return rejectClineAccount();
}
export async function switchClineOrganization(
	_input: ClineAccountInput & { organizationId: string | null },
): Promise<void> {
	return rejectClineAccount();
}
export function getAcpOrgSubscriptionMessage(): string {
	return CLINE_ACCOUNT_DISABLED_MESSAGE;
}
export function buildOrganizationConfigOption(
	state: AcpOrganizationState,
): SessionConfigOption {
	return {
		type: "select",
		id: ORGANIZATION_CONFIG_ID,
		name: "Account",
		description:
			"The Cline account usage is billed to — your personal account or an organization",
		category: "account",
		currentValue: state.activeOrganizationId ?? PERSONAL_ACCOUNT_VALUE,
		options: [
			{ value: PERSONAL_ACCOUNT_VALUE, name: "Personal" },
			...state.organizations.map((org) => ({
				value: org.organizationId,
				name: org.name,
			})),
		],
	};
}
