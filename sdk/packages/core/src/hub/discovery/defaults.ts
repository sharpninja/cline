import {
	CLINE_HUB_DEV_PORT,
	CLINE_HUB_PORT,
	getHubNamespace,
	resolveClineBuildEnv,
} from "@cline/shared";

const HUB_HOST_ENV = "CLINE_HUB_HOST";
const HUB_PORT_ENV = "CLINE_HUB_PORT";
const HUB_PATHNAME_ENV = "CLINE_HUB_PATHNAME";
export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = CLINE_HUB_PORT;
export const DEFAULT_HUB_PATHNAME = "/hub";
export interface HubEndpointOverrides {
	host?: string;
	port?: number;
	pathname?: string;
}
export interface ResolveHubDefaultsOptions {
	env?: NodeJS.ProcessEnv;
	execArgv?: string[];
}
function fallbackHubPort(options: ResolveHubDefaultsOptions): number {
	const namespace = getHubNamespace();
	return resolveClineBuildEnv(options) === "development"
		? (namespace?.developmentPort ?? CLINE_HUB_DEV_PORT)
		: (namespace?.productionPort ?? DEFAULT_HUB_PORT);
}
export function hasExplicitHubPort(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	return Boolean(env[getHubNamespace()?.portVariable ?? HUB_PORT_ENV]?.trim());
}
export function resolveDefaultHubHost(
	options: ResolveHubDefaultsOptions = {},
): string {
	const env = options.env ?? process.env;
	const namespace = getHubNamespace();
	return (
		env[namespace?.hostVariable ?? HUB_HOST_ENV]?.trim() ||
		namespace?.defaultHost ||
		DEFAULT_HUB_HOST
	);
}
export function resolveDefaultHubPort(
	options: ResolveHubDefaultsOptions = {},
): number {
	const env = options.env ?? process.env;
	const namespace = getHubNamespace();
	const variable = namespace?.portVariable ?? HUB_PORT_ENV;
	const raw = env[variable]?.trim();
	if (!raw) return fallbackHubPort(options);
	const port = namespace ? Number(raw) : Number.parseInt(raw, 10);
	if (
		!Number.isInteger(port) ||
		port < 1 ||
		port > 65535 ||
		(namespace && !/^\d+$/.test(raw))
	) {
		if (namespace)
			throw new Error(`${variable} must be an integer port from 1 to 65535.`);
		return fallbackHubPort(options);
	}
	return port;
}
export function resolveDefaultHubPathname(
	options: ResolveHubDefaultsOptions = {},
): string {
	const namespace = getHubNamespace();
	return (
		namespace?.pathname ??
		((options.env ?? process.env)[HUB_PATHNAME_ENV]?.trim() ||
			DEFAULT_HUB_PATHNAME)
	);
}
export function resolveHubEndpointOptions(
	overrides: HubEndpointOverrides = {},
	options: ResolveHubDefaultsOptions = {},
): Required<HubEndpointOverrides> {
	const namespace = getHubNamespace();
	if (namespace) {
		if (
			overrides.pathname !== undefined &&
			overrides.pathname !== namespace.pathname
		)
			throw new Error("Hub pathname must match the host namespace.");
		if (
			overrides.port !== undefined &&
			(!Number.isInteger(overrides.port) ||
				overrides.port < 0 ||
				overrides.port > 65535)
		)
			throw new Error("Hub port must be an integer from 0 to 65535.");
		if (overrides.host !== undefined && !overrides.host.trim())
			throw new Error("Hub host cannot be empty.");
	}
	return {
		host: overrides.host ?? resolveDefaultHubHost(options),
		port: overrides.port ?? resolveDefaultHubPort(options),
		pathname: overrides.pathname ?? resolveDefaultHubPathname(options),
	};
}
