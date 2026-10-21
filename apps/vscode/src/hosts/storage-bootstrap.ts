// SPDX-License-Identifier: Apache-2.0
// Imported first by product entrypoints, before storage-bearing services.
import { initializeQbrainStorage } from "@cline/qbrain-governance/host-storage"
import { initializeQbrainHubNamespace } from "@cline/qbrain-governance/hub-namespace"

initializeQbrainStorage()
initializeQbrainHubNamespace()
