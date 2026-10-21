// SPDX-License-Identifier: Apache-2.0
import type { BasicLogger, ITelemetryService } from "@cline/core";

/** Product policy, independent of inherited telemetry settings or credentials. */
const disabledTelemetry: ITelemetryService = Object.freeze({
  setDistinctId() {}, setMetadata() {}, updateMetadata() {},
  setCommonProperties() {}, updateCommonProperties() {},
  isEnabled: () => false,
  capture() {}, captureRequired() {}, recordCounter() {},
  recordHistogram() {}, recordGauge() {},
  async flush() {}, async dispose() {},
});

export function getCliTelemetryService(_logger?: BasicLogger): ITelemetryService {
  return disabledTelemetry;
}
export async function disposeCliTelemetryService(): Promise<void> {}

export interface CliTelemetryAccountContext {
  id?: string;
  email?: string;
  provider?: string;
  organizationId?: string;
  organizationName?: string;
  memberId?: string;
}

/** Legacy callers cannot activate an exporter or retain account identity. */
export function identifyTelemetryAccount(
  _account: CliTelemetryAccountContext, _logger?: BasicLogger,
): void {}
export function captureCliExtensionActivated(
  _logger?: BasicLogger, _account?: CliTelemetryAccountContext,
): void {}