# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Mock','Implementation')][string]$Mode='Mock',
    [Parameter(Mandatory)][string]$ReceiptDirectory
)
$ErrorActionPreference='Stop'
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Verify $Mode package declarations under existing TypeScript resolution modes")){return}
$root=(Resolve-Path "$PSScriptRoot/../..").Path
$package="$root/sdk/packages/qbrain-governance"
$node=@(Get-Command node -CommandType Application -ErrorAction Stop)[0].Source
$compiler="$root/node_modules/typescript/bin/tsc"
$expected=[ordered]@{
    '.'='./dist/index.d.ts'
    './hub-namespace'='./dist/hub-namespace.d.ts'
    './host-storage'='./dist/host-storage.d.ts'
    './storage-policy'='./dist/storage-policy.d.ts'
    './cloud-policy'='./dist/cloud-policy.d.ts'
}
function Test-TypeContract {
    param([hashtable]$Manifest)
    if($Manifest.types -cne './dist/index.d.ts'){return $false}
    foreach($key in $expected.Keys){
        if($Manifest.exports[$key].types -cne $expected[$key]){return $false}
        if($key -ne '.'){
            $routes=@($Manifest.typesVersions['*'][$key.Substring(2)])
            if($routes.Count -ne 1 -or $routes[0] -cne $expected[$key]){return $false}
        }
    }
    return $true
}
$failures=[Collections.Generic.List[string]]::new();$checks=0;$negative=0
function Assert-Resolution {
    param([bool]$Actual,[bool]$Expected,[string]$Label)
    $script:checks++
    if($Actual -ne $Expected){$script:failures.Add($Label)}
}
$mock=@{name='@cline/qbrain-governance';version='0.0.1';type='module';types='./dist/index.d.ts';exports=@{};typesVersions=@{'*'=@{}}}
foreach($key in $expected.Keys){
    $mock.exports[$key]=@{types=$expected[$key];import=$expected[$key].Replace('.d.ts','.js')}
    if($key -ne '.'){$mock.typesVersions['*'][$key.Substring(2)]=@($expected[$key])}
}
Assert-Resolution (Test-TypeContract $mock) $true 'correct-contract'
foreach($mutation in @('missing-root','missing-map','wrong-path','multiple-paths','missing-export')){
    $bad=$mock|ConvertTo-Json -Depth 10|ConvertFrom-Json -AsHashtable
    switch($mutation){
        'missing-root' {$bad.Remove('types')}
        'missing-map' {$bad.typesVersions['*'].Remove('cloud-policy')}
        'wrong-path' {$bad.typesVersions['*']['cloud-policy']=@('./dist/index.d.ts')}
        'multiple-paths' {$bad.typesVersions['*']['cloud-policy']=@('./dist/cloud-policy.d.ts','./dist/index.d.ts')}
        'missing-export' {$bad.exports.Remove('./cloud-policy')}
    }
    $negative++;Assert-Resolution (Test-TypeContract $bad) $false $mutation
}
$hash=(Get-FileHash $PSCommandPath).Hash
$modeDirectory=Join-Path $ReceiptDirectory $Mode.ToLowerInvariant()
if(Test-Path $modeDirectory){throw 'Use a new receipt directory; retain previous evidence.'}
if($Mode -eq 'Implementation'){
    $gate=Get-Content "$ReceiptDirectory/mock/result.json" -Raw|ConvertFrom-Json
    if($gate.failed -ne 0 -or $gate.skipped -ne 0 -or $gate.testSha256 -cne $hash){throw 'Unchanged passing mock gate required.'}
    $manifest=Get-Content "$package/package.json" -Raw|ConvertFrom-Json -AsHashtable
    Assert-Resolution (Test-TypeContract $manifest) $true 'actual-package-contract'
}else{$manifest=$mock}
$fixture="$modeDirectory/fixture"
$fixturePackage="$fixture/node_modules/@cline/qbrain-governance"
[void][IO.Directory]::CreateDirectory($fixturePackage)
$manifest|ConvertTo-Json -Depth 10|Set-Content "$fixturePackage/package.json" -Encoding utf8NoBOM
if($Mode -eq 'Mock'){
    [void][IO.Directory]::CreateDirectory("$fixturePackage/dist")
    foreach($entry in $expected.Values){[IO.File]::WriteAllText((Join-Path $fixturePackage $entry),'export declare const declarationPresent: true;')}
}else{
    $null=New-Item -ItemType SymbolicLink -Path "$fixturePackage/dist" -Target "$package/dist"
}
$imports=@();$names=@();$index=0
foreach($key in $expected.Keys){
    $specifier='@cline/qbrain-governance'+$(if($key -eq '.') {''}else{$key.Substring(1)})
    $imports+="import type * as contract$index from '$specifier';"
    $names+="typeof contract$index";$index++
}
$code=($imports -join "`n")+"`nexport type PublicSurface = ["+($names -join ',')+"];`n"
[IO.File]::WriteAllText("$fixture/consumer.mts",$code)
[IO.File]::WriteAllText("$fixture/unknown.mts","import type * as missing from '@cline/qbrain-governance/not-a-public-entry'; export type Missing = typeof missing;`n")
$records=@()
foreach($resolution in @('Node10','Node16','Bundler')){
    $module=if($resolution -eq 'Node16'){'Node16'}else{'ESNext'}
    foreach($case in @('consumer','unknown')){
        $info=[Diagnostics.ProcessStartInfo]::new($node)
        $info.UseShellExecute=$false;$info.WorkingDirectory=$fixture
        $info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
        foreach($arg in @($compiler,'--noEmit','--skipLibCheck','--target','ES2022','--module',$module,'--moduleResolution',$resolution,"$fixture/$case.mts")){$info.ArgumentList.Add($arg)}
        $started=Get-Date -Format s
        $process=[Diagnostics.Process]::Start($info)
        $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync();$process.WaitForExit()
        $prefix="$modeDirectory/$resolution-$case"
        [IO.File]::WriteAllText("$prefix.stdout.txt",$stdout.GetAwaiter().GetResult())
        [IO.File]::WriteAllText("$prefix.stderr.txt",$stderr.GetAwaiter().GetResult())
        $shouldResolve=$case -eq 'consumer'
        Assert-Resolution ($process.ExitCode -eq 0) $shouldResolve "$resolution/$case"
        if(-not $shouldResolve){$negative++}
        $records+=@{resolution=$resolution;case=$case;exitCode=$process.ExitCode;started=$started;ended=(Get-Date -Format s);runtime=$node;argv=@($info.ArgumentList);stdout="$prefix.stdout.txt";stderr="$prefix.stderr.txt"}
        $process.Dispose()
    }
}
$result=@{timestamp=(Get-Date -Format s);requirement='TEST-QB-011/055';scope='Five public declaration entrypoints under Node10, Node16 and Bundler; unknown entrypoints rejected. Does not claim runtime ESM/CommonJS loading compatibility.';mode=$Mode;checks=$checks;negativeControls=$negative;failed=$failures.Count;failures=@($failures.ToArray());skipped=0;testSha256=$hash;manifestSha256=(Get-FileHash "$fixturePackage/package.json").Hash;records=$records}
$result|ConvertTo-Json -Depth 10|Set-Content "$modeDirectory/result.json" -Encoding utf8NoBOM
$result|Select-Object timestamp,mode,checks,negativeControls,failed,failures,skipped,testSha256|ConvertTo-Json
if($failures.Count){throw 'Package declaration resolution assertions failed.'}
