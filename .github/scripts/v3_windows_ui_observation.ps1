function New-SourceOfferObservation {
    param([bool]$OwnedButton, [string]$HelpText, [bool]$OwnedVisibleTooltip, [string]$TooltipText)
    $expected = 'Download the corresponding source for v3.0.0 (GNU AGPL v3).'
    $accessible = $OwnedButton -and $HelpText -ceq $expected
    $displayed = $OwnedButton -and $OwnedVisibleTooltip -and $TooltipText -ceq $expected
    return [ordered]@{
        status = $(if ($displayed) { 'OBSERVED_OWNED_TOOLTIP' } elseif ($accessible) { 'OBSERVED_UIA_HELPTEXT' } else { 'NOT_OBSERVED' })
        release = $(if ($accessible -or $displayed) { '3.0.0' } else { $null })
        accessible_release_observed = [bool]$accessible
        displayed_release_observed = [bool]$displayed
        scope = 'Frontend source-offer release text; does not establish native About version'
        native_about = 'NOT_OBSERVED'
    }
}
