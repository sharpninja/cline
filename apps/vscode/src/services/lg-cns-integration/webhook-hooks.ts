import { getStorageNamespace, resolveDocumentsClineDirectoryPath, validateStoragePath } from "@cline/shared/storage"
import fs from "fs/promises"
import path from "path"
import { ensureHooksDirectoryExists, getDocumentsPath } from "@/core/storage/disk"

type LgHookScript = {
	fileName: string
	content: string
	mode?: number
}

export async function writeLgWebhookConfig(webhookUrl: string, webhookToken: string): Promise<void> {
	const clineDir = getStorageNamespace() ? resolveDocumentsClineDirectoryPath() : path.join(await getDocumentsPath(), "Cline")
	const configPath = path.join(clineDir, "webhook_config.json")

	await fs.mkdir(validateStoragePath(clineDir), { recursive: true })
	await fs.writeFile(
		validateStoragePath(configPath),
		JSON.stringify(
			{
				webhook_url: webhookUrl,
				webhook_token: webhookToken,
				created_at: new Date().toISOString(),
			},
			null,
			2,
		),
		"utf-8",
	)
}

export async function writeLgWebhookHooks(): Promise<void> {
	const hooksDir = await ensureHooksDirectoryExists()
	const configPath = getStorageNamespace()
		? validateStoragePath(path.join(resolveDocumentsClineDirectoryPath(), "webhook_config.json"))
		: undefined
	const hooks = getLgWebhookHookScripts()

	for (const hook of hooks) {
		const hookPath = path.join(hooksDir, hook.fileName)
		const content = configPath
			? bindPrivateWebhookConfig(hook.content, configPath, process.platform === "win32")
			: hook.content
		await fs.writeFile(validateStoragePath(hookPath), content, "utf-8")
		if (hook.mode !== undefined) {
			await fs.chmod(validateStoragePath(hookPath), hook.mode)
		}
	}
}

/** Bind generated hooks to the canonical target approved by the host. New aliases require regeneration. */
function bindPrivateWebhookConfig(script: string, configPath: string, powershell: boolean): string {
	if (powershell) {
		const encoded = Buffer.from(configPath, "utf8").toString("base64")
		const guard = `$configPath = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String("${encoded}"))
$current = $configPath
while ($current) {
    try { $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] { $item = $null }
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        [Console]::Error.WriteLine("Webhook storage alias changed; regenerate hooks.")
        exit 1
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
}
`
		const lookup = `    $documentsPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)
    if (-not $documentsPath) {
        $documentsPath = Join-Path $HOME "Documents"
    }

    $configPath = Join-Path (Join-Path $documentsPath "Cline") "webhook_config.json"`
		if (!script.includes(lookup)) throw new Error("Webhook configuration template is missing.")
		return guard + script.replace(lookup, "    # Configuration target was validated above.")
	}
	const lookup = '  const configPath = path.join(os.homedir(), "Documents", "Cline", "webhook_config.json")'
	if (!script.includes(lookup)) throw new Error("Webhook configuration template is missing.")
	const guard = `  const configPath = ${JSON.stringify(configPath)}
  const disk = require("fs")
  let current = configPath
  while (current) {
    let item
    try { item = disk.lstatSync(current) } catch (error) { if (error.code !== "ENOENT") throw error }
    if (item?.isSymbolicLink()) throw new Error("Webhook storage alias changed; regenerate hooks.")
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }`
	return script.replace(lookup, guard)
}
function getLgWebhookHookScripts(): LgHookScript[] {
	if (process.platform === "win32") {
		return [
			{ fileName: "TaskStart.ps1", content: TASK_START_POWERSHELL },
			{ fileName: "PostToolUse.ps1", content: POST_TOOL_USE_POWERSHELL },
			{ fileName: "TaskComplete.ps1", content: TASK_COMPLETE_POWERSHELL },
		]
	}

	return [
		{ fileName: "TaskStart", content: TASK_START_NODE, mode: 0o755 },
		{ fileName: "PostToolUse", content: POST_TOOL_USE_NODE, mode: 0o755 },
		{ fileName: "TaskComplete", content: TASK_COMPLETE_NODE, mode: 0o755 },
	]
}

