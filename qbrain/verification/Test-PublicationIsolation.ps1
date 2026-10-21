# SPDX-License-Identifier: Apache-2.0
# TEST-QB-056: pre-push publication isolation. This does not dispatch workflows.
[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateSet('Mock','Source')][string]$Mode='Mock',
    [string]$RepositoryPath=(Split-Path (Split-Path $PSScriptRoot -Parent) -Parent),
    [string]$ReceiptPath
)
$ErrorActionPreference='Stop'
if(-not $PSCmdlet.ShouldProcess('Publication isolation assertions',"Run $Mode provider and optionally save its receipt")){return}
$targets=@(
    @{file='cli-publish.yml';job='publish-main'},
    @{file='cli-publish.yml';job='publish-nightly'},
    @{file='desktop-publish.yml';job='release'},
    @{file='desktop-publish.yml';job='announce-nightly'},
    @{file='ext-vscode-ab-package.yml';job='publish'},
    @{file='ext-vscode-publish-legacy.yml';job='publish'},
    @{file='ext-vscode-publish-nightly.yml';job='publish'},
    @{file='ext-vscode-publish-stable.yml';job='publish'},
    @{file='ext-vscode-publish.yml';job='publish'},
    @{file='sdk-publish.yml';job='publish-sdk'},
    @{file='ui-publish.yml';job='publish'}
)
function Test-BlockingRepositoryCondition {
    param([object]$Condition)
    if($Condition -is [bool]){return -not $Condition}
    $expression=([string]$Condition).Trim()
    if($expression.StartsWith('${{') -and $expression.EndsWith('}}')){$expression=$expression.Substring(3,$expression.Length-5).Trim()}
    if($expression -eq 'false'){return $true}
    # A necessary conjunct excludes this derivative regardless of inputs,
    # events, secrets, branch or downstream functions. Reject an outer OR escape.
    $depth=0;$quoted=$false;$start=0
    $conjuncts=[Collections.Generic.List[string]]::new()
    for($i=0;$i -lt $expression.Length;$i++){
        $char=$expression[$i]
        if($char -eq "'"){
            if($quoted -and $i+1 -lt $expression.Length -and $expression[$i+1] -eq "'"){$i++;continue}
            $quoted=-not $quoted;continue
        }
        if($quoted){continue}
        if($char -eq '('){$depth++}
        if($char -eq ')'){$depth--;if($depth -lt 0){return $false}}
        if($depth -eq 0 -and $char -eq '|' -and $i+1 -lt $expression.Length -and $expression[$i+1] -eq '|'){return $false}
        if($depth -eq 0 -and $char -eq '&' -and $i+1 -lt $expression.Length -and $expression[$i+1] -eq '&'){
            $conjuncts.Add($expression.Substring($start,$i-$start).Trim())
            $start=$i+2;$i++
        }
    }
    if($depth -ne 0 -or $quoted){return $false}
    $conjuncts.Add($expression.Substring($start).Trim())
    if(@($conjuncts|Where-Object {$_ -eq ''}).Count){return $false}
    return (@($conjuncts|Where-Object {$_ -match "^github\.repository\s*==\s*'cline/cline'$"}).Count -gt 0)
}
function Test-BlockedJob {
    param([hashtable]$Jobs,[string]$JobName,[string[]]$Visited=@())
    if(-not $Jobs.ContainsKey($JobName) -or $JobName -in $Visited){return $false}
    $job=$Jobs[$JobName]
    if(Test-BlockingRepositoryCondition $job.if){return $true}
    # GitHub skips downstream jobs when a required job was skipped unless an
    # explicit status condition overrides the default success() prerequisite.
    if(([string]$job.if) -match '\b(always|cancelled|failure|success)\s*\('){return $false}
    foreach($dependency in @($job.needs)){
        if($dependency -and (Test-BlockedJob $Jobs $dependency (@($Visited)+$JobName))){return $true}
    }
    return $false
}
function Get-IsolationFailure {
    param([hashtable]$Workflows)
    $required=[Collections.Generic.Dictionary[string,object]]::new([StringComparer]::Ordinal)
    foreach($target in $targets){
        $required["$($target.file):$($target.job)"]=$target
    }
    # Reject newly introduced release steps as well as regressions in known jobs.
    foreach($file in $Workflows.Keys){
        foreach($jobName in $Workflows[$file].jobs.Keys){
            $job=$Workflows[$file].jobs[$jobName]
            $publishes=@($job.steps|Where-Object {
                $_ -and (
                    $_.uses -match '(?i)action-gh-release|release-action|publish|deploy' -or
                    $_.run -match '(?im)^\s*(npm|pnpm|yarn|bunx)\s+publish\b|\b(vsce|ovsx)\s+publish\b|\bgh\s+release\s+(create|upload|edit)\b|\bgit\s+push\b|publish-npm\.(ts|js)'
                )
            })
            if($publishes.Count){$required["${file}:$jobName"]=@{file=$file;job=$jobName}}
        }
    }
    foreach($target in $required.Values){
        if(-not $Workflows.ContainsKey($target.file) -or -not (Test-BlockedJob $Workflows[$target.file].jobs $target.job)){
            Write-Output "$($target.file):$($target.job)"
        }
    }
}
function Copy-Fixture {
    param([hashtable]$Value)
    return ($Value|ConvertTo-Json -Depth 30|ConvertFrom-Json -AsHashtable)
}
$checks=0;$negativeControls=0;$failures=@();$files=@()
if($Mode -eq 'Mock'){
    $valid=@{}
    foreach($target in $targets){
        if(-not $valid.ContainsKey($target.file)){$valid[$target.file]=@{jobs=@{}}}
        $valid[$target.file].jobs[$target.job]=@{if="github.repository == 'cline/cline' && (inputs.publish == true || github.event_name == 'schedule')"}
    }
    if(@(Get-IsolationFailure $valid).Count){throw 'Correct independent fixtures were rejected.'}
    $checks+=$targets.Count
    $nonleading=Copy-Fixture $valid
    $nonleading['ui-publish.yml'].jobs.publish.if="github.event_name == 'workflow_dispatch' && github.repository == 'cline/cline' && !endsWith(github.actor, '[bot]')"
    if(@(Get-IsolationFailure $nonleading).Count){throw 'A necessary non-leading repository conjunct was rejected.'}
    $checks++
    foreach($target in $targets){
        $wrong=Copy-Fixture $valid
        $wrong[$target.file].jobs[$target.job].if="inputs.publish == true"
        if("$($target.file):$($target.job)" -notin @(Get-IsolationFailure $wrong)){throw 'Unguarded publication was not detected.'}
        $checks++;$negativeControls++
    }
    foreach($bad in @("github.repository == 'cline/cline' || true","inputs.publish == true && github.repository == 'sharpninja/cline'","'github.repository == ''cline/cline'''","github.repository == 'cline/cline' && true || always()","github.repository == 'cline/cline' && (true",'always()')){
        $wrong=Copy-Fixture $valid
        $wrong['ext-vscode-publish.yml'].jobs.publish.if=$bad
        if('ext-vscode-publish.yml:publish' -notin @(Get-IsolationFailure $wrong)){throw "Unsafe condition accepted: $bad"}
        $checks++;$negativeControls++
    }
    $inherited=Copy-Fixture $valid
    $inherited['desktop-publish.yml'].jobs.validate=@{if="github.repository == 'cline/cline'"}
    $inherited['desktop-publish.yml'].jobs.release=@{needs='validate';if="needs.validate.outputs.channel != 'nightly'"}
    if(@(Get-IsolationFailure $inherited).Count){throw 'Required skipped dependency was not recognized.'}
    $checks++
    $inherited['desktop-publish.yml'].jobs.release.if='always()'
    if('desktop-publish.yml:release' -notin @(Get-IsolationFailure $inherited)){throw 'always() dependency bypass was not detected.'}
    $checks++;$negativeControls++
    $missing=Copy-Fixture $valid
    $missing.Remove('ui-publish.yml')
    if('ui-publish.yml:publish' -notin @(Get-IsolationFailure $missing)){throw 'Missing workflow was accepted.'}
    $checks++;$negativeControls++
    $missing=Copy-Fixture $valid
    $missing['ui-publish.yml'].jobs.Remove('publish')
    if('ui-publish.yml:publish' -notin @(Get-IsolationFailure $missing)){throw 'Missing publication job was accepted.'}
    $checks++;$negativeControls++
    foreach($step in @(@{run='npm publish'},@{uses='softprops/action-gh-release@v1'})){
        $additional=Copy-Fixture $valid
        $additional['ui-publish.yml'].jobs.surprise=@{steps=@($step)}
        if('ui-publish.yml:surprise' -notin @(Get-IsolationFailure $additional)){throw 'New unguarded publication step escaped inventory validation.'}
        $checks++;$negativeControls++
    }
}else{
    Import-Module powershell-yaml
    $workflows=@{}
    foreach($file in @(Get-ChildItem "$RepositoryPath/.github/workflows" -File|Where-Object Extension -in @('.yml','.yaml'))){
        $workflows[$file.Name]=Get-Content $file.FullName -Raw|ConvertFrom-Yaml
        $files+=@{name=$file.Name;sha256=(Get-FileHash $file.FullName).Hash}
    }
    if($workflows.Count -ne 18){throw 'Workflow inventory changed; inspect all workflows and reconcile publication targets.'}
    $failures=@(Get-IsolationFailure $workflows)
    $checks=$targets.Count
}
$result=@{timestamp=(Get-Date -Format s);requirement='AC-QB-056';test='TEST-QB-056';scope='Pre-push publication jobs only; runtime updater and installed-artifact acceptance are separate';mode=$Mode;checks=$checks;passed=$checks-$failures.Count;failed=$failures.Count;skipped=0;negativeControls=$negativeControls;failures=$failures;sourceFiles=$files;testSha256=(Get-FileHash $PSCommandPath).Hash;workflowDispatches=0}
if($ReceiptPath){$result|ConvertTo-Json -Depth 15|Set-Content $ReceiptPath -Encoding utf8NoBOM}
$result|Select-Object timestamp,mode,checks,passed,failed,skipped,negativeControls,failures,testSha256|ConvertTo-Json -Depth 10
if($failures.Count){throw 'Publication isolation is not established for every inventoried publication job.'}
