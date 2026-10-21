# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('test:e2e','test:coverage','test:integration','test:storage-webview')][string]$Task='test:e2e',
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path,
    [Parameter(Mandatory)][string]$ReceiptDirectory
)
$ErrorActionPreference='Stop'
Import-Module "$PSScriptRoot/VscodeDisplay.psm1" -Force
$root=[IO.Path]::GetFullPath($RepositoryRoot)
$receipt=[IO.Path]::GetFullPath($ReceiptDirectory)
$displayReceipt=$receipt+'.display'
if((Test-Path $receipt) -or (Test-Path $displayReceipt)){throw 'Use new receipt paths; preserve existing evidence.'}
if(-not $PSCmdlet.ShouldProcess($root,"Run $Task with an inherited display or an owned Xvfb process")){return}
$pwsh=(Get-Command pwsh -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
$start={
    $executable=(Get-Command Xvfb -CommandType Application -ErrorAction Stop|Select-Object -First 1).Source
    $info=[Diagnostics.ProcessStartInfo]::new($executable)
    $info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    foreach($argument in @('-displayfd','1','-screen','0','1280x1024x24','-nolisten','tcp')){$info.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::Start($info)
    $errorStream=$process.StandardError.ReadToEndAsync()
    try {
        $number=$process.StandardOutput.ReadLineAsync()
        if(-not $number.Wait(30000)){throw 'Xvfb did not become ready within its startup allowance.'}
        $value=$number.GetAwaiter().GetResult()
        if($value -notmatch '^[0-9]+$' -or $process.HasExited){throw 'Xvfb failed to start.'}
        return @{name=":$value";process=$process;errors=$errorStream}
    }catch{
        if(-not $process.HasExited){$process.Kill($true);$process.WaitForExit()}
        [void][IO.Directory]::CreateDirectory($displayReceipt)
        [IO.File]::WriteAllText("$displayReceipt/startup-error.txt",$errorStream.GetAwaiter().GetResult())
        $process.Dispose();throw
    }
}.GetNewClosure()
$stop={
    param($owned)
    if(-not $owned.process.HasExited){$owned.process.Kill($true);$owned.process.WaitForExit()}
    [void][IO.Directory]::CreateDirectory($displayReceipt)
    [IO.File]::WriteAllText("$displayReceipt/xvfb.stderr.txt",$owned.errors.GetAwaiter().GetResult())
    @{timestamp=(Get-Date -Format s);display=$owned.name;processId=$owned.process.Id;owned=$true;stopped=$owned.process.HasExited}|ConvertTo-Json|Set-Content "$displayReceipt/result.json" -Encoding utf8NoBOM
    $owned.process.Dispose()
}.GetNewClosure()
$run={
    param($display)
    $info=[Diagnostics.ProcessStartInfo]::new($pwsh)
    $info.UseShellExecute=$false;$info.WorkingDirectory=$root
    if($display){$info.Environment['DISPLAY']=$display}
    foreach($argument in @('-NoProfile','-NonInteractive','-File',"$root/qbrain/build/Invoke-VscodeBuild.ps1",'-Task',$Task,'-RepositoryRoot',$root,'-ReceiptDirectory',$receipt)){$info.ArgumentList.Add($argument)}
    $process=[Diagnostics.Process]::Start($info)
    try{$process.WaitForExit();return $process.ExitCode}finally{if(-not $process.HasExited){$process.Kill($true);$process.WaitForExit()};$process.Dispose()}
}.GetNewClosure()
$code=Invoke-QbrainDisplayScope -CurrentDisplay $env:DISPLAY -LinuxHost $IsLinux -StartDisplay $start -StopDisplay $stop -Run $run
exit [int]$code
