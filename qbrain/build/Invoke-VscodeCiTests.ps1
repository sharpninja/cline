# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][ValidateSet('Vitest','Unit','IntegrationRetry')][string]$Policy,
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path,
    [Parameter(Mandatory)][string]$ReceiptDirectory
)
$ErrorActionPreference='Stop'
Import-Module "$PSScriptRoot/VscodeCiTests.psm1" -Force
$root=[IO.Path]::GetFullPath($RepositoryRoot)
$receipt=[IO.Path]::GetFullPath($ReceiptDirectory)
if(Test-Path $receipt){throw 'Use a new receipt directory; preserve existing evidence.'}
if(-not $PSCmdlet.ShouldProcess($root,"Run $Policy with the existing CI test-count or retry gate")){return}
[void][IO.Directory]::CreateDirectory($receipt)
$task=switch($Policy){Vitest{'test:vitest'};Unit{'test:unit'};IntegrationRetry{'test:integration'}}
$pwsh=(Get-Command pwsh -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
$output=[Text.StringBuilder]::new()
$errors=[Collections.Generic.List[object]]::new()
$run={
    param($attempt)
    $childReceipt=Join-Path $receipt "attempt-$attempt"
    $process=$null
    try{
        $info=[Diagnostics.ProcessStartInfo]::new($pwsh)
        $info.UseShellExecute=$false;$info.WorkingDirectory=$root
        $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        foreach($arg in @('-NoProfile','-NonInteractive','-File',"$root/qbrain/build/Invoke-VscodeBuild.ps1",'-Task',$task,'-RepositoryRoot',$root,'-ReceiptDirectory',$childReceipt)){$info.ArgumentList.Add($arg)}
        $process=[Diagnostics.Process]::Start($info)
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        [IO.File]::WriteAllText("$receipt/attempt-$attempt.stdout.txt",$stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText("$receipt/attempt-$attempt.stderr.txt",$stderr.GetAwaiter().GetResult())
        $proof=Get-Content "$childReceipt/result.json" -Raw|ConvertFrom-Json -ErrorAction Stop
        if($null -eq $proof.exitCode -or $proof.exitCode -ne $process.ExitCode){throw 'Native exit code and child receipt disagree.'}
        $attemptOutput=[Text.StringBuilder]::new()
        foreach($record in $proof.records){
            foreach($path in @($record.stdout,$record.stderr)){
                $full=[IO.Path]::GetFullPath($path)
                if(-not $full.StartsWith($childReceipt+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)){throw 'Test output path escapes its receipt.'}
                [void]$attemptOutput.AppendLine([IO.File]::ReadAllText($full))
            }
        }
        [void]$output.Append($attemptOutput)
        [Console]::Out.Write($attemptOutput.ToString())
        return @{exitCode=[int]$process.ExitCode;output=$attemptOutput.ToString()}
    }catch{
        $errors.Add(@{attempt=$attempt;message=$_.Exception.Message})
        throw
    }finally{
        if($process){if(-not $process.HasExited){$process.Kill($true);$process.WaitForExit()};$process.Dispose()}
    }
}.GetNewClosure()
$wait={param($seconds);Start-Sleep -Seconds $seconds}
$result=Invoke-QbrainVscodeCiTest -Policy $Policy -RunAttempt $run -WaitBetweenAttempts $wait
[IO.File]::WriteAllText("$receipt/output.log",$output.ToString())
$proof=@{timestamp=(Get-Date -Format s);policy=$Policy;task=$task;attempts=$result.attempts;exitCode=$result.exitCode;failureReason=$result.failureReason;errors=@($errors.ToArray());phaseAccepted=$false}
if($result.failureReason){Write-Output $result.failureReason}
$proof|ConvertTo-Json -Depth 10|Set-Content "$receipt/result.json" -Encoding utf8NoBOM
$proof|ConvertTo-Json -Depth 10
exit [int]$result.exitCode
