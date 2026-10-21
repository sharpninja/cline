# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory)][string]$Task,
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path,
    [Parameter(Mandatory)][string]$ReceiptDirectory,
    [switch]$PlanOnly
)
$ErrorActionPreference='Stop'
Import-Module "$PSScriptRoot/VscodeBuild.psm1" -Force
$steps=@(Get-QbrainVscodeBuildStep -Task $Task)
if($PlanOnly){$steps|ConvertTo-Json -Depth 10 -AsArray;return}
$root=[IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($RepositoryRoot))
$receipt=[IO.Path]::GetFullPath($ReceiptDirectory)
if(Test-Path $receipt){throw 'Use a new receipt directory; existing evidence must be retained.'}
if(-not $PSCmdlet.ShouldProcess($root,"Execute $Task via explicit native argv and save receipts in $receipt")){return}

function Get-BuildSourceState {
    $tracked=@(& git -C $root ls-files -z --cached --others --exclude-standard -- apps/vscode sdk/packages qbrain)-join "`n"
    if($LASTEXITCODE -ne 0){throw 'Cannot fingerprint the relevant source tree.'}
    $state=[ordered]@{}
    foreach($path in @($tracked.Split([char]0,[StringSplitOptions]::RemoveEmptyEntries)|Sort-Object -Unique)){
        if($path -match '(^|/)(AGENTS-README-FIRST\.yaml[^/]*|\.mcpServer|\.creds|node_modules)(/|$)'){continue}
        $full=Join-Path $root $path
        $state[$path]=if(Test-Path -LiteralPath $full -PathType Leaf){(Get-FileHash -LiteralPath $full).Hash}else{'missing'}
    }
    return $state
}

# Audit all graph entries before launching any step. Do not partly execute an
# e2e chain whose dependency installer is known to violate the toolchain policy.
$processes=@()
$versions=@{}
foreach($step in $steps){
    $cwd=[IO.Path]::GetFullPath((Join-Path $root $step.cwd))
    $entry=[IO.Path]::GetFullPath((Join-Path $cwd $step.entry))
    if(-not $cwd.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal) -or -not $entry.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)){throw 'Build path escapes the selected repository.'}
    if(-not (Test-Path -LiteralPath $entry -PathType Leaf)){throw "Required local build entry is missing: $($step.entry)"}
    if($step.id -eq 'e2eDependencies'){
        $source=[IO.File]::ReadAllText($entry)
        if($source -match '\bexeca\s*\(\s*["''](?:npm|npx|yarn|pnpm)["'']'){throw 'The e2e dependency installer still invokes a prohibited package manager. Reconcile that edge before execution.'}
    }
    $runtime=Get-QbrainBuildRuntimePath -Candidates @(Get-Command $step.runtime -CommandType Application -ErrorAction Stop)
    if(-not $versions.ContainsKey($step.runtime)){
        $version=@(& $runtime --version)-join "`n"
        if($LASTEXITCODE -ne 0){throw "Cannot verify runtime version: $($step.runtime)"}
        if($step.runtime -eq 'bun' -and $version.Trim() -cne '1.4.2'){throw 'This repository requires Bun 1.4.2.'}
        if($step.runtime -eq 'node' -and ($version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22)){throw 'This repository requires Node 22 or newer.'}
        $versions[$step.runtime]=$version.Trim()
    }
    $info=[Diagnostics.ProcessStartInfo]::new($runtime)
    $info.WorkingDirectory=$cwd;$info.UseShellExecute=$false
    $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.Environment['PATH']=Get-QbrainBuildSearchPath -RepositoryRoot $root -WorkingDirectory $cwd -InheritedPath $env:PATH
    if($step.runtime -eq 'pwsh'){foreach($argument in @('-NoProfile','-NonInteractive','-File')){$info.ArgumentList.Add($argument)}}
    $info.ArgumentList.Add($entry)
    foreach($argument in $step.arguments){$info.ArgumentList.Add($argument)}
    $processes+=,$info
}
$before=Get-BuildSourceState
[void][IO.Directory]::CreateDirectory($receipt)
$before|ConvertTo-Json -Depth 5|Set-Content "$receipt/source-before.json" -Encoding utf8NoBOM
if($Task -in @('prepare','format:generated')){
    $backup="$receipt/original-source"
    foreach($path in $before.Keys){
        if($before[$path] -ceq 'missing' -or -not $path.StartsWith('apps/vscode/')){continue}
        $target=Join-Path $backup $path
        [void][IO.Directory]::CreateDirectory((Split-Path $target -Parent))
        [IO.File]::Copy((Join-Path $root $path),$target,$false)
        if((Get-FileHash $target).Hash -cne $before[$path]){throw "Original-source backup mismatch: $path"}
    }
}
$records=[Collections.Generic.List[object]]::new()
$runner={
    param($step,$index)
    $info=$processes[$index]
    $started=Get-Date -Format s
    $process=[Diagnostics.Process]::Start($info)
    $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    $prefix=Join-Path $receipt "$index-$($step.id)"
    [IO.File]::WriteAllText("$prefix.stdout.txt",$stdout.GetAwaiter().GetResult())
    [IO.File]::WriteAllText("$prefix.stderr.txt",$stderr.GetAwaiter().GetResult())
    $record=@{index=$index;id=$step.id;runtime=$info.FileName;argv=@($info.ArgumentList);cwd=$info.WorkingDirectory;started=$started;ended=(Get-Date -Format s);exitCode=$process.ExitCode;stdout="$prefix.stdout.txt";stderr="$prefix.stderr.txt"}
    $records.Add($record)
    $code=$process.ExitCode;$process.Dispose()
    return [int]$code
}.GetNewClosure()
$result=Invoke-QbrainVscodeBuildGraph -Steps $steps -RunStep $runner
$after=Get-BuildSourceState
$after|ConvertTo-Json -Depth 5|Set-Content "$receipt/source-after.json" -Encoding utf8NoBOM
$changed=@(@($before.Keys)+@($after.Keys)|Sort-Object -Unique|Where-Object {$before[$_] -cne $after[$_]})
$proof=@{timestamp=(Get-Date -Format s);task=$Task;repositoryRoot=$root;runtimeVersions=$versions;planned=$steps.Count;executed=$result.executed;exitCode=$result.exitCode;failedStep=$result.failedStep;sourceChanged=$changed;requiresPreparationReview=($Task -in @('prepare','format:generated') -and $changed.Count -gt 0);records=@($records.ToArray());phaseAccepted=$false}
$proof|ConvertTo-Json -Depth 10|Set-Content "$receipt/result.json" -Encoding utf8NoBOM
$proof|ConvertTo-Json -Depth 10
if($changed.Count){throw 'Source changed during this command chain. Review and stage intentional preparation changes before verification; no passing verification receipt is granted.'}
if($result.exitCode -ne 0){exit $result.exitCode}
