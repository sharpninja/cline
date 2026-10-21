# SPDX-License-Identifier: Apache-2.0
function Invoke-QbrainDisplayScope {
    [CmdletBinding()]
    param(
        [AllowEmptyString()][string]$CurrentDisplay,
        [bool]$LinuxHost,
        [Parameter(Mandatory)][scriptblock]$StartDisplay,
        [Parameter(Mandatory)][scriptblock]$StopDisplay,
        [Parameter(Mandatory)][scriptblock]$Run
    )
    if($CurrentDisplay -or -not $LinuxHost){return (& $Run $CurrentDisplay)}
    $owned=& $StartDisplay
    try {
        if(-not $owned -or $owned.name -notmatch '^:[0-9]+(?:\.[0-9]+)?$'){throw 'Xvfb did not return a valid display number.'}
        return (& $Run $owned.name)
    }finally{if($owned){& $StopDisplay $owned}}
}
Export-ModuleMember -Function Invoke-QbrainDisplayScope
