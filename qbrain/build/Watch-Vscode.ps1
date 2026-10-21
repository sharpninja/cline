# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param([string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path)
$ErrorActionPreference='Stop'
Import-Module "$PSScriptRoot/VscodeBuild.psm1" -Force
$cwd=Join-Path $RepositoryRoot 'apps/vscode'
$manifest=Get-Content (Join-Path $cwd 'package.json') -Raw|ConvertFrom-Json -AsHashtable
$arguments=@(Get-QbrainVscodeWatchArguments -Scripts $manifest.scripts)
$bun=Get-QbrainBuildRuntimePath -Candidates @(Get-Command bun -CommandType Application -ErrorAction Stop)
$version=@(& $bun --version)-join "`n"
if($LASTEXITCODE -ne 0 -or $version.Trim() -cne '1.4.2'){throw 'This repository requires Bun 1.4.2.'}
if(-not $PSCmdlet.ShouldProcess($cwd,'Run the unchanged native esbuild and TypeScript watch scripts in parallel')){return}
Push-Location $cwd
try{& $bun @arguments;$code=$LASTEXITCODE}finally{Pop-Location}
exit $code