const TASK_START_POWERSHELL = `try {
    $rawInput = [Console]::In.ReadToEnd()
    $inputData = $null
    if ($rawInput) {
        $inputData = $rawInput | ConvertFrom-Json
    }
} catch {
    $inputData = $null
}

try {
    $documentsPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)
    if (-not $documentsPath) {
        $documentsPath = Join-Path $HOME "Documents"
    }

    $configPath = Join-Path (Join-Path $documentsPath "Cline") "webhook_config.json"
    if (-not (Test-Path $configPath)) {
        @{ cancel = $false } | ConvertTo-Json -Compress
        exit 0
    }

    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $config.webhook_url -or -not $config.webhook_token) {
        @{ cancel = $false } | ConvertTo-Json -Compress
        exit 0
    }

    $workspaceRoots = @()
    if ($inputData -and $null -ne $inputData.workspaceRoots) {
        $workspaceRoots = $inputData.workspaceRoots
    }

    $taskMetadata = @{}
    if ($inputData -and $inputData.taskStart -and $null -ne $inputData.taskStart.taskMetadata) {
        $taskMetadata = $inputData.taskStart.taskMetadata
    }

    $payload = @{
        event = "task_started"
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        data = @{
            task_id = if ($inputData) { $inputData.taskId } else { $null }
            cline_version = if ($inputData) { $inputData.clineVersion } else { $null }
            workspace_roots = $workspaceRoots
            task_metadata = $taskMetadata
        }
    }

    $headers = @{
        Authorization = "Bearer $($config.webhook_token)"
        "Content-Type" = "application/json"
    }

    Invoke-RestMethod -Method Post -Uri $config.webhook_url -Headers $headers -Body ($payload | ConvertTo-Json -Depth 100) -ContentType "application/json" -TimeoutSec 5 | Out-Null
} catch {}

@{ cancel = $false } | ConvertTo-Json -Compress
`

const POST_TOOL_USE_POWERSHELL = `try {
    $rawInput = [Console]::In.ReadToEnd()
    $inputData = $null
    if ($rawInput) {
        $inputData = $rawInput | ConvertFrom-Json
    }
} catch {
    $inputData = $null
}

try {
    $documentsPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)
    if (-not $documentsPath) {
        $documentsPath = Join-Path $HOME "Documents"
    }

    $configPath = Join-Path (Join-Path $documentsPath "Cline") "webhook_config.json"
    if (-not (Test-Path $configPath)) {
        @{ cancel = $false } | ConvertTo-Json -Compress
        exit 0
    }

    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $config.webhook_url -or -not $config.webhook_token) {
        @{ cancel = $false } | ConvertTo-Json -Compress
        exit 0
    }

    $toolData = $null
    if ($inputData -and $inputData.postToolUse) {
        $toolData = $inputData.postToolUse
    }

    $payload = @{
        event = "tool_executed"
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        data = @{
            task_id = if ($inputData) { $inputData.taskId } else { $null }
            tool_name = if ($toolData) { $toolData.toolName } else { $null }
            parameters = if ($toolData -and $null -ne $toolData.parameters) { $toolData.parameters } else { @{} }
            success = if ($toolData) { [bool]$toolData.success } else { $false }
            execution_time_ms = if ($toolData) { $toolData.executionTimeMs } else { $null }
        }
    }

    $headers = @{
        Authorization = "Bearer $($config.webhook_token)"
        "Content-Type" = "application/json"
    }

    Invoke-RestMethod -Method Post -Uri $config.webhook_url -Headers $headers -Body ($payload | ConvertTo-Json -Depth 100) -ContentType "application/json" -TimeoutSec 5 | Out-Null
} catch {}

@{ cancel = $false } | ConvertTo-Json -Compress
`

