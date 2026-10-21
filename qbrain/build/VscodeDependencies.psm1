# SPDX-License-Identifier: Apache-2.0
$ErrorActionPreference='Stop'

function Get-QbrainNativeInstallerEnvironment {
    param([Parameter(Mandatory)][Collections.IDictionary]$Environment)
    $clean=@{}
    foreach($key in $Environment.Keys){
        if(-not ([string]$key).StartsWith('npm_config_',[StringComparison]::OrdinalIgnoreCase)){$clean[[string]$key]=[string]$Environment[$key]}
    }
    return $clean
}

function Invoke-QbrainVscodeDependencySetup {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$RepositoryRoot,
        [Parameter(Mandatory)][string]$NodeVersion,
        [Parameter(Mandatory)][string]$Platform,
        [Parameter(Mandatory)][scriptblock]$RunCommand
    )
    if($Platform -notin @('linux','win32','darwin')){throw "Unsupported native platform: $Platform"}
    if($NodeVersion -notmatch '^v?(\d+)\.\d+\.\d+$' -or [int]$Matches[1] -lt 22){throw 'Node 22 or newer required'}
    $target=$NodeVersion.TrimStart('v')
    $root=[IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($RepositoryRoot))
    $comparison=if($IsWindows){[StringComparison]::OrdinalIgnoreCase}else{[StringComparison]::Ordinal}
    function Resolve-OwnedPath {
        param([string]$Path)
        $full=[IO.Path]::GetFullPath($Path)
        if(-not $full.StartsWith($root+[IO.Path]::DirectorySeparatorChar,$comparison)){throw "Dependency path escapes repository: $Path"}
        $current=$root
        foreach($segment in [IO.Path]::GetRelativePath($root,$full).Split([IO.Path]::DirectorySeparatorChar)){
            $current=Join-Path $current $segment
            if(-not (Test-Path -LiteralPath $current)){throw "Missing dependency entry: $current"}
            $item=Get-Item -LiteralPath $current -Force
            if($item.LinkType -in @('SymbolicLink','Junction')){$current=$item.ResolveLinkTarget($true).FullName}
            if(-not $current.StartsWith($root+[IO.Path]::DirectorySeparatorChar,$comparison)){throw "Dependency path escapes repository: $Path"}
        }
        return $current
    }
    function Find-OwnedPackage {
        param([string]$From,[string]$Name)
        $directory=$From
        while($directory -eq $root -or $directory.StartsWith($root+[IO.Path]::DirectorySeparatorChar,$comparison)){
            $candidate=Join-Path $directory "node_modules/$Name"
            if(Test-Path -LiteralPath $candidate){return Resolve-OwnedPath $candidate}
            if($directory -eq $root){break}
            $directory=Split-Path $directory -Parent
        }
        throw "Missing dependency entry: $Name"
    }
    $lock=Resolve-OwnedPath "$root/bun.lock"
    $lockHash=(Get-FileHash -LiteralPath $lock).Hash
    function Assert-Lockfile {
        if(-not (Test-Path -LiteralPath $lock) -or (Get-FileHash -LiteralPath $lock).Hash -cne $lockHash){throw 'Lockfile changed during dependency preparation'}
    }
    $install=[ordered]@{id='install';runtime='bun';cwd=$root;arguments=@('install','--frozen-lockfile','--ignore-scripts');nativeInstaller=$false}
    $code=[int](& $RunCommand $install)
    Assert-Lockfile
    if($code -ne 0){return @{exitCode=$code;artifacts=@();lockfileSha256=$lockHash}}

    $sqlite=Resolve-OwnedPath "$root/apps/vscode/node_modules/better-sqlite3"
    $grpc=Resolve-OwnedPath "$root/apps/vscode/node_modules/grpc-tools"
    $prebuild=Find-OwnedPackage $sqlite 'prebuild-install'
    $preGyp=Find-OwnedPackage $grpc '@mapbox/node-pre-gyp'
    $sqlitePackage=Get-Content (Resolve-OwnedPath "$sqlite/package.json") -Raw|ConvertFrom-Json
    $grpcPackage=Get-Content (Resolve-OwnedPath "$grpc/package.json") -Raw|ConvertFrom-Json
    $prebuildPackage=Get-Content (Resolve-OwnedPath "$prebuild/package.json") -Raw|ConvertFrom-Json
    $preGypPackage=Get-Content (Resolve-OwnedPath "$preGyp/package.json") -Raw|ConvertFrom-Json
    if($sqlitePackage.name -cne 'better-sqlite3' -or $sqlitePackage.scripts.install -cne 'prebuild-install || node-gyp rebuild --release' -or $grpcPackage.name -cne 'grpc-tools' -or $grpcPackage.scripts.install -cne 'node-pre-gyp install' -or $prebuildPackage.name -cne 'prebuild-install' -or $preGypPackage.name -cne '@mapbox/node-pre-gyp'){
        throw 'Unreviewed package contract; review the pinned dependency setup before executing it'
    }
    $preGypBin=if($preGypPackage.bin -is [string]){$preGypPackage.bin}else{$preGypPackage.bin.'node-pre-gyp'}
    $prebuildEntry=Resolve-OwnedPath (Join-Path $prebuild $prebuildPackage.bin)
    $preGypEntry=Resolve-OwnedPath (Join-Path $preGyp $preGypBin)
    $steps=@(
        [ordered]@{id='sqlite';runtime='node';cwd=$sqlite;arguments=@($prebuildEntry,'--runtime=node',"--target=$target",'--no-build-from-source');nativeInstaller=$true},
        [ordered]@{id='grpc';runtime='node';cwd=$grpc;arguments=@($preGypEntry,'install','--no-build-from-source','--no-fallback-to-build');nativeInstaller=$true}
    )
    foreach($step in $steps){
        $code=[int](& $RunCommand $step)
        Assert-Lockfile
        if($code -ne 0){return @{exitCode=$code;artifacts=@();lockfileSha256=$lockHash}}
    }
    $extension=if($Platform -eq 'win32'){'.exe'}else{''}
    $artifacts=@("$sqlite/build/Release/better_sqlite3.node","$grpc/bin/protoc$extension","$grpc/bin/grpc_node_plugin$extension")
    foreach($artifact in $artifacts){
        if(-not (Test-Path -LiteralPath $artifact -PathType Leaf)){throw "Missing native artifact: $artifact"}
        [void](Resolve-OwnedPath $artifact)
    }
    return @{exitCode=0;artifacts=$artifacts;lockfileSha256=$lockHash;packages=@($sqlitePackage,$grpcPackage,$prebuildPackage,$preGypPackage)|ForEach-Object {@{name=$_.name;version=$_.version}}}
}

Export-ModuleMember -Function Invoke-QbrainVscodeDependencySetup,Get-QbrainNativeInstallerEnvironment
