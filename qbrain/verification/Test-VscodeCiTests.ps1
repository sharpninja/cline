# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
    [ValidateSet('Mock','Implementation')][string]$Mode='Mock',
    [Parameter(Mandatory)][string]$ReceiptDirectory,
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path
)
$ErrorActionPreference='Stop'
[void][IO.Directory]::CreateDirectory($ReceiptDirectory)
$cases=@(
    @{name='vitest-nonzero';policy='Vitest';codes=@(0);texts=@('Tests 12 passed');exit=0;calls=1},
    @{name='vitest-colored';policy='Vitest';codes=@(0);texts=@("`e[32mTests`e[0m `e[32m2 passed`e[0m");exit=0;calls=1},
    @{name='vitest-zero';policy='Vitest';codes=@(0);texts=@('Tests 0 passed');exit=1;calls=1},
    @{name='vitest-zero-padding';policy='Vitest';codes=@(0);texts=@('Tests 000 passed');exit=1;calls=1},
    @{name='vitest-empty';policy='Vitest';codes=@(0);texts=@('');exit=1;calls=1},
    @{name='vitest-malformed';policy='Vitest';codes=@(0);texts=@('Tests many passed');exit=1;calls=1},
    @{name='vitest-negative';policy='Vitest';codes=@(0);texts=@('Tests -2 passed');exit=1;calls=1},
    @{name='vitest-failed-process';policy='Vitest';codes=@(17);texts=@('Tests 2 passed');exit=17;calls=1},
    @{name='vitest-failed-summary';policy='Vitest';codes=@(7);texts=@('Tests 2 failed');exit=7;calls=1},
    @{name='vitest-original-failed-word';policy='Vitest';codes=@(0);texts=@('Tests 2 failed');exit=0;calls=1},
    @{name='unit-nonzero';policy='Unit';codes=@(0);texts=@('Pass: 12');exit=0;calls=1},
    @{name='unit-zero';policy='Unit';codes=@(0);texts=@('Pass: 0');exit=1;calls=1},
    @{name='unit-zero-padding';policy='Unit';codes=@(0);texts=@('Pass: 000');exit=1;calls=1},
    @{name='unit-empty';policy='Unit';codes=@(0);texts=@('');exit=1;calls=1},
    @{name='unit-malformed';policy='Unit';codes=@(0);texts=@('Pass: unknown');exit=1;calls=1},
    @{name='unit-failed-process';policy='Unit';codes=@(23);texts=@('Pass: 9');exit=23;calls=1},
    @{name='retry-first';policy='IntegrationRetry';codes=@(0);texts=@('ok');exit=0;calls=1},
    @{name='retry-second';policy='IntegrationRetry';codes=@(4,0);texts=@('fail','ok');exit=0;calls=2},
    @{name='retry-third';policy='IntegrationRetry';codes=@(4,9,0);texts=@('fail','fail','ok');exit=0;calls=3},
    @{name='retry-exhausted';policy='IntegrationRetry';codes=@(4,9,27);texts=@('fail','fail','fail');exit=1;calls=3},
    @{name='exception-guard';policy='Vitest';codes=@(0);texts=@('Tests 2 passed');exception=$true;exit=1;calls=1},
    @{name='exception-retries';policy='IntegrationRetry';codes=@(0,0,0);texts=@('','','');exception=$true;exit=1;calls=3},
    @{name='null-result';policy='Unit';codes=@(0);texts=@('Pass: 3');nullResult=$true;exit=1;calls=1},
    @{name='missing-exit';policy='Unit';codes=@(0);texts=@('Pass: 3');missingExit=$true;exit=1;calls=1}
)
$testHash=(Get-FileHash $PSCommandPath).Hash
if($Mode -eq 'Implementation'){
    $mock=Get-Content "$ReceiptDirectory/ci-tests-Mock.json" -Raw|ConvertFrom-Json
    if($mock.failed -ne 0 -or $mock.skipped -ne 0 -or $mock.testSha256 -cne $testHash){throw 'Matching green mock gate required.'}
    Import-Module "$RepositoryRoot/qbrain/build/VscodeCiTests.psm1" -Force
}
$checks=0;$negativeControls=0
function Assert-CiOutcome {
    param($Expected,$Actual)
    foreach($key in $Expected.Keys){
        if(($Expected[$key]|ConvertTo-Json -Depth 20 -Compress) -cne ($Actual[$key]|ConvertTo-Json -Depth 20 -Compress)){throw "CI assertion failed: $key"}
    }
}
foreach($case in $cases){
    $reason=if($case.exit -eq 0){$null}elseif($case.policy -eq 'IntegrationRetry'){'Extension integration tests failed after 3 attempts'}elseif($case.exception -or $case.nullResult -or $case.missingExit){'Test command did not return a valid result.'}elseif($case.codes[0] -ne 0){"Test command failed with exit code $($case.codes[0])."}elseif($case.policy -eq 'Vitest'){'ERROR: vitest reported zero tests (possible silent skip).'}else{'ERROR: bun unit runner reported zero passing tests (possible silent skip).'}
    $calls=[Collections.Generic.List[object]]::new();$delays=[Collections.Generic.List[int]]::new()
    $run={param($attempt)
        $calls.Add($attempt)
        if($case.exception){throw 'Scripted native failure'}
        if($case.nullResult){return $null}
        if($case.missingExit){return @{output=$case.texts[$attempt-1]}}
        return @{exitCode=[int]$case.codes[$attempt-1];output=[string]$case.texts[$attempt-1]}
    }.GetNewClosure()
    $wait={param($seconds);$delays.Add($seconds)}.GetNewClosure()
    if($Mode -eq 'Mock'){
        # Scripted contract trace, independent of the production decision logic.
        for($attempt=1;$attempt -le $case.calls;$attempt++){
            try{$null=& $run $attempt}catch{if(-not $case.exception){throw}}
            if($attempt -lt $case.calls){& $wait 5}
        }
        $result=@{exitCode=$case.exit;attempts=$case.calls;failureReason=$reason}
    }else{$result=Invoke-QbrainVscodeCiTest -Policy $case.policy -RunAttempt $run -WaitBetweenAttempts $wait}
    $expected=@{exitCode=[int]$case.exit;attempts=[int]$case.calls;calls=@(1..$case.calls);delays=@(for($i=1;$i -lt $case.calls;$i++){5});failureReason=$reason}
    $actual=@{exitCode=[int]$result.exitCode;attempts=[int]$result.attempts;calls=@($calls.ToArray());delays=@($delays.ToArray());failureReason=$result.failureReason}
    Assert-CiOutcome $expected $actual;$checks+=5
    foreach($key in $expected.Keys){
        $wrong=$actual.Clone()
        $wrong[$key]=if($key -in @('calls','delays')){@(-999)}else{-999}
        $rejected=$false;try{Assert-CiOutcome $expected $wrong}catch{$rejected=$true}
        if(-not $rejected){throw "Mutation escaped: $($case.name)/$key"};$checks++;$negativeControls++
    }
}
$proof=@{timestamp=(Get-Date -Format s);mode=$Mode;requirement='TEST-QB-055';cases=$cases.Count;checks=$checks;negativeControls=$negativeControls;failed=0;skipped=0;testSha256=$testHash;phaseAccepted=$false}
$proof|ConvertTo-Json|Set-Content "$ReceiptDirectory/ci-tests-$Mode.json" -Encoding utf8NoBOM
$proof|ConvertTo-Json
