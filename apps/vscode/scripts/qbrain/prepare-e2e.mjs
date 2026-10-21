// SPDX-License-Identifier: Apache-2.0
// Derived from src/test/e2e/utils/build.mjs at B0 fa840c741c3fc2eb49e7e0a4484895a99dae5cc5; original retained.
// Owned preparation changes only the installer command to the approved Bun invocation.
/**
 * Installs what the E2E tests need besides the built extension: the VS Code
 * build they drive, and the ffmpeg build Playwright records test videos with.
 * The tests launch VS Code through Playwright's Electron support, so they need
 * no Playwright browser.
 */
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"
import { execa } from "execa"

const TIMEOUT_MINUTE = 5
const INSTALL_TIMEOUT_MS = TIMEOUT_MINUTE * 60 * 1000

async function installVSCode() {
	const VSCODE_APP_TYPE = "stable"
	console.log("Downloading VS Code...")
	return await downloadAndUnzipVSCode(VSCODE_APP_TYPE, undefined, new SilentReporter())
}

async function installFfmpeg() {
	console.log("Installing Playwright ffmpeg...")
	try {
		await execa("bun", ["x", "playwright", "install", "ffmpeg"], {
			stdio: "inherit",
		})
		console.log("Playwright ffmpeg installation completed successfully")
	} catch (error) {
		throw new Error(`Failed to install Playwright ffmpeg: ${error}`)
	}
}

async function installDependencies() {
	return Promise.all([installVSCode(), installFfmpeg()])
}

async function main() {
	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error("Installation timed out.")), INSTALL_TIMEOUT_MS),
	)
	await Promise.race([installDependencies(), timeoutPromise])
	console.log("Installation complete.")
	process.exit(0)
}

main().catch((error) => {
	console.error("Failed to install dependencies for E2E test", error)
	process.exit(1)
})
