$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'windows_ui_ownership.ps1')
function Assert-True($Value) { if (-not $Value) { throw 'Ownership control failed' } }
function Record([int]$Id,[int]$Parent,[long]$Birth,[string]$Image='system',[string]$Sid='synthetic-sid',[int]$Session=1) {
    return @{ Pid=$Id; Parent=$Parent; Birth=$Birth; Image=$Image; Sid=$Sid; Session=$Session; Native=$true; VendorTrusted=$true; FileIdentity="file-$Id" }
}
$rows=@{10=(Record 10 1 100 'main');20=(Record 20 10 200);30=(Record 30 20 300)}
$root=$rows[10]
$read={param($id) if (-not $rows.ContainsKey([int]$id)) { throw 'UNAVAILABLE' };return $rows[[int]$id]}
$assert={return $true}
$good=Test-V3ProcessOwner -CandidatePid 30 -Root $root -ReadProcess $read -AssertMain $assert
Assert-True $good.Allowed
Assert-True ($good.Diagnostic.status -eq 'PROVEN_OWNED_WEBVIEW2')
foreach($change in @('WrongSid','WrongSession','Unrelated','Unsigned','WrongNative','ParentReused','Cycle')) {
    $old=$rows[30].Clone();$parentOld=$rows[20].Clone()
    switch($change) {
        WrongSid {$rows[30].Sid='foreign'}
        WrongSession {$rows[30].Session=2}
        Unrelated {$rows[20].Parent=1}
        Unsigned {$rows[30].VendorTrusted=$false}
        WrongNative {$rows[30].Native=$false}
        ParentReused {$rows[20].Birth=400}
        Cycle {$rows[20].Parent=30}
    }
    Assert-True (-not (Test-V3ProcessOwner -CandidatePid 30 -Root $root -ReadProcess $read -AssertMain $assert).Allowed)
    $rows[30]=$old;$rows[20]=$parentOld
}
Assert-True (-not (Test-V3ProcessOwner -CandidatePid 0 -Root $root -ReadProcess $read -AssertMain $assert).Allowed)
Assert-True (Test-V3CachedOwner $good $read)
$rows[30].Birth=301
Assert-True (-not (Test-V3CachedOwner $good $read))
$gap=New-V3UiObservation -SourceShowing $true -TooltipShowing $false -TooltipExact $true -DescriptionExact $true
Assert-True (-not $gap.displayed_release_observed)
$match=New-V3UiObservation -SourceShowing $true -TooltipShowing $true -TooltipExact $true -DescriptionExact $false
Assert-True $match.displayed_release_observed
Assert-True ($match.native_about -eq 'NOT_OBSERVED')
Assert-True (Test-V3HelpClickProof $true $true $true $true $true $true)
for($i=0;$i -lt 6;$i++) {
    $facts=@($true,$true,$true,$true,$true,$true);$facts[$i]=$false
    Assert-True (-not (Test-V3HelpClickProof $facts[0] $facts[1] $facts[2] $facts[3] $facts[4] $facts[5]))
}
$windows=@{100=@{Pid=30;Owner=200;RootOwner=300};200=@{Pid=20;Owner=300;RootOwner=300};300=@{Pid=10;Owner=0;RootOwner=300}}
$readWindow={param([long]$Handle) if(-not $windows.ContainsKey([int]$Handle)){throw 'UNAVAILABLE'};return $windows[[int]$Handle]}
$ownerProof={param([int]$Id) return $Id -in @(10,20,30)}
$popup=Test-V3PopupChain 100 300 30 $readWindow $ownerProof
Assert-True ($popup.process_proven -and $popup.owner_chain -and $popup.root_owner)
foreach($change in @('Foreign','NoOwner','WrongRootOwner','Cycle','WindowPidMismatch')) {
    $old=$windows[100].Clone();$next=$windows[200].Clone()
    switch($change) {
        Foreign {$windows[200].Pid=99}
        NoOwner {$windows[100].Owner=0}
        WrongRootOwner {$windows[100].RootOwner=999}
        Cycle {$windows[200].Owner=100}
        WindowPidMismatch {$windows[100].Pid=20}
    }
    $bad=Test-V3PopupChain 100 300 30 $readWindow $ownerProof
    Assert-True (-not ($bad.process_proven -and $bad.owner_chain -and $bad.root_owner))
    $windows[100]=$old;$windows[200]=$next
}
Assert-True (-not (Test-V3PopupChain 0 300 30 $readWindow $ownerProof).process_proven)
# A nameless ToolTip can expose exact visible text through its owned Text child.
Assert-True (Test-V3TooltipTextProof $true $true $true $false $true $true $true $true $true $true)
# Every child proof is required: hidden label, zero bounds, wrong role/parent,
# foreign label, wrong title, and foreign/hidden container all remain gaps.
foreach($index in @(0,1,2,4,5,6,7,8,9)) {
    $facts=@($true,$true,$true,$false,$true,$true,$true,$true,$true,$true);$facts[$index]=$false
    Assert-True (-not (Test-V3TooltipTextProof $facts[0] $facts[1] $facts[2] $facts[3] $facts[4] $facts[5] $facts[6] $facts[7] $facts[8] $facts[9]))
}
Assert-True (Test-V3TooltipTextProof $true $true $true $true $false $false $false $false $false $false)
# Source HelpText alone supplies no ToolTip container or child proof.
Assert-True (-not (Test-V3TooltipTextProof $false $false $false $false $false $false $false $false $false $false))
'PASS: child ownership, identity changes, Help pointer guards, owned-popup chains, actual-tooltip classification'
