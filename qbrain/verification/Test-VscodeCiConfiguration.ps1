# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [ValidateSet('Mock','Implementation')][string]$Mode='Mock',
    [Parameter(Mandatory)][string]$OriginalDirectory,
    [Parameter(Mandatory)][string]$ReceiptPath,
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path
)
$ErrorActionPreference='Stop'
Import-Module powershell-yaml
$ciCommands=Import-PowerShellDataFile "$PSScriptRoot/VscodeCiCommands.psd1"
$commandNames=@{
    'Build SDK packages'='Sdk';'Assert better-sqlite3 native binary present'='Native'
    'Vitest Suites (SDK adapter + model catalog)'='Vitest';'Unit Tests (bun) - Linux'='Unit'
    'Unit Tests (bun) - Non-Linux'='UnitOther';'Extension Integration Tests - Linux'='Coverage'
    'Extension Integration Tests - Non-Linux'='Retry';'Webview Tests with Coverage'='Webview'
    'Running testing platform integration spec tests'='Platform';'Install xvfb on Linux'='Xvfb'
    'Verify selected test jobs'='Aggregate';'Download ripgrep binaries'='Ripgrep'
}
$checks=0;$negativeControls=0
function Assert-CiValue {
    param($Expected,$Actual,[string]$Location='root')
    if($null -eq $Expected){if($null -ne $Actual){throw "$Location changed"};return}
    if($Expected -is [Collections.IDictionary]){
        if($Actual -isnot [Collections.IDictionary] -or $Expected.Count -ne $Actual.Count){throw "$Location fields changed"}
        foreach($key in $Expected.Keys){if(-not $Actual.Contains($key)){throw "$Location missing $key"};Assert-CiValue $Expected[$key] $Actual[$key] "$Location/$key"};return
    }
    if($Expected -is [Collections.IList]){
        if($Actual -isnot [Collections.IList] -or $Expected.Count -ne $Actual.Count){throw "$Location length changed"}
        for($i=0;$i -lt $Expected.Count;$i++){Assert-CiValue $Expected[$i] $Actual[$i] "$Location/$i"};return
    }
    if(($Expected|ConvertTo-Json -Depth 100 -Compress) -cne ($Actual|ConvertTo-Json -Depth 100 -Compress)){throw "$Location value or type changed"}
}
function Copy-CiValue {param($Value);return ($Value|ConvertTo-Json -Depth 100|ConvertFrom-Json -AsHashtable)}
$baselineManifest=Get-Content "$OriginalDirectory/b0-manifest.json" -Raw|ConvertFrom-Json -AsHashtable
$beforeManifest=Get-Content "$OriginalDirectory/apps/vscode/package.json" -Raw|ConvertFrom-Json -AsHashtable
$expectedManifest=Copy-CiValue $beforeManifest
$expectedManifest.scripts=$baselineManifest.scripts
# The original build/dependency replacements and the explicit CI command
# contract are the only permitted changes. Every other field is compared.
$replacements=@{
    'bun run ci:check-all'=@{task='ci:check-all';receipt='quality';entry='Invoke-VscodeBuild.ps1'}
    'bun run ci:build'=@{task='ci:build';receipt='build';entry='Invoke-VscodeBuild.ps1'}
    'bun run compile-standalone'=@{task='compile-standalone';receipt='standalone';entry='Invoke-VscodeBuild.ps1'}
    'xvfb-run -a bun run test:e2e'=@{task='test:e2e';receipt='e2e';entry='Invoke-VscodeGui.ps1'}
    'bun run test:e2e'=@{task='test:e2e';receipt='e2e';entry='Invoke-VscodeBuild.ps1'}
}
$expectations=@{}
$callerCount=0;$filterCount=0;$installerCount=0;$wrapperCount=0
foreach($name in @('ext-vscode-test.yml','ext-vscode-test-e2e.yml')){
    $expected=Get-Content "$OriginalDirectory/.github/workflows/$name" -Raw|ConvertFrom-Yaml -Ordered
    foreach($job in $expected.jobs.Values){foreach($step in $job.steps){
        if($step.run -ceq 'bun install --frozen-lockfile'){
            $step.run='& ./qbrain/build/Initialize-VscodeDependencies.ps1 -ReceiptDirectory ''${{ runner.temp }}/cline-qb-dependencies'''
            $step.shell='pwsh';$installerCount++
        }
        if($step.run -and $replacements.ContainsKey([string]$step.run)){
            $item=$replacements[[string]$step.run]
            $step.run='& ../../qbrain/build/'+$item.entry+" -Task '"+$item.task+"' -ReceiptDirectory '"+'${{ runner.temp }}/cline-qb-'+$item.receipt+"'"
            $step.shell='pwsh';$callerCount++
        }
        if($step.uses -eq 'dorny/paths-filter@v3'){
            $filters=ConvertFrom-Yaml $step.with.filters -Ordered
            foreach($key in @($filters.Keys)){$filters[$key]=@($filters[$key])+@('qbrain/build/**','qbrain/verification/**');$filterCount++}
            $step.with.filters=$filters
        }
    }}
    foreach($jobKey in $expected.jobs.Keys){
        $job=$expected.jobs[$jobKey]
        if($jobKey -eq 'vscode-test'){$job.defaults.run.shell='pwsh'}
        foreach($step in $job.steps){
            $key=if($step.id -ceq 'force'){'Force'}elseif($step.id -ceq 'set-matrix'){'Matrix'}elseif($step.name -and $commandNames.ContainsKey([string]$step.name)){$commandNames[[string]$step.name]}else{$null}
            if($key){$step.run=$ciCommands[$key];$step.shell='pwsh';$wrapperCount++}
        }
    }
    $expectations[$name]=$expected
}
if($callerCount -ne 5 -or $filterCount -ne 3 -or $installerCount -ne 4 -or $wrapperCount -ne 21){throw "Baseline inventory changed: $callerCount callers, $filterCount filters, $installerCount installers, $wrapperCount wrappers."}
if($Mode -eq 'Mock'){
    # Independent fixture transform: emulate only the declared configuration edits.
    $actualManifest=Copy-CiValue $beforeManifest
    $actualManifest.scripts=Copy-CiValue $baselineManifest.scripts
    $actualWorkflows=@{}
    foreach($name in @('ext-vscode-test.yml','ext-vscode-test-e2e.yml')){
        $mock=Get-Content "$OriginalDirectory/.github/workflows/$name" -Raw|ConvertFrom-Yaml -Ordered
        foreach($job in $mock.jobs.Values){foreach($step in $job.steps){
            $command=switch($step.run){
                'bun install --frozen-lockfile' {'& ./qbrain/build/Initialize-VscodeDependencies.ps1 -ReceiptDirectory ''${{ runner.temp }}/cline-qb-dependencies'''}
                'bun run ci:check-all' {'& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''ci:check-all'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-quality'''}
                'bun run ci:build' {'& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''ci:build'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-build'''}
                'bun run compile-standalone' {'& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''compile-standalone'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-standalone'''}
                'xvfb-run -a bun run test:e2e' {'& ../../qbrain/build/Invoke-VscodeGui.ps1 -Task ''test:e2e'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-e2e'''}
                'bun run test:e2e' {'& ../../qbrain/build/Invoke-VscodeBuild.ps1 -Task ''test:e2e'' -ReceiptDirectory ''${{ runner.temp }}/cline-qb-e2e'''}
                default {$null}
            }
            if($command){$step.run=$command;$step.shell='pwsh'}
            if($step.uses -eq 'dorny/paths-filter@v3'){
                $filter=ConvertFrom-Yaml $step.with.filters -Ordered
                foreach($key in @($filter.Keys)){$filter[$key]=@($filter[$key])+@('qbrain/build/**','qbrain/verification/**')}
                $step.with.filters=$filter
            }
        }}
        # Independent selector path: original command and step ids bind the
        # contract fixtures; semantic outcomes are tested by Test-VscodeCiInline.
        foreach($job in $mock.jobs.Values){
            if($job.defaults.run.shell -ceq 'bash'){$job.defaults.run.shell='pwsh'}
            foreach($step in $job.steps){
                $key=switch -Regex ([string]$step.run){
                    '^echo "run_all=true"' {'Force';break}
                    '^echo ''matrix=' {'Matrix';break}
                    '^bun run build:sdk$' {'Sdk';break}
                    '^bun run download-ripgrep$' {'Ripgrep';break}
                    '^NODE_FILE=' {'Native';break}
                    '^set -o pipefail\nbun run test:vitest' {'Vitest';break}
                    '^set -o pipefail\nbun run test:unit' {'Unit';break}
                    '^bun run test:unit\s*$' {'UnitOther';break}
                    '^xvfb-run -a bun run test:coverage$' {'Coverage';break}
                    '^for attempt in 1 2 3' {'Retry';break}
                    '^cd webview-ui' {'Webview';break}
                    '^bun run test:tp-orchestrator' {'Platform';break}
                    '^sudo apt-get update' {'Xvfb';break}
                    '^if \[ "\$DETECT_CHANGES_RESULT"' {'Aggregate';break}
                    default {$null}
                }
                if($key){$step.run=$ciCommands[$key];$step.shell='pwsh'}
            }
        }
        $actualWorkflows[$name]=$mock
    }
}else{
    $actualManifest=Get-Content "$RepositoryRoot/apps/vscode/package.json" -Raw|ConvertFrom-Json -AsHashtable
    $actualWorkflows=@{}
    foreach($name in $expectations.Keys){
        $actual=Get-Content "$RepositoryRoot/.github/workflows/$name" -Raw|ConvertFrom-Yaml -Ordered
        foreach($job in $actual.jobs.Values){foreach($step in $job.steps){if($step.uses -eq 'dorny/paths-filter@v3'){$step.with.filters=ConvertFrom-Yaml $step.with.filters -Ordered}}}
        $actualWorkflows[$name]=$actual
    }
}
Assert-CiValue $expectedManifest $actualManifest;$checks++
foreach($name in $expectations.Keys){Assert-CiValue $expectations[$name] $actualWorkflows[$name] $name;$checks++}
$mutations=@(
    {param($c);$c.manifest.scripts['check-types']='bun run protos'},
    {param($c);$c.manifest.scripts.Remove('postprotos')},
    {param($c);$c.manifest.scripts['test:storage-startup']='extra'},
    {param($c);$c.manifest.name='claude-dev'},
    {param($c);$c.manifest.publisher='upstream'},
    {param($c);$c.workflows['ext-vscode-test.yml'].jobs.Remove('vscode-test')},
    {param($c);$c.workflows['ext-vscode-test.yml'].jobs['vscode-test'].if='false'},
    {param($c);$c.workflows['ext-vscode-test.yml'].jobs['vscode-test'].strategy.matrix.os=@('ubuntu-latest')},
    {param($c);$c.workflows['ext-vscode-test.yml'].jobs['vscode-test'].steps[0].uses='changed'},
    {param($c);$c.workflows['ext-vscode-test.yml'].jobs['test'].steps[0].run='exit 0'},
    {param($c);$c.workflows['ext-vscode-test.yml'].jobs.qlty.if='false'},
    {param($c);$c.workflows['ext-vscode-test-e2e.yml'].jobs['e2e'].if='false'}
)
foreach($mutation in $mutations){
    $wrongManifest=Copy-CiValue $expectedManifest;$wrongWorkflows=Copy-CiValue $expectations
    $null=& $mutation @{manifest=$wrongManifest;workflows=$wrongWorkflows}
    $rejected=$false
    try{Assert-CiValue $expectedManifest $wrongManifest;Assert-CiValue $expectations $wrongWorkflows}catch{$rejected=$true}
    if(-not $rejected){throw 'A configuration regression escaped assertions.'};$checks++;$negativeControls++
}
foreach($name in $expectations.Keys){foreach($jobKey in $expectations[$name].jobs.Keys){
    $steps=$expectations[$name].jobs[$jobKey].steps
    for($index=0;$index -lt $steps.Count;$index++){
        foreach($field in @($steps[$index].Keys)){
            $wrong=Copy-CiValue $expectations[$name]
            $wrong.jobs[$jobKey].steps[$index][$field]='removed-or-weakened'
            $rejected=$false;try{Assert-CiValue $expectations[$name] $wrong}catch{$rejected=$true}
            if(-not $rejected){throw "Step assertion did not reject $name/$jobKey/$index/$field"};$checks++;$negativeControls++
        }
    }
}}
$proof=@{timestamp=(Get-Date -Format s);mode=$Mode;requirement='TEST-QB-055';callers=$callerCount;installers=$installerCount;wrappers=$wrapperCount;filters=$filterCount;checks=$checks;negativeControls=$negativeControls;failed=0;skipped=0;testSha256=(Get-FileHash $PSCommandPath).Hash;commandsSha256=(Get-FileHash "$PSScriptRoot/VscodeCiCommands.psd1").Hash;phaseAccepted=$false}
$proof|ConvertTo-Json|Set-Content $ReceiptPath -Encoding utf8NoBOM
$proof|ConvertTo-Json
