# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path,
    [Parameter(Mandatory)][string]$ReceiptDirectory
)
$ErrorActionPreference='Stop'
Import-Module "$PSScriptRoot/VscodeBuild.psm1" -Force
Import-Module "$PSScriptRoot/VscodeDependencies.psm1" -Force
$root=[IO.Path]::GetFullPath($RepositoryRoot)
$receipt=[IO.Path]::GetFullPath($ReceiptDirectory)
if(Test-Path $receipt){throw 'Use a new receipt directory; retain previous evidence.'}
if(-not $PSCmdlet.ShouldProcess($root,"Install frozen dependencies without lifecycle scripts, prepare native binaries and write $receipt")){return}
[void][IO.Directory]::CreateDirectory($receipt)
$records=[Collections.Generic.List[object]]::new()
$versions=@{};$runtimes=@{};$result=$null;$failure=$null
$filterEnvironment=${function:Get-QbrainNativeInstallerEnvironment}
try{
    foreach($name in @('bun','node')){
        $runtimes[$name]=Get-QbrainBuildRuntimePath -Candidates @(Get-Command $name -CommandType Application -ErrorAction Stop)
        $versions[$name]=(@(& $runtimes[$name] --version)-join "`n").Trim()
        if($LASTEXITCODE -ne 0){throw "Cannot read $name runtime version"}
    }
    if($versions.bun -cne '1.4.2'){throw 'Bun 1.4.2 required'}
    $platform=if($IsWindows){'win32'}elseif($IsLinux){'linux'}elseif($IsMacOS){'darwin'}else{'unsupported'}
    $run={
        param($command)
        $info=[Diagnostics.ProcessStartInfo]::new($runtimes[$command.runtime])
        $info.WorkingDirectory=$command.cwd;$info.UseShellExecute=$false
        $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        foreach($argument in $command.arguments){$info.ArgumentList.Add($argument)}
        $removed=@()
        if($command.nativeInstaller){
            $clean=& $filterEnvironment $info.Environment
            $removed=@($info.Environment.Keys|Where-Object { -not $clean.ContainsKey($_) }|Sort-Object)
            foreach($key in $removed){[void]$info.Environment.Remove($key)}
        }
        $prefix=Join-Path $receipt "$($records.Count)-$($command.id)"
        $record=[ordered]@{id=$command.id;runtime=$info.FileName;argv=@($info.ArgumentList);cwd=$info.WorkingDirectory;started=(Get-Date -Format s);ended=$null;exitCode=$null;removedEnvironmentNames=$removed;stdout="$prefix.stdout.txt";stderr="$prefix.stderr.txt"}
        $records.Add($record)
        $process=$null
        try{
            $process=[Diagnostics.Process]::Start($info)
            $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
            $process.WaitForExit()
            [IO.File]::WriteAllText($record.stdout,$stdout.GetAwaiter().GetResult())
            [IO.File]::WriteAllText($record.stderr,$stderr.GetAwaiter().GetResult())
            $record.exitCode=$process.ExitCode
            return [int]$process.ExitCode
        }finally{
            $record.ended=Get-Date -Format s
            if($process){$process.Dispose()}
        }
    }.GetNewClosure()
    $result=Invoke-QbrainVscodeDependencySetup -RepositoryRoot $root -NodeVersion $versions.node -Platform $platform -RunCommand $run
}catch{$failure=$_.Exception.Message}
$code=if($failure){1}elseif($null -eq $result){1}else{[int]$result.exitCode}
$proof=[ordered]@{timestamp=(Get-Date -Format s);repositoryRoot=$root;runtimeVersions=$versions;exitCode=$code;failure=$failure;result=$result;records=@($records.ToArray());phaseAccepted=$false}
$proof|ConvertTo-Json -Depth 12|Set-Content "$receipt/result.json" -Encoding utf8NoBOM
[pscustomobject]$proof|Select-Object timestamp,repositoryRoot,runtimeVersions,exitCode,failure,phaseAccepted|ConvertTo-Json
if($code -ne 0){exit $code}
