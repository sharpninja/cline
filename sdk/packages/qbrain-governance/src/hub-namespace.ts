// SPDX-License-Identifier: Apache-2.0
import { type HubNamespace, registerHubNamespace } from "@cline/shared";

const namespace: HubNamespace = Object.freeze({
	requirePeerIdentity: true,
	hostVariable: "CLINE_QB_HUB_HOST",
	portVariable: "CLINE_QB_HUB_PORT",
	discoveryVariable: "CLINE_QB_HUB_DISCOVERY_PATH",
	defaultHost: "127.0.0.1",
	productionPort: 25473,
	developmentPort: 25476,
	pathname: "/hub",
});
/** Select endpoints and require verified host identity before any hub operation. */
export function initializeQbrainHubNamespace(): void {
	registerHubNamespace(namespace);
}
