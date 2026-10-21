# SPDX-License-Identifier: Apache-2.0
Set-StrictMode -Version Latest

function Get-QbrainBuildSearchPath {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$WorkingDirectory,
        [AllowEmptyString()][string]$InheritedPath=''
    )
    $root=[IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($RepositoryRoot))
    $directory=[IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($WorkingDirectory))
    $comparison=if([OperatingSystem]::IsWindows()){[StringComparison]::OrdinalIgnoreCase}else{[StringComparison]::Ordinal}
    if(-not $directory.Equals($root,$comparison) -and -not $directory.StartsWith($root+[IO.Path]::DirectorySeparatorChar,$comparison)){throw 'Build working directory is outside the repository.'}
    $paths=[Collections.Generic.List[string]]::new()
    while($true){
        $paths.Add((Join-Path $directory 'node_modules/.bin'))
        if($directory.Equals($root,$comparison)){break}
        $directory=[IO.Path]::GetDirectoryName($directory)
    }
    if(-not [string]::IsNullOrEmpty($InheritedPath)){$paths.Add($InheritedPath)}
    return $paths -join [IO.Path]::PathSeparator
}

function Get-QbrainBuildRuntimePath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Candidates)
    if($Candidates.Count -eq 0){throw 'No matching runtime application was found.'}
    $path=$Candidates[0].Source
    if($path -isnot [string] -or [string]::IsNullOrWhiteSpace($path)){throw 'The runtime application must have one nonempty executable path.'}
    return $path
}

