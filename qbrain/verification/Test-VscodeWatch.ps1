# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory)
$ErrorActionPreference='Stop'
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Run $Mode native watch caller assertions")){return}
# These exact native scripts are pinned to the B0 package manifest. The owned
# caller must retain Bun's existing parallel orchestration and both watchers.
$scripts=@{watch='bun run --parallel watch:esbuild watch:tsc';'watch:esbuild'='bun esbuild.mjs --watch';'watch:tsc'='tsc --noEmit --watch --project tsconfig.json';dev='bun run protos && bun run watch'}
$expectedArguments=@('--shell=bun','run','--parallel','watch:esbuild','watch:tsc')
$cases=[Collections.Generic.List[object]]::new()
$cases.Add(@{name='baseline';scripts=$scripts;accept=$true})
$additional=$scripts.Clone();$additional['unrelated']='unknown-command'
$cases.Add(@{name='unrelated-script-inert';scripts=$additional;accept=$true})
foreach($key in @('watch','watch:esbuild','watch:tsc')){
    $missing=$scripts.Clone();$missing.Remove($key);$cases.Add(@{name="missing-$key";scripts=$missing;accept=$false})
    $wrong=$scripts.Clone();$wrong[$key]+=' && unexpected';$cases.Add(@{name="changed-$key";scripts=$wrong;accept=$false})
}
foreach($key in @('prewatch:esbuild','postwatch:esbuild','prewatch:tsc','postwatch:tsc')){
    $hook=$scripts.Clone();$hook[$key]='unexpected';$cases.Add(@{name="hook-$key";scripts=$hook;accept=$false})
}
function Test-WatchObservation {
    param([hashtable]$Observation,[bool]$Accept)
    if(-not $Accept){return $Observation.rejected -and @($Observation.arguments).Count -eq 0}
    return -not $Observation.rejected -and ($Observation.arguments|ConvertTo-Json -Compress -AsArray) -ceq ($expectedArguments|ConvertTo-Json -Compress -AsArray)
}
$failures=[Collections.Generic.List[string]]::new();$checks=0;$negative=0
function Assert-Watch {
    param([bool]$Actual,[bool]$Expected,[string]$Label)
    $script:checks++;if($Actual -ne $Expected){$script:failures.Add($Label)}
}
foreach($case in $cases){
    $good=@{rejected=(-not $case.accept);arguments=$(if($case.accept){$expectedArguments}else{@()})}
    Assert-Watch (Test-WatchObservation $good $case.accept) $true "$($case.name)/correct"
    $bad=@{rejected=$case.accept;arguments=$(if($case.accept){@()}else{$expectedArguments})}
    $negative++;Assert-Watch (Test-WatchObservation $bad $case.accept) $false "$($case.name)/wrong-disposition"
}
foreach($arguments in @(@('--shell=bun','run','watch'),@('--shell=bun','run','--parallel','watch:esbuild'),@('run','--parallel','watch:esbuild','watch:tsc'),@('--shell=bun','run','--parallel','watch:tsc','watch:esbuild'),@('run','dev'))){
    $negative++;Assert-Watch (Test-WatchObservation @{rejected=$false;arguments=$arguments} $true) $false 'changed-native-command'
}
$hash=(Get-FileHash $PSCommandPath).Hash
if($Mode -eq 'Implementation'){
    $gate=Get-Content "$ReceiptDirectory/watch-mock.json" -Raw|ConvertFrom-Json
    if($gate.failed -ne 0 -or $gate.skipped -ne 0 -or $gate.testSha256 -cne $hash -or $gate.checks -ne $checks -or $gate.negativeControls -ne $negative){throw 'Unchanged successful mock gate required.'}
    Import-Module "$PSScriptRoot/../build/VscodeBuild.psm1" -Force
    foreach($case in $cases){
        $observation=@{rejected=$false;arguments=@()}
        try{$observation.arguments=@(Get-QbrainVscodeWatchArguments -Scripts $case.scripts)}catch{$observation.rejected=$true}
        Assert-Watch (Test-WatchObservation $observation $case.accept) $true "$($case.name)/implementation"
    }
}
$result=@{timestamp=(Get-Date -Format s);mode=$Mode;cases=$cases.Count;checks=$checks;negativeControls=$negative;failed=$failures.Count;failures=@($failures.ToArray());skipped=0;testSha256=$hash;scope='Native watch caller argv and manifest-drift refusal; live child behavior is separate evidence.'}
$result|ConvertTo-Json -Depth 10|Set-Content "$ReceiptDirectory/watch-$($Mode.ToLowerInvariant()).json" -Encoding utf8NoBOM
$result|ConvertTo-Json -Depth 10
if($failures.Count){throw 'Watch caller assertions failed.'}
