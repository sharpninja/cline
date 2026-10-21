// SPDX-License-Identifier: Apache-2.0
// Capture the built implementation before Bun's preload installs the bare
// package mock. A file-path import alone is not a separate module identity in
// Bun, so importing it later can return the in-memory test double instead.
import { ProviderSettingsManager } from "../../node_modules/@cline/core/dist/index.js"

export const RealProviderSettingsManager = ProviderSettingsManager
