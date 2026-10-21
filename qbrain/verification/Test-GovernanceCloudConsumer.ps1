# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptDirectory)
$ErrorActionPreference='Stop'
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Run $Mode ESM and CommonJS cloud policy consumer contracts")){return}
$root=(Resolve-Path "$PSScriptRoot/../..").Path
$package="$root/sdk/packages/qbrain-governance"
$node=@(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
$hashes=@{}
foreach($path in @($PSCommandPath,"$PSScriptRoot/fixtures/cloud-policy-consumer.cjs","$PSScriptRoot/fixtures/cloud-policy-consumer.mjs")){$hashes[$path]=(Get-FileHash $path).Hash}
$modeDirectory=Join-Path $ReceiptDirectory $Mode.ToLowerInvariant()
if(Test-Path $modeDirectory){throw 'Use a new receipt directory; retain previous runs.'}
if($Mode -eq 'Implementation'){
    $gate=Get-Content "$ReceiptDirectory/mock/result.json" -Raw|ConvertFrom-Json
    if($gate.failed -ne 0 -or $gate.skipped -ne 0){throw 'Passing mock gate required.'}
    foreach($path in $hashes.Keys){if($gate.hashes.$path -cne $hashes[$path]){throw 'The mock and real assertions differ.'}}
}
$failures=[Collections.Generic.List[string]]::new();$records=@();$checks=0;$negative=0
$cases=if($Mode -eq 'Mock'){@('correct','missing-require','incorrect-policy')}else{@('actual')}
foreach($case in $cases){
    $directory=Join-Path $modeDirectory $case
    $destination="$directory/node_modules/@cline/qbrain-governance"
    [void][IO.Directory]::CreateDirectory((Split-Path $destination -Parent))
    if($Mode -eq 'Implementation'){$null=New-Item -ItemType SymbolicLink -Path $destination -Target $package}
    else{
        [void][IO.Directory]::CreateDirectory($destination)
        $manifest=@{name='@cline/qbrain-governance';type='module';exports=@{'./cloud-policy'=@{import='./cloud-policy.mjs';require='./cloud-policy.cjs'}}}
        if($case -eq 'missing-require'){$manifest.exports['./cloud-policy'].Remove('require')}
        $manifest|ConvertTo-Json -Depth 10|Set-Content "$destination/package.json" -Encoding utf8NoBOM
        $value=if($case -eq 'incorrect-policy'){'false'}else{"value.trim().toLowerCase() === 'cline'"}
        $body="function isClineCloudProvider(value) { return $value; }`nfunction assertDirectProvider(value) { if (isClineCloudProvider(value)) { const error = new Error('blocked'); error.code = 'cline_cloud_disabled'; throw error; } }`n"
        [IO.File]::WriteAllText("$destination/cloud-policy.mjs",$body+'export { isClineCloudProvider, assertDirectProvider };')
        [IO.File]::WriteAllText("$destination/cloud-policy.cjs",$body+'module.exports = { isClineCloudProvider, assertDirectProvider };')
    }
    foreach($extension in @('mjs','cjs')){
        $source="$PSScriptRoot/fixtures/cloud-policy-consumer.$extension"
        $consumer="$directory/consumer.$extension"
        [IO.File]::Copy($source,$consumer,$false)
        if((Get-FileHash $consumer).Hash -cne $hashes[$source]){throw 'Consumer copy differs.'}
        $info=[Diagnostics.ProcessStartInfo]::new($node)
        $info.UseShellExecute=$false;$info.WorkingDirectory=$directory
        $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true;$info.ArgumentList.Add($consumer)
        $started=Get-Date -Format s
        $process=[Diagnostics.Process]::Start($info)
        $stdoutTask=$process.StandardOutput.ReadToEndAsync();$stderrTask=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
        $stdout=$stdoutTask.GetAwaiter().GetResult();$stderr=$stderrTask.GetAwaiter().GetResult()
        $prefix="$directory/$extension"
        [IO.File]::WriteAllText("$prefix.stdout.txt",$stdout);[IO.File]::WriteAllText("$prefix.stderr.txt",$stderr)
        $shouldPass=$case -in @('correct','actual') -or ($case -eq 'missing-require' -and $extension -eq 'mjs')
        $checks++
        $passed=if($shouldPass){$process.ExitCode -eq 0 -and $stdout.Trim() -ceq 'QB_CLOUD_POLICY_CONSUMER_PASS'}else{
            $negative++
            $code=if($case -eq 'missing-require'){'ERR_PACKAGE_PATH_NOT_EXPORTED'}else{'ERR_ASSERTION'}
            $process.ExitCode -ne 0 -and $stderr.Contains($code)
        }
        if(-not $passed){$failures.Add("$case/$extension")}
        $records+=@{case=$case;module=$extension;started=$started;ended=(Get-Date -Format s);runtime=$node;exitCode=$process.ExitCode;expectedPass=$shouldPass;assertionPassed=$passed;stdout="$prefix.stdout.txt";stderr="$prefix.stderr.txt"}
        $process.Dispose()
    }
}
$result=@{timestamp=(Get-Date -Format s);requirement='TEST-QB-011/055';mode=$Mode;checks=$checks;negativeControls=$negative;failed=$failures.Count;failures=@($failures.ToArray());skipped=0;hashes=$hashes;records=$records;scope='Native ESM and CommonJS loading of cloud-policy with unchanged provider-policy assertions.'}
$result|ConvertTo-Json -Depth 10|Set-Content "$modeDirectory/result.json" -Encoding utf8NoBOM
$result|Select-Object timestamp,mode,checks,negativeControls,failed,failures,skipped|ConvertTo-Json
if($failures.Count){throw 'Native cloud-policy consumer failed.'}
