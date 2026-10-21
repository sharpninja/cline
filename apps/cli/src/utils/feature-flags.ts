// SPDX-License-Identifier: Apache-2.0
import {
  type BasicLogger, type FeatureFlagsContext, FeatureFlagsService,
  type ITelemetryService, NoOpFeatureFlagsProvider, registerDisposable,
} from "@cline/core";

let cliFeatureFlagsService: FeatureFlagsService | undefined;

/** No machine/account identity or upstream persistent flag cache is loaded. */
export function getCliFeatureFlagsContext(): FeatureFlagsContext {
  return { clientName: "cline-qb" };
}
export function getCliFeatureFlagsService(options?: {
  logger?: BasicLogger; telemetry?: ITelemetryService;
}): FeatureFlagsService {
  if (!cliFeatureFlagsService) {
    cliFeatureFlagsService = new FeatureFlagsService({
      provider: new NoOpFeatureFlagsProvider(),
      logger: options?.logger,
      context: getCliFeatureFlagsContext(),
    });
    registerDisposable(disposeCliFeatureFlagsService);
  }
  return cliFeatureFlagsService;
}

/** Hosted refresh/account callbacks are inert in the shipped product. */
export function refreshCliFeatureFlagsInBackground(_logger?: BasicLogger): void {}
export function setCliFeatureFlagsAccountContext(_account: {
  id?: string; email?: string;
}): void {}
export async function identifyFeatureFlagsAccount(
  _account: { id?: string; email?: string }, _logger?: BasicLogger,
): Promise<void> {}
export async function disposeCliFeatureFlagsService(): Promise<void> {
  const current = cliFeatureFlagsService;
  cliFeatureFlagsService = undefined;
  await current?.dispose();
}