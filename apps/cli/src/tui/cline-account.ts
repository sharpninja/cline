import type {
	ClineAccountBalance,
	ClineAccountOrganization,
	ClineAccountOrganizationBalance,
	ClineAccountService,
	ClineAccountUser,
	ClineSubscriptionPlan,
	ProviderSettings,
	ProviderSettingsManager,
	UserCurrentPlan,
} from "@cline/core";
import {
	assertDirectProvider,
	rejectClineAccount,
} from "../utils/cloud-policy";
import { formatCreditBalance, normalizeCreditBalance } from "../utils/output";
import type { Config } from "../utils/types";
export const CLINE_CREDITS_DASHBOARD_URL =
	"https://app.cline.bot/dashboard/account?tab=credits";

type ClineAccountConfig = Pick<Config, "apiKey" | "logger" | "providerId">;

export interface ClineAccountSnapshot {
	user: ClineAccountUser;
	balance: ClineAccountBalance;
	organizationBalance: ClineAccountOrganizationBalance | null;
	organizations: ClineAccountOrganization[];
	activeOrganization: ClineAccountOrganization | null;
	displayedBalance: number;
}

export function formatClineCredits(value: number): string {
	return formatCreditBalance(normalizeCreditBalance(value));
}

// FIXME: These message checks are temporary until structured error types are
// passed through to the CLI instead of plain error strings.
export function isClineAccountAuthErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	return (
		normalized === "no cline account auth token found" ||
		normalized.includes("requires re-authentication")
	);
}

export function isClineAccountCreditsErrorMessage(message: string): boolean {
	const normalized = message.trim().toLowerCase();
	// The Cline API's 402 response carries `code: "insufficient_credits"` and
	// the message "Not enough credits available". Depending on how much of the
	// payload survives error extraction, the CLI may see the raw JSON blob or
	// just the human-readable message, so match both. The
	// "insufficient balance" pair is an older backend phrasing kept for safety.
	return (
		normalized.includes("insufficient_credits") ||
		normalized.includes("not enough credits") ||
		(normalized.includes("insufficient balance") &&
			normalized.includes("cline credits balance"))
	);
}

type AccountInput = {
	config: ClineAccountConfig;
	clineApiBaseUrl?: string;
	clineProviderSettings?: ProviderSettings;
};

/** Refuse before reading persisted credentials or attempting OAuth refresh. */
export async function createClineAccountService(
	_input: AccountInput & { providerSettingsManager?: ProviderSettingsManager },
): Promise<ClineAccountService | undefined> {
	return rejectClineAccount();
}
export async function loadClineAccountSnapshot(
	_input: AccountInput,
): Promise<ClineAccountSnapshot> {
	return rejectClineAccount();
}
export async function switchClineAccount(
	_input: AccountInput & { organizationId?: string | null },
): Promise<void> {
	return rejectClineAccount();
}
export async function loadIndividualSubscriptionPlans(
	_input: AccountInput,
): Promise<ClineSubscriptionPlan[]> {
	return rejectClineAccount();
}
export async function loadCurrentUserPlan(
	_input: AccountInput,
): Promise<UserCurrentPlan | undefined> {
	return rejectClineAccount();
}
export async function loadCurrentUserPlanFromProviderSettings(_input: {
	providerSettingsManager: ProviderSettingsManager;
	clineApiBaseUrl?: string;
}): Promise<UserCurrentPlan | undefined> {
	return rejectClineAccount();
}
export async function loadIndividualSubscriptionPlansFromProviderSettings(_input: {
	providerSettingsManager: ProviderSettingsManager;
	clineApiBaseUrl?: string;
}): Promise<ClineSubscriptionPlan[]> {
	return rejectClineAccount();
}

export async function onProviderChange(input: {
	config: ClineAccountConfig;
	providerId: string;
}): Promise<void> {
	assertDirectProvider(input.providerId);
}
