$ErrorActionPreference = 'Stop'
# Exercise real classification; neither Windows UIA nor native app execution is used.
. (Join-Path $PSScriptRoot 'v3_windows_ui_observation.ps1')
$exact = 'Download the corresponding source for v3.0.0 (GNU AGPL v3).'
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw 'Observation classification assertion failed' }
}
$gap = New-SourceOfferObservation -OwnedButton $false -HelpText $exact -OwnedVisibleTooltip $true -TooltipText $exact
Assert-Equal $gap.status 'NOT_OBSERVED'
Assert-Equal $gap.displayed_release_observed $false
$accessible = New-SourceOfferObservation -OwnedButton $true -HelpText $exact -OwnedVisibleTooltip $false -TooltipText ''
Assert-Equal $accessible.status 'OBSERVED_UIA_HELPTEXT'
Assert-Equal $accessible.accessible_release_observed $true
Assert-Equal $accessible.displayed_release_observed $false
$visible = New-SourceOfferObservation -OwnedButton $true -HelpText '' -OwnedVisibleTooltip $true -TooltipText $exact
Assert-Equal $visible.status 'OBSERVED_OWNED_TOOLTIP'
Assert-Equal $visible.displayed_release_observed $true
foreach ($wrong in @('3.0.0', ($exact + ' other'), 'Download the corresponding source for v2.0.0 (GNU AGPL v3).')) {
    $record = New-SourceOfferObservation -OwnedButton $true -HelpText $wrong -OwnedVisibleTooltip $true -TooltipText $wrong
    Assert-Equal $record.status 'NOT_OBSERVED'
    Assert-Equal $record.release $null
}
Assert-Equal $visible.native_about 'NOT_OBSERVED'
Assert-Equal $accessible.native_about 'NOT_OBSERVED'
'PASS: exact UI evidence classification; accessibility and displayed tooltip remain distinct'
