"use client";
import { CLINE_ACCOUNT_DISABLED_MESSAGE } from "@cline/qbrain-governance/cloud-policy";
import { PageFrame, PageHeader } from "../page-layout";

export function AccountView() {
	return (
		<PageFrame>
			<PageHeader
				title="Account"
				description={CLINE_ACCOUNT_DISABLED_MESSAGE}
			/>
		</PageFrame>
	);
}
