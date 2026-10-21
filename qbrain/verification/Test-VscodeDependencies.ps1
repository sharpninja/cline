# SPDX-License-Identifier: Apache-2.0
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Mock','Implementation')][string]$Mode='Mock',
    [Parameter(Mandatory)][string]$ReceiptDirectory,
    [string]$RepositoryRoot=(Resolve-Path "$PSScriptRoot/../..").Path
)
$ErrorActionPreference='Stop'
if(-not $PSCmdlet.ShouldProcess($ReceiptDirectory,"Run $Mode dependency contracts with synthetic package trees")){return}
$receipt=[IO.Path]::GetFullPath($ReceiptDirectory)
[void][IO.Directory]::CreateDirectory($receipt)
$testHash=(Get-FileHash $PSCommandPath).Hash
if($Mode -eq 'Implementation'){
    $mock=Get-Content "$receipt/dependencies-mock.json" -Raw|ConvertFrom-Json
    if($mock.testSha256 -cne $testHash -or $mock.failed -ne 0 -or $mock.skipped -ne 0){throw 'Matching green mock receipt required.'}
    Import-Module "$RepositoryRoot/qbrain/build/VscodeDependencies.psm1" -Force
}
$checks=0;$negative=0;$cases=[Collections.Generic.List[object]]::new()
function Assert-Exact {
    param($Actual,$Expected,[string]$Label)
    $actualText=ConvertTo-Json -InputObject $Actual -Depth 30 -Compress
    $expectedText=ConvertTo-Json -InputObject $Expected -Depth 30 -Compress
    if($actualText -cne $expectedText){throw "Contract mismatch $Label`: expected $expectedText; observed $actualText"}
    $script:checks++
}
function Assert-WithNegative {
    param($Actual,$Expected,$Wrong,[string]$Label)
    Assert-Exact $Actual $Expected $Label
    $rejected=$false
    try{Assert-Exact $Wrong $Expected "$Label negative"}catch{$rejected=$true}
    if(-not $rejected){throw "Negative control accepted: $Label"}
    $script:negative++
}
function Write-Package {
    param([string]$Directory,[hashtable]$Manifest,[string]$Entry)
    [void][IO.Directory]::CreateDirectory($Directory)
    $Manifest|ConvertTo-Json -Depth 5|Set-Content "$Directory/package.json" -Encoding utf8NoBOM
    if($Entry){$file=Join-Path $Directory $Entry;[void][IO.Directory]::CreateDirectory((Split-Path $file -Parent));[IO.File]::WriteAllText($file,'fixture only, never executed')}
}
$writePackage=${function:Write-Package}
$specs=@(
    @{name='linux-success';platform='linux';commands=@('install','sqlite','grpc');code=0;error='';artifacts=3},
    @{name='windows-success';platform='win32';commands=@('install','sqlite','grpc');code=0;error='';artifacts=3},
    @{name='macos-success';platform='darwin';commands=@('install','sqlite','grpc');code=0;error='';artifacts=3},
    @{name='hardlink-installer';platform='linux';commands=@('install','sqlite','grpc');code=0;error='';artifacts=3},
    @{name='install-failure';platform='linux';commands=@('install');code=17;error='';artifacts=0},
    @{name='sqlite-failure';platform='linux';commands=@('install','sqlite');code=17;error='';artifacts=0},
    @{name='grpc-failure';platform='linux';commands=@('install','sqlite','grpc');code=17;error='';artifacts=0},
    @{name='missing-sqlite';platform='linux';commands=@('install','sqlite','grpc');code=0;error='Missing native artifact';artifacts=0},
    @{name='missing-protoc';platform='linux';commands=@('install','sqlite','grpc');code=0;error='Missing native artifact';artifacts=0},
    @{name='missing-plugin';platform='linux';commands=@('install','sqlite','grpc');code=0;error='Missing native artifact';artifacts=0},
    @{name='lock-mutation';platform='linux';commands=@('install');code=0;error='Lockfile changed';artifacts=0},
    @{name='unknown-install-script';platform='linux';commands=@('install');code=0;error='Unreviewed package contract';artifacts=0},
    @{name='missing-installer';platform='linux';commands=@('install');code=0;error='Missing dependency entry';artifacts=0},
    @{name='external-package';platform='linux';commands=@('install');code=0;error='Dependency path escapes repository';artifacts=0},
    @{name='unsupported-platform';platform='other';commands=@();code=0;error='Unsupported native platform';artifacts=0},
    @{name='old-node';platform='linux';commands=@();code=0;error='Node 22 or newer required';artifacts=0}
)
foreach($case in $specs){
    $caseRoot=Join-Path $receipt "$($Mode.ToLowerInvariant())-$($case.name)"
    if(Test-Path $caseRoot){throw "Retain prior fixture: $caseRoot"}
    [void][IO.Directory]::CreateDirectory($caseRoot)
    [IO.File]::WriteAllText("$caseRoot/bun.lock",'frozen synthetic lockfile')
    $lockBefore=(Get-FileHash "$caseRoot/bun.lock").Hash
    $sqlite="$caseRoot/apps/vscode/node_modules/better-sqlite3"
    $grpc="$caseRoot/apps/vscode/node_modules/grpc-tools"
    $prebuild="$caseRoot/apps/vscode/node_modules/prebuild-install/bin.js"
    if($case.name -eq 'hardlink-installer'){$prebuild="$caseRoot/apps/vscode/node_modules/prebuild-install/linked.js"}
    $preGyp="$caseRoot/apps/vscode/node_modules/@mapbox/node-pre-gyp/bin/node-pre-gyp"
    $extension=if($case.platform -eq 'win32'){'.exe'}else{''}
    $artifactPaths=@("$sqlite/build/Release/better_sqlite3.node","$grpc/bin/protoc$extension","$grpc/bin/grpc_node_plugin$extension")
    $expectedCommands=@{
        install=[ordered]@{id='install';runtime='bun';cwd=$caseRoot;arguments=@('install','--frozen-lockfile','--ignore-scripts');nativeInstaller=$false}
        sqlite=[ordered]@{id='sqlite';runtime='node';cwd=$sqlite;arguments=@($prebuild,'--runtime=node','--target=22.23.3','--no-build-from-source');nativeInstaller=$true}
        grpc=[ordered]@{id='grpc';runtime='node';cwd=$grpc;arguments=@($preGyp,'install','--no-build-from-source','--no-fallback-to-build');nativeInstaller=$true}
    }
    $history=[Collections.Generic.List[object]]::new()
    $runner={
        param($command)
        $history.Add($command)
        if($command.id -eq 'install'){
            # Packages deliberately appear only after the install seam executes.
            $scriptText=if($case.name -eq 'unknown-install-script'){'npm install'}else{'prebuild-install || node-gyp rebuild --release'}
            & $writePackage $sqlite @{name='better-sqlite3';version='12.11.1';scripts=@{install=$scriptText}} ''
            & $writePackage (Split-Path $prebuild) @{name='prebuild-install';version='7.1.3';bin='./bin.js'} 'bin.js'
            if($case.name -eq 'hardlink-installer'){
                & $writePackage (Split-Path $prebuild) @{name='prebuild-install';version='7.1.3';bin='./linked.js'} ''
                [void](New-Item -ItemType HardLink -Path $prebuild -Target (Join-Path (Split-Path $prebuild) 'bin.js'))
            }
            if($case.name -eq 'external-package'){
                $outside=Join-Path $receipt "$Mode-outside-package"
                & $writePackage $outside @{name='grpc-tools';version='1.13.1';scripts=@{install='node-pre-gyp install'}} ''
                [void](New-Item -ItemType SymbolicLink -Path $grpc -Target $outside)
            }else{& $writePackage $grpc @{name='grpc-tools';version='1.13.1';scripts=@{install='node-pre-gyp install'}} ''}
            & $writePackage (Split-Path (Split-Path $preGyp)) @{name='@mapbox/node-pre-gyp';version='2.0.3';bin=@{'node-pre-gyp'='./bin/node-pre-gyp'}} 'bin/node-pre-gyp'
            if($case.name -eq 'lock-mutation'){[IO.File]::WriteAllText("$caseRoot/bun.lock",'changed')}
            if($case.name -eq 'missing-installer'){
                # Keep the original file. The manifest names a nonexistent entry.
                & $writePackage (Split-Path $prebuild) @{name='prebuild-install';version='7.1.3';bin='./missing.js'} ''
            }
        }
        if(($case.name -eq 'install-failure' -and $command.id -eq 'install') -or ($case.name -eq 'sqlite-failure' -and $command.id -eq 'sqlite') -or ($case.name -eq 'grpc-failure' -and $command.id -eq 'grpc')){return 17}
        if($command.id -eq 'grpc'){
            foreach($index in 0..2){
                if(($case.name -eq 'missing-sqlite' -and $index -eq 0) -or ($case.name -eq 'missing-protoc' -and $index -eq 1) -or ($case.name -eq 'missing-plugin' -and $index -eq 2)){continue}
                [void][IO.Directory]::CreateDirectory((Split-Path $artifactPaths[$index]))
                [IO.File]::WriteAllText($artifactPaths[$index],'native fixture')
            }
        }
        return 0
    }.GetNewClosure()
    $result=$null;$failure=''
    try{
        if($Mode -eq 'Mock'){
            foreach($name in $case.commands){[void](& $runner $expectedCommands[$name])}
            if($case.error){throw $case.error}
            $result=@{exitCode=$case.code;artifacts=@($artifactPaths|Select-Object -First $case.artifacts);lockfileSha256=$lockBefore}
        }else{
            $nodeVersion=if($case.name -eq 'old-node'){'v20.0.0'}else{'v22.23.3'}
            $result=Invoke-QbrainVscodeDependencySetup -RepositoryRoot $caseRoot -NodeVersion $nodeVersion -Platform $case.platform -RunCommand $runner
        }
    }catch{$failure=$_.Exception.Message}
    $expectedFailure=$case.error
    $failureMatches=if($expectedFailure){$failure.StartsWith($expectedFailure,[StringComparison]::Ordinal)}else{[string]::IsNullOrEmpty($failure)}
    Assert-WithNegative $failureMatches $true $false "$($case.name) error outcome ($failure)"
    Assert-WithNegative @($history|ForEach-Object id) @($case.commands) @('unexpected') "$($case.name) command order"
    for($index=0;$index -lt $history.Count;$index++){
        $actual=$history[$index];$expected=$expectedCommands[$case.commands[$index]]
        foreach($key in $expected.Keys){Assert-WithNegative $actual[$key] $expected[$key] '__wrong__' "$($case.name) $index $key"}
    }
    if(-not $expectedFailure){
        Assert-WithNegative $result.exitCode $case.code -99 "$($case.name) exit"
        Assert-WithNegative @($result.artifacts) @($artifactPaths|Select-Object -First $case.artifacts) @('__missing__') "$($case.name) artifacts"
        Assert-WithNegative $result.lockfileSha256 $lockBefore '__changed__' "$($case.name) lockfile"
    }
    $cases.Add(@{name=$case.name;commands=$history.Count;passed=$true;errorExpected=$expectedFailure})
}
# Child-only environment filtering must leave proxy access and the input intact.
$environment=@{PATH='/test/bin';HTTPS_PROXY='https://proxy.invalid';npm_config_build_from_source='true';NPM_CONFIG_FALLBACK_TO_BUILD='true';npm_config_argv='malformed';KEEP='value'}
$environmentBefore=$environment.Clone()
$clean=if($Mode -eq 'Mock'){@{PATH='/test/bin';HTTPS_PROXY='https://proxy.invalid';KEEP='value'}}else{Get-QbrainNativeInstallerEnvironment -Environment $environment}
Assert-WithNegative @($clean.Keys|Sort-Object) @('HTTPS_PROXY','KEEP','PATH') @('npm_config_build_from_source') 'native environment keys'
foreach($key in @('PATH','HTTPS_PROXY','KEEP')){Assert-WithNegative $clean[$key] $environment[$key] '__wrong__' "native environment $key"}
foreach($key in $environmentBefore.Keys){Assert-WithNegative $environment[$key] $environmentBefore[$key] '__mutated__' "parent unchanged $key"}
# Validate the installed parser's actual boolean contract, not only a plausible argv.
$buildFromSource=$false
if($Mode -eq 'Implementation'){
    $info=[Diagnostics.ProcessStartInfo]::new((Get-Command node -CommandType Application|Select-Object -First 1).Source)
    $info.WorkingDirectory="$RepositoryRoot/apps/vscode/node_modules/better-sqlite3"
    $info.UseShellExecute=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $info.ArgumentList.Add("$RepositoryRoot/apps/vscode/node_modules/prebuild-install/rc.js")
    $info.ArgumentList.Add('--no-build-from-source')
    $child=[Diagnostics.Process]::Start($info)
    $stdout=$child.StandardOutput.ReadToEndAsync();$stderr=$child.StandardError.ReadToEndAsync()
    $child.WaitForExit()
    if($child.ExitCode -ne 0){throw 'Native option parser failed'}
    $buildFromSource=($stdout.GetAwaiter().GetResult()|ConvertFrom-Json).buildFromSource
    [void]$stderr.GetAwaiter().GetResult();$child.Dispose()
}
Assert-WithNegative $buildFromSource $false 'false' 'native parser boolean false'
$proof=@{timestamp=(Get-Date -Format s);mode=$Mode;requirements=@('TEST-QB-055','P1 command-chain policy');testSha256=$testHash;cases=$cases.Count;checks=$checks;negativeControls=$negative;failed=0;skipped=0;details=@($cases.ToArray());implementationSha256=if($Mode -eq 'Implementation'){(Get-FileHash "$RepositoryRoot/qbrain/build/VscodeDependencies.psm1").Hash}else{$null};phaseAccepted=$false}
$proof|ConvertTo-Json -Depth 10|Set-Content "$receipt/dependencies-$($Mode.ToLowerInvariant()).json" -Encoding utf8NoBOM
$proof|Select-Object timestamp,mode,cases,checks,negativeControls,failed,skipped,testSha256,implementationSha256|ConvertTo-Json
