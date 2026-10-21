# SPDX-License-Identifier: Apache-2.0
function Invoke-QbrainVscodeCiTest {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][ValidateSet('Vitest','Unit','IntegrationRetry')][string]$Policy,
        [Parameter(Mandatory)][scriptblock]$RunAttempt,
        [Parameter(Mandatory)][scriptblock]$WaitBetweenAttempts
    )
    $limit=if($Policy -eq 'IntegrationRetry'){3}else{1}
    for($attempt=1;$attempt -le $limit;$attempt++){
        $code=1;$reason=$null
        try{
            $result=& $RunAttempt $attempt
            if($result -isnot [Collections.IDictionary] -or -not $result.Contains('exitCode') -or $result.exitCode -isnot [int]){throw 'Missing native exit code.'}
            $code=$result.exitCode
            if($code -ne 0){$reason="Test command failed with exit code $code."}
            if($code -eq 0 -and $Policy -ne 'IntegrationRetry'){
                $output=[string]$result.output
                if($Policy -eq 'Vitest'){
                    $output=[regex]::Replace($output,"`e\[[0-9;]*m",'')
                    $found=$output -cmatch 'Tests\s+[0-9]*[1-9][0-9]* (passed|failed)'
                }else{$found=$output -cmatch 'Pass:\s+[0-9]*[1-9][0-9]*'}
                if(-not $found){$code=1;$reason=if($Policy -eq 'Vitest'){'ERROR: vitest reported zero tests (possible silent skip).'}else{'ERROR: bun unit runner reported zero passing tests (possible silent skip).'}}
            }
        }catch{$code=1;$reason='Test command did not return a valid result.'}
        if($code -eq 0 -or $limit -eq 1){return @{exitCode=$code;attempts=$attempt;failureReason=$reason}}
        if($attempt -lt $limit){& $WaitBetweenAttempts 5}
    }
    return @{exitCode=1;attempts=$limit;failureReason='Extension integration tests failed after 3 attempts'}
}
Export-ModuleMember -Function Invoke-QbrainVscodeCiTest
