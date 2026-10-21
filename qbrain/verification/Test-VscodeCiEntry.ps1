# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory,[string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path)
$ErrorActionPreference='Stop'
[void][IO.Directory]::CreateDirectory($ReceiptDirectory)
$cases=@(
    @{name='stderr-summary';policy='Vitest';codes=@(0);stdout=@('header');stderr=@('Tests 2 passed');exit=0;calls=1},
    @{name='zero-unit';policy='Unit';codes=@(0);stdout=@('Pass: 0');stderr=@('');exit=1;calls=1},
    @{name='native-failure';policy='Vitest';codes=@(17);stdout=@('Tests 2 passed');stderr=@('native failed');exit=17;calls=1},
    @{name='second-attempt';policy='IntegrationRetry';codes=@(9,0);stdout=@('fail','ok');stderr=@('first','second');exit=0;calls=2},
    @{name='all-attempts-fail';policy='IntegrationRetry';codes=@(3,7,9);stdout=@('one','two','three');stderr=@('','','');exit=1;calls=3},
    @{name='missing-receipt';policy='Vitest';codes=@(0);stdout=@('Tests 3 passed');stderr=@('');missing=$true;exit=1;calls=1},
    @{name='receipt-failure';policy='Vitest';codes=@(0);stdout=@('Tests 3 passed');stderr=@('');receiptExit=4;exit=1;calls=1}
)
$hash=(Get-FileHash $PSCommandPath).Hash
if($Mode -eq 'Implementation'){$gate=Get-Content "$ReceiptDirectory/entry-Mock.json" -Raw|ConvertFrom-Json;if($gate.failed -ne 0 -or $gate.skipped -ne 0 -or $gate.testSha256 -cne $hash){throw 'Matching mock gate required.'}}
function Assert-Entry {param($Expected,$Actual);foreach($key in $Expected.Keys){if(($Expected[$key]|ConvertTo-Json -Depth 20 -Compress) -cne ($Actual[$key]|ConvertTo-Json -Depth 20 -Compress)){throw "Entry assertion: $key"}}}
$checks=0;$negative=0
foreach($case in $cases){
    $task=switch($case.policy){Vitest{'test:vitest'};Unit{'test:unit'};IntegrationRetry{'test:integration'}}
    $expected=@{exitCode=$case.exit;attempts=$case.calls;tasks=@(1..$case.calls|ForEach-Object {$task});outputPresent=(-not $case.missing -and -not $case.receiptExit);receipt=$true}
    if($Mode -eq 'Mock'){$actual=@{exitCode=$case.exit;attempts=$case.calls;tasks=@(1..$case.calls|ForEach-Object {$task});outputPresent=(-not $case.missing -and -not $case.receiptExit);receipt=$true}}
    else{
        $fixture=Join-Path $ReceiptDirectory ($case.name+'-'+[Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory("$fixture/qbrain/build")
        $case|ConvertTo-Json -Depth 10|Set-Content "$fixture/case.json" -Encoding utf8NoBOM
        $fake=@'
# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([string]$Task,[string]$RepositoryRoot,[string]$ReceiptDirectory)
$ErrorActionPreference='Stop'
$case=Get-Content "$RepositoryRoot/case.json" -Raw|ConvertFrom-Json
$index=[int]([IO.Path]::GetFileName($ReceiptDirectory).Split('-')[-1])-1
Add-Content "$RepositoryRoot/tasks.txt" $Task
if($case.missing){exit 0}
[void][IO.Directory]::CreateDirectory($ReceiptDirectory)
[IO.File]::WriteAllText("$ReceiptDirectory/stdout.txt",[string]$case.stdout[$index])
[IO.File]::WriteAllText("$ReceiptDirectory/stderr.txt",[string]$case.stderr[$index])
$code=if($case.receiptExit){$case.receiptExit}else{$case.codes[$index]}
@{exitCode=$code;records=@(@{stdout="$ReceiptDirectory/stdout.txt";stderr="$ReceiptDirectory/stderr.txt"})}|ConvertTo-Json -Depth 5|Set-Content "$ReceiptDirectory/result.json"
exit [int]$case.codes[$index]
'@
        $fakePath="$fixture/qbrain/build/Invoke-VscodeBuild.ps1"
        [IO.File]::WriteAllText($fakePath,$fake)
        $issues=@(Invoke-ScriptAnalyzer -Path $fakePath -Severity Warning,Error)
        if($issues.Count){throw 'Fixture analyzer failure.'}
        $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh -CommandType Application|Select-Object -First 1).Source)
        $info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        foreach($arg in @('-NoProfile','-NonInteractive','-File',"$RepositoryRoot/qbrain/build/Invoke-VscodeCiTests.ps1",'-Policy',$case.policy,'-RepositoryRoot',$fixture,'-ReceiptDirectory',"$fixture/proof")){$info.ArgumentList.Add($arg)}
        $process=[Diagnostics.Process]::Start($info);$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
        [IO.File]::WriteAllText("$fixture/entry.stdout.txt",$stdout.GetAwaiter().GetResult());[IO.File]::WriteAllText("$fixture/entry.stderr.txt",$stderr.GetAwaiter().GetResult())
        if(-not (Test-Path "$fixture/proof/result.json")){throw "Missing entry proof: $fixture"}
        $proof=Get-Content "$fixture/proof/result.json" -Raw|ConvertFrom-Json
        $text=[IO.File]::ReadAllText("$fixture/proof/output.log")
        $contains=($text.Contains([string]$case.stdout[0]) -and $text.Contains([string]$case.stderr[0]))
        if($case.missing -or $case.receiptExit){$contains=($text.Length -gt 0)}
        $actual=@{exitCode=$process.ExitCode;attempts=$proof.attempts;tasks=@(Get-Content "$fixture/tasks.txt");outputPresent=$contains;receipt=($proof.exitCode -eq $process.ExitCode)}
        $process.Dispose()
    }
    Assert-Entry $expected $actual;$checks+=5
    foreach($key in $expected.Keys){$wrong=$actual.Clone();$wrong[$key]='incorrect';$rejected=$false;try{Assert-Entry $expected $wrong}catch{$rejected=$true};if(-not $rejected){throw "Mutation escaped: $key"};$checks++;$negative++}
}
$proof=@{timestamp=(Get-Date -Format s);mode=$Mode;requirement='TEST-QB-055';cases=$cases.Count;checks=$checks;negativeControls=$negative;failed=0;skipped=0;testSha256=$hash;phaseAccepted=$false}
$proof|ConvertTo-Json|Set-Content "$ReceiptDirectory/entry-$Mode.json" -Encoding utf8NoBOM
$proof|ConvertTo-Json
