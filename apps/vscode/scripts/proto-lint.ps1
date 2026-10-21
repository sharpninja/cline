#Requires -Version 7.0
# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
Validates protobuf sources without rewriting them (TEST-QB-055).
.DESCRIPTION
Every Buf failure and every repeated-capital RPC name fails verification.
Run from the extension workspace, where buf.yaml selects the source modules.
.PARAMETER BufPath
Buf executable, normally resolved from the package manager's local binary PATH.
#>
[CmdletBinding()]
param([string]$BufPath = 'buf')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-BufCheck {
    param([string[]]$Arguments)
    $global:LASTEXITCODE = 0
    & $BufPath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Buf $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

try {
    Invoke-BufCheck -Arguments @('lint')
    Invoke-BufCheck -Arguments @('format', '--diff', '--exit-code')

    # Dependency trees and downloaded test hosts are not repository proto sources.
    $sources = Get-ChildItem -LiteralPath . -Filter '*.proto' -File -Recurse |
        Where-Object { $_.FullName -notmatch '[/\\](node_modules|\.vscode-test)[/\\]' }
    $violations = @($sources | Select-String -CaseSensitive -Pattern '\brpc\s+[A-Za-z0-9_]*[A-Z]{2}[A-Za-z0-9_]*\s*\(')
    if ($violations.Count -gt 0) {
        foreach ($violation in $violations) {
            [Console]::Error.WriteLine("$($violation.Path):$($violation.LineNumber): RPC names cannot contain repeated capital letters.")
        }
        exit 1
    }
    Write-Output 'Proto validation passed without modifying sources.'
    exit 0
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
