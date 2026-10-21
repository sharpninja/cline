# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory)
$ErrorActionPreference='Stop'
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Run $Mode command graph and failure-propagation assertions")){return}
# Expected commands are pinned to the reviewed B0 manifests, with generation separated
# per TEST-QB-011/055. This contract is independent of the implementation module.
$definitions=@{
    watch=@('pwsh','apps/vscode','../../qbrain/build/Watch-Vscode.ps1')
    generatedFormat=@('node','apps/vscode','node_modules/@biomejs/biome/bin/biome','format','--config-path','./biome.jsonc','src/shared/proto','src/core/controller','src/hosts/','webview-ui/src/services','src/generated','--write','--no-errors-on-unmatched')
    format=@('node','apps/vscode','node_modules/@biomejs/biome/bin/biome','format','--config-path','./biome.jsonc','--changed','--since','main','--no-errors-on-unmatched','--files-ignore-unknown=true','--diagnostic-level=error','--semicolons=as-needed')
    storageBootstrap=@('node','apps/vscode','scripts/verify-storage-bootstrap.cjs','dist/extension.js','dist-standalone/cline-core.js')
    storageActivation=@('node','apps/vscode','scripts/verify-vscode-storage-activation.cjs')
    storageWebview=@('node','apps/vscode','scripts/verify-webview-isolation.cjs')
    vitest=@('node','apps/vscode','node_modules/vitest/vitest.mjs','run','--config','vitest.config.ts')
    unit=@('bun','apps/vscode','scripts/run-bun-unit-tests.ts')
    bunTests=@('bun','apps/vscode','scripts/run-bun-tests.ts')
    integration=@('node','apps/vscode','node_modules/@vscode/test-cli/out/bin.mjs')
    coverage=@('node','apps/vscode','node_modules/@vscode/test-cli/out/bin.mjs','--coverage')
    webviewTests=@('node','apps/vscode/webview-ui','node_modules/vitest/vitest.mjs','run')
    webviewCoverage=@('node','apps/vscode/webview-ui','node_modules/vitest/vitest.mjs','run','--coverage')
    platformTests=@('bun','apps/vscode','scripts/testing-platform-orchestrator.ts','tests/specs/','--count=1','--coverage')
    generate=@('node','apps/vscode','scripts/build-proto.mjs')
    types=@('node','apps/vscode','node_modules/typescript/bin/tsc','--noEmit')
    compatibility=@('node','apps/vscode','node_modules/typescript/bin/tsc','--project','tsconfig.vscode-compat.json','--noEmit')
    webviewTypes=@('node','apps/vscode/webview-ui','node_modules/typescript/bin/tsc','--noEmit')
    biome=@('node','apps/vscode','node_modules/@biomejs/biome/bin/biome','lint','--config-path','./biome.jsonc','--no-errors-on-unmatched','--files-ignore-unknown=true','--diagnostic-level=error')
    protoLint=@('pwsh','apps/vscode','scripts/proto-lint.ps1')
    webviewBuildTypes=@('node','apps/vscode/webview-ui','node_modules/typescript/bin/tsc','-b')
    vite=@('node','apps/vscode/webview-ui','node_modules/vite/bin/vite.js','build')
    extension=@('bun','apps/vscode','esbuild.mjs')
    production=@('bun','apps/vscode','esbuild.mjs','--production')
    standalone=@('bun','apps/vscode','esbuild.mjs','--standalone')
    standalonePackage=@('node','apps/vscode','scripts/qbrain/package-standalone.mjs')
    mocha=@('node','apps/vscode','scripts/build-tests.js')
    e2eDependencies=@('node','apps/vscode','scripts/qbrain/prepare-e2e.mjs')
    playwright=@('node','apps/vscode','node_modules/@playwright/test/cli.js','test')
}
$contracts=[ordered]@{
    dev=@('watch')
    watch=@('watch')
    'format:generated'=@('generatedFormat')
    format=@('format')
    'ci:check-all'=@('types','compatibility','webviewTypes','biome','protoLint','format')
    'test:storage-startup'=@('extension','standalone','storageBootstrap','storageActivation')
    'test:storage-webview'=@('storageWebview')
    'test:vitest'=@('vitest')
    'test:unit'=@('unit')
    'test:bun'=@('bunTests')
    'test:integration'=@('mocha','integration')
    'test:coverage'=@('mocha','coverage')
    'test:webview'=@('webviewTests')
    'test:webview:coverage'=@('webviewCoverage')
    'test:tp-orchestrator'=@('platformTests')
    prepare=@('generate')
    'check-types'=@('types','compatibility','webviewTypes')
    lint=@('biome','protoLint')
    'build:webview'=@('webviewBuildTypes','vite')
    extension=@('extension')
    compile=@('types','compatibility','webviewTypes','biome','protoLint','extension')
    'compile-standalone'=@('types','compatibility','webviewTypes','biome','protoLint','standalone','standalonePackage')
    'compile-tests'=@('mocha')
    'build:production'=@('webviewBuildTypes','vite','production')
    package=@('types','compatibility','webviewTypes','biome','protoLint','webviewBuildTypes','vite','production')
    'ci:build'=@('webviewBuildTypes','vite','extension','mocha')
    'test:e2e'=@('webviewBuildTypes','vite','production','e2eDependencies','playwright')
}
function Get-ExpectedGraph {
    param([string]$Task)
    return @($contracts[$Task]|ForEach-Object {
        $row=$definitions[$_]
        [ordered]@{id=$_;runtime=$row[0];cwd=$row[1];entry=$row[2];arguments=@($row|Select-Object -Skip 3)}
    })
}
function Test-CommandGraph {
    param([object[]]$Actual,[object[]]$Expected)
    if($Actual.Count -ne $Expected.Count){return $false}
    for($i=0;$i -lt $Expected.Count;$i++){
        foreach($field in @('id','runtime','cwd','entry')){if($Actual[$i][$field] -cne $Expected[$i][$field]){return $false}}
        if(($Actual[$i].arguments|ConvertTo-Json -Compress -AsArray) -cne ($Expected[$i].arguments|ConvertTo-Json -Compress -AsArray)){return $false}
    }
    return $true
}
function Test-ExecutionObservation {
    param([hashtable]$Actual,[int]$Total,[int]$FailAt)
    $expectedCount=if($FailAt -ge 0){$FailAt+1}else{$Total}
    $expectedCode=if($FailAt -ge 0){17}else{0}
    return $Actual.exitCode -eq $expectedCode -and $Actual.steps.Count -eq $expectedCount -and (($Actual.steps|ConvertTo-Json -Compress -AsArray) -ceq (@(0..($expectedCount-1))|ConvertTo-Json -Compress -AsArray))
}
$count=0;$negative=0;$failures=[Collections.Generic.List[string]]::new()
function Assert-Contract {
    param([bool]$Actual,[bool]$Expected,[string]$Label)
    $script:count++
    if($Actual -ne $Expected){$script:failures.Add($Label)}
}
foreach($task in $contracts.Keys){
    $expected=@(Get-ExpectedGraph $task)
    $correct=@($expected|ConvertTo-Json -Depth 10 -AsArray|ConvertFrom-Json -AsHashtable)
    Assert-Contract (Test-CommandGraph $correct $expected) $true "$task/correct"
    foreach($mutation in @('omit','writer','runtime','directory','entry','arguments','identity','order','extra')){
        $bad=@($correct|ConvertTo-Json -Depth 10 -AsArray|ConvertFrom-Json -AsHashtable)
        switch($mutation){
            omit {$bad=@($bad|Select-Object -Skip 1)}
            writer {$bad[0].entry='scripts/build-proto.mjs';$bad[0].arguments=@('--write')}
            runtime {$bad[0].runtime='npm'}
            directory {$bad[0].cwd='../outside'}
            entry {$bad[0].entry='package.json'}
            arguments {$bad[0].arguments=@('incorrect combined argument')}
            identity {$bad[0].id='unattributed-step'}
            order {if($bad.Count -gt 1){[array]::Reverse($bad)}else{$bad[0].id='wrong-order'}}
            extra {$bad+=@{id='hidden-postprotos';runtime='bun';cwd='apps/vscode';entry='run';arguments=@('postprotos')}}
        }
        $negative++;Assert-Contract (Test-CommandGraph $bad $expected) $false "$task/$mutation"
    }
    foreach($failAt in @(-1)+@(0..($expected.Count-1))){
        $length=if($failAt -ge 0){$failAt+1}else{$expected.Count}
        $correctRun=@{exitCode=$(if($failAt -ge 0){17}else{0});steps=@(0..($length-1))}
        Assert-Contract (Test-ExecutionObservation $correctRun $expected.Count $failAt) $true "$task/run-$failAt"
        $badRun=@{exitCode=$(if($correctRun.exitCode -eq 0){17}else{0});steps=$correctRun.steps}
        $negative++;Assert-Contract (Test-ExecutionObservation $badRun $expected.Count $failAt) $false "$task/wrong-exit-$failAt"
        $badRun=@{exitCode=$correctRun.exitCode;steps=@($correctRun.steps)+99}
        $negative++;Assert-Contract (Test-ExecutionObservation $badRun $expected.Count $failAt) $false "$task/extra-step-$failAt"
    }
}
function Test-RuntimeSelection {
    param([string]$Actual,[string]$Expected)
    return $Actual -ceq $Expected
}
$runtimeCases=@(
    @{name='one';candidates=@(@{Source='/tools/node'});expected='/tools/node'},
    @{name='multiple';candidates=@(@{Source='/tools/node'},@{Source='/usr/bin/node'});expected='/tools/node'},
    @{name='spaces';candidates=@(@{Source='/tools with spaces/node'},@{Source='/usr/bin/node'});expected='/tools with spaces/node'}
)
foreach($case in $runtimeCases){
    Assert-Contract (Test-RuntimeSelection $case.expected $case.expected) $true "runtime/$($case.name)/correct"
    foreach($bad in @('',($case.expected+' /other/node'),'/wrong/node')){
        $negative++;Assert-Contract (Test-RuntimeSelection $bad $case.expected) $false "runtime/$($case.name)/negative"
    }
}
$fixtureRoot=Join-Path ([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($PSScriptRoot))) 'qb build fixture'
$inherited=Join-Path ([IO.Path]::GetPathRoot($fixtureRoot)) 'system-tools'
$separator=[IO.Path]::PathSeparator
$pathCases=@(
    @{name='root';cwd=$fixtureRoot;inherited=$inherited;expected=(@((Join-Path $fixtureRoot 'node_modules/.bin'),$inherited)-join $separator)},
    @{name='nested';cwd=(Join-Path $fixtureRoot 'apps/vscode/webview-ui');inherited=$inherited;expected=(@((Join-Path $fixtureRoot 'apps/vscode/webview-ui/node_modules/.bin'),(Join-Path $fixtureRoot 'apps/vscode/node_modules/.bin'),(Join-Path $fixtureRoot 'apps/node_modules/.bin'),(Join-Path $fixtureRoot 'node_modules/.bin'),$inherited)-join $separator)},
    @{name='empty-inherited';cwd=(Join-Path $fixtureRoot 'apps/vscode');inherited='';expected=(@((Join-Path $fixtureRoot 'apps/vscode/node_modules/.bin'),(Join-Path $fixtureRoot 'apps/node_modules/.bin'),(Join-Path $fixtureRoot 'node_modules/.bin'))-join $separator)}
)
foreach($case in $pathCases){
    Assert-Contract (Test-RuntimeSelection $case.expected $case.expected) $true "path/$($case.name)/correct"
    foreach($bad in @($case.inherited,($case.expected+$separator),('outside'+$separator+$case.expected))){
        $negative++;Assert-Contract (Test-RuntimeSelection $bad $case.expected) $false "path/$($case.name)/negative"
    }
}
$hash=(Get-FileHash $PSCommandPath).Hash
$mockChecks=$count;$mockNegative=$negative
if($Mode -eq 'Implementation'){
    $gate=Get-Content "$ReceiptDirectory/vscode-graph-mock.json" -Raw|ConvertFrom-Json
    if($gate.failed -ne 0 -or $gate.testSha256 -cne $hash -or $gate.checks -ne $mockChecks -or $gate.negativeControls -ne $mockNegative){throw 'Unchanged passing mock gate required.'}
    Import-Module "$PSScriptRoot/../build/VscodeBuild.psm1" -Force
    foreach($case in $pathCases){
        $actual=Get-QbrainBuildSearchPath -RepositoryRoot $fixtureRoot -WorkingDirectory $case.cwd -InheritedPath $case.inherited
        Assert-Contract (Test-RuntimeSelection $actual $case.expected) $true "path/$($case.name)/implementation"
    }
    $rejected=$false
    try{$null=Get-QbrainBuildSearchPath -RepositoryRoot $fixtureRoot -WorkingDirectory (Join-Path $fixtureRoot '../outside') -InheritedPath $inherited}catch{$rejected=$true}
    Assert-Contract $rejected $true 'outside-build-directory-refused'
    foreach($case in $runtimeCases){
        $actual=Get-QbrainBuildRuntimePath -Candidates $case.candidates
        Assert-Contract (Test-RuntimeSelection $actual $case.expected) $true "runtime/$($case.name)/implementation"
    }
    foreach($invalid in @(@(),@(@{Source=''}),@(@{Source=@('/one/node','/two/node')}))){
        $rejected=$false
        try{$null=Get-QbrainBuildRuntimePath -Candidates $invalid}catch{$rejected=$true}
        Assert-Contract $rejected $true 'invalid-runtime-candidates-refused'
    }
    foreach($task in $contracts.Keys){
        $expected=@(Get-ExpectedGraph $task)
        $actual=@(Get-QbrainVscodeBuildStep -Task $task)
        Assert-Contract (Test-CommandGraph $actual $expected) $true "$task/actual-graph"
        foreach($failAt in @(-1)+@(0..($expected.Count-1))){
            $state=@{steps=[Collections.Generic.List[int]]::new();failAt=$failAt}
            $runner={param($step,$index) $null=$step;$state.steps.Add($index);if($index -eq $state.failAt){return 17};return 0}.GetNewClosure()
            $result=Invoke-QbrainVscodeBuildGraph -Steps $actual -RunStep $runner
            $observed=@{exitCode=$result.exitCode;steps=@($state.steps.ToArray())}
            Assert-Contract (Test-ExecutionObservation $observed $expected.Count $failAt) $true "$task/actual-run-$failAt"
        }
    }
    $rejected=$false
    try{$null=Get-QbrainVscodeBuildStep -Task 'unknown-task'}catch{$rejected=$true}
    Assert-Contract $rejected $true 'unknown-task-refused'
}
$result=@{timestamp=(Get-Date -Format s);mode=$Mode;tasks=$contracts.Count;checks=$count;negativeControls=$negative;failed=$failures.Count;failures=@($failures.ToArray());skipped=0;testSha256=$hash;scope='Command graph and fail-stop orchestration. Real tool execution is separate evidence.'}
$result|ConvertTo-Json -Depth 10|Set-Content "$ReceiptDirectory/vscode-graph-$($Mode.ToLowerInvariant()).json" -Encoding utf8NoBOM
$result|ConvertTo-Json -Depth 10
if($failures.Count){throw 'Command-graph assertions failed.'}
