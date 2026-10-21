# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory)
$ErrorActionPreference='Stop'
$root=(Resolve-Path "$PSScriptRoot/../..").Path
$node=@(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
$fixtureNames=@('e2e-electron.mjs','e2e-execa.mjs','e2e-deadline.cjs')
$hashes=@{test=(Get-FileHash $PSCommandPath).Hash}
foreach($name in $fixtureNames){$hashes[$name]=(Get-FileHash "$PSScriptRoot/fixtures/$name").Hash}
$directory=Join-Path $ReceiptDirectory $Mode.ToLowerInvariant()
if(Test-Path $directory){throw 'Use a new receipt directory and retain prior runs.'}
if($Mode -eq 'Implementation'){
    $mock=Get-Content "$ReceiptDirectory/mock/result.json" -Raw|ConvertFrom-Json
    if($mock.failed -ne 0 -or $mock.skipped -ne 0 -or $mock.negativeControls -ne 8){throw 'Complete passing mock gate required.'}
    foreach($key in $hashes.Keys){if($mock.hashes.$key -cne $hashes[$key]){throw 'Mock assertions or fixture hashes changed.'}}
}
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Run $Mode native Node e2e preparation contract with synthetic dependencies")){return}
$correct=@'
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron";
import { execa } from "execa";
const deadline = new Promise((_, reject) => setTimeout(() => reject(new Error("Installation timed out.")), 300000));
try {
  await Promise.race([Promise.all([
    downloadAndUnzipVSCode("stable", undefined, new SilentReporter()),
    execa("bun", ["x", "playwright", "install", "ffmpeg"], { stdio: "inherit" })
  ]), deadline]);
  console.log("Installation complete.");
  process.exit(0);
} catch (error) { console.error(error); process.exit(1); }
'@
$cases=@()
foreach($scenario in @('success','download','installer','timeout')){
    $cases+=@{name=$scenario;scenario=$scenario;source=$correct;reject=$null}
}
if($Mode -eq 'Mock'){
    $mutations=@(
        @{name='prohibited-manager';old='execa("bun",';new='execa("npm",';reject='installer-command'},
        @{name='wrong-arguments';old='"ffmpeg"';new='"chromium"';reject='installer-arguments'},
        @{name='wrong-download';old='"stable"';new='"insiders"';reject='download-selection'},
        @{name='missing-download';old='downloadAndUnzipVSCode("stable", undefined, new SilentReporter())';new='Promise.resolve("omitted")';reject='download-count'},
        @{name='wrong-reporter';old='new SilentReporter()';new='{}';reject='download-selection'},
        @{name='wrong-stdio';old='stdio: "inherit"';new='stdio: "pipe"';reject='installer-stdio'},
        @{name='wrong-deadline';old='300000';new='120000';reject='deadline'},
        @{name='swallowed-failure';old='process.exit(1)';new='process.exit(0)';reject='exit-code';scenario='installer'}
    )
    foreach($mutation in $mutations){
        if([regex]::Matches($correct,[regex]::Escape($mutation.old)).Count -ne 1){throw 'Ambiguous mock mutation.'}
        $scenario=if($mutation.scenario){$mutation.scenario}else{'success'}
        $cases+=@{name=$mutation.name;scenario=$scenario;source=$correct.Replace($mutation.old,$mutation.new);reject=$mutation.reject}
    }
}
$implementation="$root/apps/vscode/scripts/qbrain/prepare-e2e.mjs"
$records=@();$failures=[Collections.Generic.List[string]]::new();$negatives=0
foreach($case in $cases){
    $caseDirectory=Join-Path $directory $case.name
    [void][IO.Directory]::CreateDirectory($caseDirectory)
    foreach($definition in @(@{name='@vscode/test-electron';fixture='e2e-electron.mjs'},@{name='execa';fixture='e2e-execa.mjs'})){
        $package=Join-Path "$caseDirectory/node_modules" $definition.name
        [void][IO.Directory]::CreateDirectory($package)
        @{name=$definition.name;type='module';exports='./index.mjs'}|ConvertTo-Json|Set-Content "$package/package.json" -Encoding utf8NoBOM
        [IO.File]::Copy("$PSScriptRoot/fixtures/$($definition.fixture)","$package/index.mjs",$false)
        if((Get-FileHash "$package/index.mjs").Hash -cne $hashes[$definition.fixture]){throw 'Dependency fixture copy differs.'}
    }
    $program="$caseDirectory/build.mjs"
    if($Mode -eq 'Implementation'){
        [IO.File]::Copy($implementation,$program,$false)
        if((Get-FileHash $program).Hash -cne (Get-FileHash $implementation).Hash){throw 'Native program copy differs.'}
    }else{[IO.File]::WriteAllText($program,$case.source)}
    $info=[Diagnostics.ProcessStartInfo]::new($node)
    $info.WorkingDirectory=$caseDirectory;$info.UseShellExecute=$false
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.Environment['QB_E2E_FAILURE']=$case.scenario
    foreach($argument in @('--require',"$PSScriptRoot/fixtures/e2e-deadline.cjs",$program)){$info.ArgumentList.Add($argument)}
    $started=Get-Date -Format s
    $process=[Diagnostics.Process]::Start($info)
    $stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
    $stdout=$stdoutTask.GetAwaiter().GetResult();$stderr=$stderrTask.GetAwaiter().GetResult()
    [IO.File]::WriteAllText("$caseDirectory/stdout.txt",$stdout);[IO.File]::WriteAllText("$caseDirectory/stderr.txt",$stderr)
    $events=@($stdout -split "`n"|Where-Object {$_ -like 'QB_E2E_EVENT *'}|ForEach-Object {$_.Substring(13)|ConvertFrom-Json})
    $problems=[Collections.Generic.List[string]]::new()
    $download=@($events|Where-Object kind -EQ download);$installer=@($events|Where-Object kind -EQ installer);$timer=@($events|Where-Object kind -EQ deadline)
    if($download.Count -ne 1){$problems.Add('download-count')}
    elseif($download[0].version -cne 'stable' -or $null -ne $download[0].platform -or $download[0].silent -cne $true){$problems.Add('download-selection')}
    if($installer.Count -ne 1){$problems.Add('installer-count')}
    else{
        if($installer[0].program -cne 'bun'){$problems.Add('installer-command')}
        if(($installer[0].args|ConvertTo-Json -Compress) -cne (@('x','playwright','install','ffmpeg')|ConvertTo-Json -Compress)){$problems.Add('installer-arguments')}
        if($installer[0].stdio -cne 'inherit'){$problems.Add('installer-stdio')}
    }
    if($timer.Count -ne 1 -or $timer[0].milliseconds -ne 300000){$problems.Add('deadline')}
    $expectedCode=if($case.scenario -ceq 'success'){0}else{1}
    if($process.ExitCode -ne $expectedCode){$problems.Add('exit-code')}
    $completionCount=[regex]::Matches($stdout,'(?m)^Installation complete\.\r?$').Count
    if($completionCount -ne $(if($expectedCode -eq 0){1}else{0})){$problems.Add('completion')}
    if($expectedCode -ne 0){
        $message=switch($case.scenario){'download'{'MOCK_DOWNLOAD_FAILURE'};'installer'{'MOCK_INSTALLER_FAILURE'};'timeout'{'Installation timed out.'}}
        if(-not $stderr.Contains($message)){$problems.Add('failure-diagnostic')}
    }
    $accepted=if($case.reject){$negatives++;$problems.Contains($case.reject)}else{$problems.Count -eq 0}
    if(-not $accepted){$failures.Add($case.name)}
    $records+=@{name=$case.name;scenario=$case.scenario;started=$started;ended=(Get-Date -Format s);exitCode=$process.ExitCode;expectedNegative=$case.reject;assertionFailures=@($problems.ToArray());accepted=$accepted;stdout="$caseDirectory/stdout.txt";stderr="$caseDirectory/stderr.txt"}
    $process.Dispose()
}
$result=@{timestamp=(Get-Date -Format s);mode=$Mode;requirements=@('TEST-QB-055','plan command-chain policy line 500');hashes=$hashes;sourceSha256=$(if($Mode -eq 'Implementation'){(Get-FileHash $implementation).Hash}else{$null});checks=$records.Count;negativeControls=$negatives;failed=$failures.Count;failures=@($failures.ToArray());skipped=0;records=$records;scope='Native Node program execution with synthetic download/installer dependencies; not a live download or full Playwright run.'}
$result|ConvertTo-Json -Depth 12|Set-Content "$directory/result.json" -Encoding utf8NoBOM
$result|Select-Object timestamp,mode,checks,negativeControls,failed,failures,skipped|ConvertTo-Json
if($failures.Count){throw 'E2e preparation contract failed.'}
