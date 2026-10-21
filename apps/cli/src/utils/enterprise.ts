// SPDX-License-Identifier: Apache-2.0
/**
 * cline-qb never loads Cline account remote configuration or creates account
 * transcript-upload metadata. Existing call sites may still ask for metadata;
 * returning no metadata performs no credential read or network request.
 */
export async function resolveCliSessionMetadata(
  _sessionId?: string,
): Promise<Record<string, unknown> | undefined> {
  return undefined;
}