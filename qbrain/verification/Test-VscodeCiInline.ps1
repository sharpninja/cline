# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory,[string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path)
$ErrorActionPreference='Stop'
Import-Module powershell-yaml
[void][IO.Directory]::CreateDirectory($ReceiptDirectory)
$base=@{DETECT_CHANGES_RESULT='success';QUALITY_CHECKS_RESULT='success';VSCODE_CHANGED='true';TESTING_PLATFORM_CHANGED='true';VSCODE_TEST_RESULT='success';TEST_PLATFORM_RESULT='success'}
$cases=[Collections.Generic.List[object]]::new()
$cases.Add(@{name='all-selected-pass';kind='Aggregate';env=$base.Clone();exit=0;message='Selected root test jobs passed.'})
foreach($key in @('DETECT_CHANGES_RESULT','QUALITY_CHECKS_RESULT','VSCODE_TEST_RESULT','TEST_PLATFORM_RESULT')){
    foreach($value in @('failure','cancelled','skipped','')){$values=$base.Clone();$values[$key]=$value;$cases.Add(@{name="$key-$value";kind='Aggregate';env=$values;exit=1;message='did not succeed'})}
}
foreach($flags in @(@('false','false'),@('false','true'),@('true','false'))){
    $values=$base.Clone();$values.VSCODE_CHANGED=$flags[0];$values.TESTING_PLATFORM_CHANGED=$flags[1]
    if($flags[0] -eq 'false'){$values.VSCODE_TEST_RESULT='failure'}
    if($flags[1] -eq 'false'){$values.TEST_PLATFORM_RESULT='failure'}
    $message='Selected root test jobs passed.'
    if($flags[0] -eq 'false' -and $flags[1] -eq 'false'){$values.QUALITY_CHECKS_RESULT='skipped';$message='No root test paths changed'}
    $cases.Add(@{name="selection-$($flags -join '-')";kind='Aggregate';env=$values;exit=0;message=$message})
}
$caseSensitive=$base.Clone();$caseSensitive.DETECT_CHANGES_RESULT='SUCCESS'
$cases.Add(@{name='case-sensitive-success';kind='Aggregate';env=$caseSensitive;exit=1;message='did not succeed'})
foreach($file in @('ext-vscode-test.yml','ext-vscode-test-e2e.yml')){$cases.Add(@{name="force-$file";kind='Force';workflow=$file;exit=0;message='';lines=@('existing=retained','run_all=true')})}
$cases.Add(@{name='matrix';kind='Matrix';exit=0;message='';matrix=@('ubuntu','windows','macos')})
$cases.Add(@{name='native-present';kind='Native';present=$true;exit=0;message='Found better-sqlite3 native binary'})
$cases.Add(@{name='native-absent';kind='Native';present=$false;exit=1;message='native binary missing'})
$hash=(Get-FileHash $PSCommandPath).Hash
if($Mode -eq 'Implementation'){
    $mock=Get-Content "$ReceiptDirectory/inline-Mock.json" -Raw|ConvertFrom-Json
    if($mock.failed -ne 0 -or $mock.skipped -ne 0 -or $mock.testSha256 -cne $hash){throw 'Matching mock gate required.'}
    $main=Get-Content "$RepositoryRoot/.github/workflows/ext-vscode-test.yml" -Raw|ConvertFrom-Yaml -Ordered
    $e2e=Get-Content "$RepositoryRoot/.github/workflows/ext-vscode-test-e2e.yml" -Raw|ConvertFrom-Yaml -Ordered
}
function Assert-Inline {param($Expected,$Actual);foreach($key in $Expected.Keys){if(($Expected[$key]|ConvertTo-Json -Depth 10 -Compress) -cne ($Actual[$key]|ConvertTo-Json -Depth 10 -Compress)){throw "Inline assertion failed: $key"}}}
$checks=0;$negative=0
foreach($case in $cases){
    $expected=@{exitCode=$case.exit;message=$true}
    if($case.kind -eq 'Force'){$expected.lines=$case.lines}
    if($case.kind -eq 'Matrix'){$expected.runners=$case.matrix;$expected.prefix='existing=retained';$expected.lines=2}
    if($Mode -eq 'Mock'){$actual=$expected.Clone()}
    else{
        $body=switch($case.kind){
            Aggregate {$main.jobs.test.steps[0].run}
            Force {if($case.workflow -eq 'ext-vscode-test.yml'){$main.jobs['detect-changes'].steps[0].run}else{$e2e.jobs['detect-changes'].steps[0].run}}
            Matrix {$e2e.jobs.matrix_prep.steps[0].run}
            Native {($main.jobs['quality-checks'].steps|Where-Object name -EQ 'Assert better-sqlite3 native binary present').run}
        }
        $fixture=Join-Path $ReceiptDirectory ($case.name+'-'+[Guid]::NewGuid().ToString('N'))
        [void][IO.Directory]::CreateDirectory($fixture)
        [IO.File]::WriteAllText("$fixture/command.ps1",$body)
        if(@(Invoke-ScriptAnalyzer -Path "$fixture/command.ps1" -Severity Warning,Error).Count){throw 'Inline script analyzer failure.'}
        [IO.File]::WriteAllText("$fixture/output.txt","existing=retained`n")
        if($case.present){[void][IO.Directory]::CreateDirectory("$fixture/node_modules/better-sqlite3/build/Release");[IO.File]::WriteAllText("$fixture/node_modules/better-sqlite3/build/Release/better_sqlite3.node",'fixture')}
        $info=[Diagnostics.ProcessStartInfo]::new((Get-Command pwsh -CommandType Application|Select-Object -First 1).Source)
        $info.UseShellExecute=$false;$info.WorkingDirectory=$fixture;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        $info.Environment['GITHUB_OUTPUT']="$fixture/output.txt"
        if($case.env){foreach($key in $case.env.Keys){$info.Environment[$key]=$case.env[$key]}}
        foreach($arg in @('-NoProfile','-NonInteractive','-File',"$fixture/command.ps1")){$info.ArgumentList.Add($arg)}
        $process=[Diagnostics.Process]::Start($info);$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
        $text=$stdout.GetAwaiter().GetResult();[IO.File]::WriteAllText("$fixture/stdout.txt",$text);[IO.File]::WriteAllText("$fixture/stderr.txt",$stderr.GetAwaiter().GetResult())
        $actual=@{exitCode=$process.ExitCode;message=$text.Contains([string]$case.message)}
        $lines=@(Get-Content "$fixture/output.txt")
        if($case.kind -eq 'Force'){$actual.lines=$lines}
        if($case.kind -eq 'Matrix'){$actual.prefix=$lines[0];$actual.lines=$lines.Count;$actual.runners=@(($lines[1].Substring('matrix='.Length)|ConvertFrom-Json).runner)}
        $process.Dispose()
    }
    Assert-Inline $expected $actual;$checks+=$expected.Count
    foreach($key in $expected.Keys){$wrong=$actual.Clone();$wrong[$key]='incorrect';$rejected=$false;try{Assert-Inline $expected $wrong}catch{$rejected=$true};if(-not $rejected){throw 'Inline negative control escaped.'};$checks++;$negative++}
}
$proof=@{timestamp=(Get-Date -Format s);mode=$Mode;requirement='TEST-QB-055';cases=$cases.Count;checks=$checks;negativeControls=$negative;failed=0;skipped=0;testSha256=$hash;phaseAccepted=$false}
$proof|ConvertTo-Json|Set-Content "$ReceiptDirectory/inline-$Mode.json" -Encoding utf8NoBOM
$proof|ConvertTo-Json
