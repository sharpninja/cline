# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param([ValidateSet('Mock','Implementation')][string]$Mode='Mock',[Parameter(Mandatory)][string]$ReceiptPath)
$ErrorActionPreference='Stop'
$root=(Resolve-Path "$PSScriptRoot/../..").Path
if($Mode -eq 'Implementation'){Import-Module "$root/qbrain/build/VscodeDisplay.psm1" -Force}
$checks=0;$negatives=0
function Assert-DisplayResult {
    param($Expected,$Actual)
    if($Expected.code -cne $Actual.code -or $Expected.error -cne $Actual.error -or @($Expected.calls).Count -ne @($Actual.calls).Count){throw 'Display outcome or lifecycle differs.'}
    for($i=0;$i -lt $Expected.calls.Count;$i++){if($Expected.calls[$i] -cne $Actual.calls[$i]){throw 'Display lifecycle order differs.'}}
}
# Contract fixtures are independent of production and describe all observable calls.
$cases=@(
    @{name='reuse-linux';current=':1';linux=$true;start='ok';run='ok';want=@{code=0;error=$false;calls=@('run::1')}},
    @{name='reuse-linux-failure';current=':1';linux=$true;start='ok';run='fail';want=@{code=17;error=$false;calls=@('run::1')}},
    @{name='native-windows';current='';linux=$false;start='ok';run='ok';want=@{code=0;error=$false;calls=@('run:')}},
    @{name='native-windows-failure';current='';linux=$false;start='ok';run='fail';want=@{code=17;error=$false;calls=@('run:')}},
    @{name='owned-success';current='';linux=$true;start='ok';run='ok';want=@{code=0;error=$false;calls=@('start','run::93','stop:owned')}},
    @{name='owned-failure';current='';linux=$true;start='ok';run='fail';want=@{code=17;error=$false;calls=@('start','run::93','stop:owned')}},
    @{name='start-throws';current='';linux=$true;start='throw';run='ok';want=@{code=$null;error=$true;calls=@('start')}},
    @{name='invalid-display';current='';linux=$true;start='invalid';run='ok';want=@{code=$null;error=$true;calls=@('start','stop:owned')}},
    @{name='run-throws-owned';current='';linux=$true;start='ok';run='throw';want=@{code=$null;error=$true;calls=@('start','run::93','stop:owned')}},
    @{name='run-throws-reused';current=':2';linux=$true;start='ok';run='throw';want=@{code=$null;error=$true;calls=@('run::2')}}
)
foreach($case in $cases){
    if($Mode -eq 'Mock'){
        # Scripted transport frames are separate from the asserted outcomes.
        $frames=switch($case.name){
            'reuse-linux' {@('call:run::1','exit:0')}
            'reuse-linux-failure' {@('call:run::1','exit:17')}
            'native-windows' {@('call:run:','exit:0')}
            'native-windows-failure' {@('call:run:','exit:17')}
            'owned-success' {@('call:start','call:run::93','call:stop:owned','exit:0')}
            'owned-failure' {@('call:start','call:run::93','call:stop:owned','exit:17')}
            'start-throws' {@('call:start','error')}
            'invalid-display' {@('call:start','call:stop:owned','error')}
            'run-throws-owned' {@('call:start','call:run::93','call:stop:owned','error')}
            'run-throws-reused' {@('call:run::2','error')}
            default {throw 'Missing mock transport frames'}
        }
        $actual=@{code=$null;error=$false;calls=@()}
        foreach($frame in $frames){
            if($frame.StartsWith('call:')){$actual.calls+=,$frame.Substring(5)}
            elseif($frame.StartsWith('exit:')){$actual.code=[int]$frame.Substring(5)}
            elseif($frame -eq 'error'){$actual.error=$true}
            else{throw 'Unknown mock transport frame'}
        }
    }else{
        $calls=[Collections.Generic.List[string]]::new()
        $start={
            $calls.Add('start')
            if($case.start -eq 'throw'){throw 'Fixture start failure'}
            return @{name=$(if($case.start -eq 'invalid'){'bad'}else{':93'});token='owned'}
        }.GetNewClosure()
        $stop={param($owned);$calls.Add("stop:$($owned.token)")}.GetNewClosure()
        $run={param($display);$calls.Add("run:$display");if($case.run -eq 'throw'){throw 'Fixture run failure'};if($case.run -eq 'fail'){return 17};return 0}.GetNewClosure()
        $code=$null;$failed=$false
        try{$code=Invoke-QbrainDisplayScope -CurrentDisplay $case.current -LinuxHost $case.linux -StartDisplay $start -StopDisplay $stop -Run $run}catch{$failed=$true}
        $actual=@{code=$code;error=$failed;calls=@($calls.ToArray())}
    }
    Assert-DisplayResult $case.want $actual;$checks++
    foreach($field in @('code','error','calls')){
        $wrong=$case.want|ConvertTo-Json -Depth 8|ConvertFrom-Json -AsHashtable
        switch($field){code{$wrong.code=999};error{$wrong.error=-not $wrong.error};calls{$wrong.calls=@('unexpected')}}
        $rejected=$false;try{Assert-DisplayResult $case.want $wrong}catch{$rejected=$true}
        if(-not $rejected){throw "Negative control accepted: $($case.name)/$field"};$checks++;$negatives++
    }
}
$proof=@{timestamp=(Get-Date -Format s);mode=$Mode;requirement='TEST-QB-055';cases=$cases.Count;checks=$checks;negativeControls=$negatives;failed=0;skipped=0;testSha256=(Get-FileHash $PSCommandPath).Hash;phaseAccepted=$false}
$proof|ConvertTo-Json -Depth 8|Set-Content $ReceiptPath -Encoding utf8NoBOM
$proof|ConvertTo-Json
