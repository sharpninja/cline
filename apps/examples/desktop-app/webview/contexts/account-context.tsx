"use client";
import type { ClineAccountOrganization, ClineAccountUser } from "@cline/core";
import { createContext, useContext, useMemo, type ReactNode } from "react";

// Retained only as the address of legacy data. Never read, migrate, or delete it.
export const ACCOUNT_IDENTITY_STORAGE_KEY = "cline.code.account-identity.v1";
type AccountContextValue = {
	user: ClineAccountUser | null;
	accountReady: boolean;
	organizations: ClineAccountOrganization[];
	activeOrganization: ClineAccountOrganization | null;
	refreshAccount: () => Promise<void>;
};
function unavailableAccount(): AccountContextValue {
	return {
		user: null,
		accountReady: true,
		organizations: [],
		activeOrganization: null,
		refreshAccount: async () => undefined,
	};
}
const AccountContext = createContext<AccountContextValue>(unavailableAccount());
export function AccountProvider({ children }: { children: ReactNode }) {
	const value = useMemo(unavailableAccount, []);
	return (
		<AccountContext.Provider value={value}>{children}</AccountContext.Provider>
	);
}
export function useAccount(): AccountContextValue {
	return useContext(AccountContext);
}
