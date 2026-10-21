export type MarketplacePrimitiveType = "mcp" | "skill" | "plugin";

export type MarketplaceTag = {
	id: string;
	label: string;
	count: number;
};

export type MarketplaceEnvVar = {
	name: string;
	required?: boolean;
	description?: string;
	url?: string;
};

export type MarketplaceEntry = {
	id: string;
	type: MarketplacePrimitiveType;
	name: string;
	featured?: boolean;
	tagline: string;
	description: string;
	tags: string[];
	install: {
		args: string[];
		env?: MarketplaceEnvVar[];
		notes?: string;
		command: string;
	};
};

export type MarketplaceCatalog = {
	version: number;
	generatedAt?: string;
	baseUrl?: string;
	counts: {
		total: number;
		plugins: number;
		skills: number;
		mcps: number;
	};
	tags: MarketplaceTag[];
	entries: MarketplaceEntry[];
};

const EMPTY_CATALOG: MarketplaceCatalog = {
	version: 1,
	counts: {
		total: 0,
		plugins: 0,
		skills: 0,
		mcps: 0,
	},
	tags: [],
	entries: [],
};

/** Product catalog is local and empty; upstream settings cannot enable fetching. */
export async function fetchMarketplaceCatalog(): Promise<MarketplaceCatalog> {
	return {
		...EMPTY_CATALOG,
		counts: { ...EMPTY_CATALOG.counts },
		tags: [],
		entries: [],
	};
}

export { EMPTY_CATALOG };
