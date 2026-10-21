# SPDX-License-Identifier: Apache-2.0
@{
    Ripgrep = 'node scripts/qbrain/download-ripgrep.mjs'
    Force = 'Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value ''run_all=true'' -Encoding utf8NoBOM'
    Matrix = @'
$matrix = @(@{runner='ubuntu'}, @{runner='windows'}, @{runner='macos'})
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value ('matrix=' + (ConvertTo-Json -InputObject $matrix -Compress)) -Encoding utf8NoBOM
'@
    Sdk = 'bun --shell=bun run build:sdk'
    Native = @'
$nodeFile = 'node_modules/better-sqlite3/build/Release/better_sqlite3.node'
if (-not (Test-Path -LiteralPath $nodeFile -PathType Leaf)) {
    Write-Output "ERROR: better-sqlite3 native binary missing at apps/vscode/$nodeFile"
    Write-Output '(explicit native dependency preparation did not produce the required binary)'
    exit 1
}
Write-Output "Found better-sqlite3 native binary: $nodeFile"
'@
    Vitest = '& ../../qbrain/build/Invoke-VscodeCiTests.ps1 -Policy Vitest -ReceiptDirectory ''${{ runner.temp }}/cline-qb-vitest'''
    Unit = '& ../../qbrain/build/Invoke-VscodeCiTests.ps1 -Policy Unit -ReceiptDirectory ''${{ runner.temp }}/cline-qb-unit'''
    UnitOther = '& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''test:unit'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-unit'''
    Coverage = '& ../../qbrain/build/Invoke-VscodeGui.ps1 -Task ''test:coverage'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-coverage'''
    Retry = '& ../../qbrain/build/Invoke-VscodeCiTests.ps1 -Policy IntegrationRetry -ReceiptDirectory ''${{ runner.temp }}/cline-qb-integration'''
    Webview = '& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''test:webview:coverage'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-webview-coverage'''
    Platform = '& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''test:tp-orchestrator'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-platform'''
    Xvfb = @'
sudo apt-get update
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
sudo apt-get install -y xvfb
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
'@
    Aggregate = @'
if ($env:DETECT_CHANGES_RESULT -cne 'success') {
    Write-Output "detect-changes did not succeed: $env:DETECT_CHANGES_RESULT"
    exit 1
}
if ($env:VSCODE_CHANGED -cne 'true' -and $env:TESTING_PLATFORM_CHANGED -cne 'true') {
    Write-Output 'No root test paths changed; skipping root test requirements.'
    exit 0
}
if ($env:QUALITY_CHECKS_RESULT -cne 'success') {
    Write-Output "quality-checks did not succeed: $env:QUALITY_CHECKS_RESULT"
    exit 1
}
if ($env:VSCODE_CHANGED -ceq 'true' -and $env:VSCODE_TEST_RESULT -cne 'success') {
    Write-Output "vscode-test did not succeed: $env:VSCODE_TEST_RESULT"
    exit 1
}
if ($env:TESTING_PLATFORM_CHANGED -ceq 'true' -and $env:TEST_PLATFORM_RESULT -cne 'success') {
    Write-Output "test-platform-integration did not succeed: $env:TEST_PLATFORM_RESULT"
    exit 1
}
Write-Output 'Selected root test jobs passed.'
'@
}
