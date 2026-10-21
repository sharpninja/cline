import { PageFrame, PageHeader } from "../page-layout";

export function AccountView() {
	return (
		<PageFrame>
			<PageHeader title="Account" description="Direct provider configuration" />
			<p className="text-sm text-muted-foreground">
				Cline account services are unavailable in cline-qb. Configure a direct
				model provider in Providers.
			</p>
		</PageFrame>
	);
}