function Get-QbrainVscodeWatchArguments {
    [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSUseSingularNouns','',Justification='Arguments denotes the ordered argv array, matching the subprocess contract under test.')]
    [CmdletBinding()]
    param([Parameter(Mandatory)][hashtable]$Scripts)
    # Pin the existing native parallel orchestration. A changed command or newly
    # introduced lifecycle hook requires a new command-chain review.
    $expected=@{watch='bun run --parallel watch:esbuild watch:tsc';'watch:esbuild'='bun esbuild.mjs --watch';'watch:tsc'='tsc --noEmit --watch --project tsconfig.json'}
    foreach($key in $expected.Keys){if(-not $Scripts.ContainsKey($key) -or $Scripts[$key] -cne $expected[$key]){throw "Unreviewed native watch script: $key"}}
    foreach($key in @('prewatch:esbuild','postwatch:esbuild','prewatch:tsc','postwatch:tsc')){if($Scripts.ContainsKey($key)){throw "Unreviewed native watch hook: $key"}}
    return @('--shell=bun','run','--parallel','watch:esbuild','watch:tsc')
}

function Get-QbrainVscodeBuildStep {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Task)
    $extension='apps/vscode'
    $webview='apps/vscode/webview-ui'
    $steps=@{
        watch=@{id='watch';runtime='pwsh';cwd=$extension;entry='../../qbrain/build/Watch-Vscode.ps1';arguments=@()}
        generatedFormat=@{id='generatedFormat';runtime='node';cwd=$extension;entry='node_modules/@biomejs/biome/bin/biome';arguments=@('format','--config-path','./biome.jsonc','src/shared/proto','src/core/controller','src/hosts/','webview-ui/src/services','src/generated','--write','--no-errors-on-unmatched')}
        format=@{id='format';runtime='node';cwd=$extension;entry='node_modules/@biomejs/biome/bin/biome';arguments=@('format','--config-path','./biome.jsonc','--changed','--since','main','--no-errors-on-unmatched','--files-ignore-unknown=true','--diagnostic-level=error','--semicolons=as-needed')}
        storageBootstrap=@{id='storageBootstrap';runtime='node';cwd=$extension;entry='scripts/verify-storage-bootstrap.cjs';arguments=@('dist/extension.js','dist-standalone/cline-core.js')}
        storageActivation=@{id='storageActivation';runtime='node';cwd=$extension;entry='scripts/verify-vscode-storage-activation.cjs';arguments=@()}
        storageWebview=@{id='storageWebview';runtime='node';cwd=$extension;entry='scripts/verify-webview-isolation.cjs';arguments=@()}
        vitest=@{id='vitest';runtime='node';cwd=$extension;entry='node_modules/vitest/vitest.mjs';arguments=@('run','--config','vitest.config.ts')}
        unit=@{id='unit';runtime='bun';cwd=$extension;entry='scripts/run-bun-unit-tests.ts';arguments=@()}
        bunTests=@{id='bunTests';runtime='bun';cwd=$extension;entry='scripts/run-bun-tests.ts';arguments=@()}
        integration=@{id='integration';runtime='node';cwd=$extension;entry='node_modules/@vscode/test-cli/out/bin.mjs';arguments=@()}
        coverage=@{id='coverage';runtime='node';cwd=$extension;entry='node_modules/@vscode/test-cli/out/bin.mjs';arguments=@('--coverage')}
        webviewTests=@{id='webviewTests';runtime='node';cwd=$webview;entry='node_modules/vitest/vitest.mjs';arguments=@('run')}
        webviewCoverage=@{id='webviewCoverage';runtime='node';cwd=$webview;entry='node_modules/vitest/vitest.mjs';arguments=@('run','--coverage')}
        platformTests=@{id='platformTests';runtime='bun';cwd=$extension;entry='scripts/testing-platform-orchestrator.ts';arguments=@('tests/specs/','--count=1','--coverage')}
        generate=@{id='generate';runtime='node';cwd=$extension;entry='scripts/build-proto.mjs';arguments=@()}
        types=@{id='types';runtime='node';cwd=$extension;entry='node_modules/typescript/bin/tsc';arguments=@('--noEmit')}
        compatibility=@{id='compatibility';runtime='node';cwd=$extension;entry='node_modules/typescript/bin/tsc';arguments=@('--project','tsconfig.vscode-compat.json','--noEmit')}
        webviewTypes=@{id='webviewTypes';runtime='node';cwd=$webview;entry='node_modules/typescript/bin/tsc';arguments=@('--noEmit')}
        biome=@{id='biome';runtime='node';cwd=$extension;entry='node_modules/@biomejs/biome/bin/biome';arguments=@('lint','--config-path','./biome.jsonc','--no-errors-on-unmatched','--files-ignore-unknown=true','--diagnostic-level=error')}
        protoLint=@{id='protoLint';runtime='pwsh';cwd=$extension;entry='scripts/proto-lint.ps1';arguments=@()}
        webviewBuildTypes=@{id='webviewBuildTypes';runtime='node';cwd=$webview;entry='node_modules/typescript/bin/tsc';arguments=@('-b')}
        vite=@{id='vite';runtime='node';cwd=$webview;entry='node_modules/vite/bin/vite.js';arguments=@('build')}
        extension=@{id='extension';runtime='bun';cwd=$extension;entry='esbuild.mjs';arguments=@()}
        production=@{id='production';runtime='bun';cwd=$extension;entry='esbuild.mjs';arguments=@('--production')}
        standalone=@{id='standalone';runtime='bun';cwd=$extension;entry='esbuild.mjs';arguments=@('--standalone')}
        standalonePackage=@{id='standalonePackage';runtime='node';cwd=$extension;entry='scripts/qbrain/package-standalone.mjs';arguments=@()}
        mocha=@{id='mocha';runtime='node';cwd=$extension;entry='scripts/build-tests.js';arguments=@()}
        e2eDependencies=@{id='e2eDependencies';runtime='node';cwd=$extension;entry='scripts/qbrain/prepare-e2e.mjs';arguments=@()}
        playwright=@{id='playwright';runtime='node';cwd=$extension;entry='node_modules/@playwright/test/cli.js';arguments=@('test')}
    }
    $ids=switch -CaseSensitive ($Task){
        'dev' {'watch'}
        'watch' {'watch'}
        'format:generated' {'generatedFormat'}
        'format' {'format'}
        'ci:check-all' {'types';'compatibility';'webviewTypes';'biome';'protoLint';'format'}
        'test:storage-startup' {'extension';'standalone';'storageBootstrap';'storageActivation'}
        'test:storage-webview' {'storageWebview'}
        'test:vitest' {'vitest'}
        'test:unit' {'unit'}
        'test:bun' {'bunTests'}
        'test:integration' {'mocha';'integration'}
        'test:coverage' {'mocha';'coverage'}
        'test:webview' {'webviewTests'}
        'test:webview:coverage' {'webviewCoverage'}
        'test:tp-orchestrator' {'platformTests'}
        'prepare' {'generate'}
        'check-types' {'types';'compatibility';'webviewTypes'}
        'lint' {'biome';'protoLint'}
        'build:webview' {'webviewBuildTypes';'vite'}
        'extension' {'extension'}
        'compile' {'types';'compatibility';'webviewTypes';'biome';'protoLint';'extension'}
        'compile-standalone' {'types';'compatibility';'webviewTypes';'biome';'protoLint';'standalone';'standalonePackage'}
        'compile-tests' {'mocha'}
        'build:production' {'webviewBuildTypes';'vite';'production'}
        'package' {'types';'compatibility';'webviewTypes';'biome';'protoLint';'webviewBuildTypes';'vite';'production'}
        'ci:build' {'webviewBuildTypes';'vite';'extension';'mocha'}
        'test:e2e' {'webviewBuildTypes';'vite';'production';'e2eDependencies';'playwright'}
        default {throw "Unsupported VS Code build task: $Task"}
    }
    foreach($id in $ids){$steps[$id]}
}

function Invoke-QbrainVscodeBuildGraph {
    [CmdletBinding()]
    param([Parameter(Mandatory)][object[]]$Steps,[Parameter(Mandatory)][scriptblock]$RunStep)
    if(-not $Steps.Count){throw 'A build graph must contain at least one step.'}
    for($index=0;$index -lt $Steps.Count;$index++){
        $output=@(& $RunStep $Steps[$index] $index)
        if($output.Count -ne 1 -or $output[0] -isnot [int]){throw 'The command runner must return exactly one integer exit code.'}
        if($output[0] -ne 0){return @{exitCode=$output[0];executed=$index+1;failedStep=$Steps[$index].id}}
    }
    return @{exitCode=0;executed=$Steps.Count;failedStep=$null}
}

Export-ModuleMember -Function Get-QbrainVscodeWatchArguments,Get-QbrainBuildSearchPath,Get-QbrainBuildRuntimePath,Get-QbrainVscodeBuildStep,Invoke-QbrainVscodeBuildGraph
