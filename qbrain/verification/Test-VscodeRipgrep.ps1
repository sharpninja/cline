# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory)
$ErrorActionPreference='Stop'
$root=(Resolve-Path "$PSScriptRoot/../..").Path
$fixture="$PSScriptRoot/fixtures/ripgrep-probe.mjs"
$source="$root/apps/vscode/scripts/qbrain/download-ripgrep.mjs"
$hashes=@{test=(Get-FileHash $PSCommandPath).Hash;fixture=(Get-FileHash $fixture).Hash}
if(Test-Path "$ReceiptDirectory/ripgrep-$Mode.json"){throw 'Use a new receipt directory; preserve prior evidence.'}
if($Mode -eq 'Implementation'){
    $gate=Get-Content "$ReceiptDirectory/ripgrep-Mock.json" -Raw|ConvertFrom-Json
    if($gate.failed -ne 0 -or $gate.skipped -ne 0 -or $gate.cases -ne 19 -or $gate.negativeControls -lt 200){throw 'Complete passing mock gate required.'}
    if($gate.hashes.test -cne $hashes.test -or $gate.hashes.fixture -cne $hashes.fixture){throw 'Test sources changed since mock gate.'}
}
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Run $Mode ripgrep contract with native Node and synthetic dependencies")){return}
[void][IO.Directory]::CreateDirectory($ReceiptDirectory)
$node=@(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
$version=@(& $node --version)-join "`n"
if($LASTEXITCODE -ne 0 -or $version -notmatch '^v(2[2-9]|[3-9][0-9])\.'){throw 'Node 22 or newer required.'}
$info=[Diagnostics.ProcessStartInfo]::new($node)
$info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
foreach($argument in @('--experimental-vm-modules',$fixture,$Mode.ToLowerInvariant(),$source)){$info.ArgumentList.Add($argument)}
$process=[Diagnostics.Process]::Start($info)
$stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
$prefix="$ReceiptDirectory/ripgrep-$Mode"
$output=$stdout.GetAwaiter().GetResult()
[IO.File]::WriteAllText("$prefix.stdout.txt",$output)
[IO.File]::WriteAllText("$prefix.stderr.txt",$stderr.GetAwaiter().GetResult())
$result=$output|ConvertFrom-Json -AsHashtable
$result.timestamp=Get-Date -Format s;$result.hashes=$hashes;$result.runtime=$node;$result.version=$version.Trim();$result.exitCode=$process.ExitCode
$result.requirements=@('TEST-QB-055','Approved command-chain policy: preserve native Node, no child shell')
if($Mode -eq 'Implementation'){$result.implementationSha256=(Get-FileHash $source).Hash}
$result|ConvertTo-Json -Depth 20|Set-Content "$prefix.json" -Encoding utf8NoBOM
$process.Dispose()
$result|ConvertTo-Json -Depth 20
if($result.exitCode -ne 0 -or $result.failed -ne 0 -or $result.skipped -ne 0){throw 'Ripgrep contract failed.'}