const TASK_COMPLETE_POWERSHELL = `try {
    $rawInput = [Console]::In.ReadToEnd()
    $inputData = $null
    if ($rawInput) {
        $inputData = $rawInput | ConvertFrom-Json
    }
} catch {
    $inputData = $null
}

try {
    $documentsPath = [System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)
    if (-not $documentsPath) {
        $documentsPath = Join-Path $HOME "Documents"
    }

    $configPath = Join-Path (Join-Path $documentsPath "Cline") "webhook_config.json"
    if (-not (Test-Path $configPath)) {
        @{ cancel = $false } | ConvertTo-Json -Compress
        exit 0
    }

    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $config.webhook_url -or -not $config.webhook_token) {
        @{ cancel = $false } | ConvertTo-Json -Compress
        exit 0
    }

    $taskMetadata = @{}
    if ($inputData -and $inputData.taskComplete -and $null -ne $inputData.taskComplete.taskMetadata) {
        $taskMetadata = $inputData.taskComplete.taskMetadata
    }

    $payload = @{
        event = "task_completed"
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        data = @{
            task_id = if ($inputData) { $inputData.taskId } else { $null }
            task_metadata = $taskMetadata
        }
    }

    $headers = @{
        Authorization = "Bearer $($config.webhook_token)"
        "Content-Type" = "application/json"
    }

    Invoke-RestMethod -Method Post -Uri $config.webhook_url -Headers $headers -Body ($payload | ConvertTo-Json -Depth 100) -ContentType "application/json" -TimeoutSec 5 | Out-Null
} catch {}

@{ cancel = $false } | ConvertTo-Json -Compress
`

const NODE_HOOK_SHARED = `#!/usr/bin/env node
const fs = require("fs/promises")
const os = require("os")
const path = require("path")

async function readConfig() {
  const configPath = path.join(os.homedir(), "Documents", "Cline", "webhook_config.json")
  try {
    const rawConfig = await fs.readFile(configPath, "utf-8")
    const config = JSON.parse(rawConfig)
    if (!config.webhook_url || !config.webhook_token) {
      return null
    }
    return config
  } catch {
    return null
  }
}

async function postEvent(config, payload) {
  let timeout
  try {
    const controller = new AbortController()
    timeout = setTimeout(() => controller.abort(), 5000)
    await fetch(config.webhook_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: \`Bearer \${config.webhook_token}\`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } catch {} finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

async function main(buildPayload) {
  let input = {}
  try {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    const rawInput = Buffer.concat(chunks).toString("utf8")
    input = rawInput ? JSON.parse(rawInput) : {}
  } catch {}

  const config = await readConfig()
  if (config) {
    await postEvent(config, buildPayload(input))
  }

  process.stdout.write(JSON.stringify({ cancel: false }))
}
`

const TASK_START_NODE = `${NODE_HOOK_SHARED}
main((input) => ({
  event: "task_started",
  timestamp: new Date().toISOString(),
  data: {
    task_id: input.taskId ?? null,
    cline_version: input.clineVersion ?? null,
    workspace_roots: input.workspaceRoots ?? [],
    task_metadata: input.taskStart?.taskMetadata ?? {},
  },
}))
`

const POST_TOOL_USE_NODE = `${NODE_HOOK_SHARED}
main((input) => ({
  event: "tool_executed",
  timestamp: new Date().toISOString(),
  data: {
    task_id: input.taskId ?? null,
    tool_name: input.postToolUse?.toolName ?? null,
    parameters: input.postToolUse?.parameters ?? {},
    success: Boolean(input.postToolUse?.success),
    execution_time_ms: input.postToolUse?.executionTimeMs ?? null,
  },
}))
`

const TASK_COMPLETE_NODE = `${NODE_HOOK_SHARED}
main((input) => ({
  event: "task_completed",
  timestamp: new Date().toISOString(),
  data: {
    task_id: input.taskId ?? null,
    task_metadata: input.taskComplete?.taskMetadata ?? {},
  },
}))
`
