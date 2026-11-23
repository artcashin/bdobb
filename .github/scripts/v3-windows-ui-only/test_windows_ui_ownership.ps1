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

# Window-fit controls run in the existing mandatory portable ownership suite.
function Assert-Fit($Value){if(-not $Value){throw 'WINDOW_FIT_CONTROL_FAILED'}}
function Rectangle([long]$L,[long]$T,[long]$R,[long]$B){return @{left=$L;top=$T;right=$R;bottom=$B}}
$work=Rectangle 0 0 1280 720
$small=Rectangle 100 80 1000 680
$fit=Get-V3WindowFitPlan $small $work $true
Assert-Fit ($fit.action -ceq 'ALREADY_FITS')
Assert-Fit ($fit.target.left -eq 100 -and $fit.target.bottom -eq 680)
$large=Rectangle 100 100 1300 1000
$fit=Get-V3WindowFitPlan $large $work $true
Assert-Fit ($fit.action -ceq 'FIT_REQUIRED')
Assert-Fit ($fit.target.left -eq 80 -and $fit.target.top -eq 0 -and $fit.target.right -eq 1280 -and $fit.target.bottom -eq 720)
$outside=Get-V3WindowFitPlan (Rectangle -500 -100 -100 200) $work $true
Assert-Fit ($outside.target.left -eq 0 -and $outside.target.top -eq 0 -and $outside.target.right -eq 400 -and $outside.target.bottom -eq 300)
$negative=Get-V3WindowFitPlan (Rectangle -2200 20 -1000 920) (Rectangle -1920 0 0 1080) $true
Assert-Fit ($negative.target.left -eq -1920 -and $negative.target.right -eq -720 -and $negative.target.bottom -eq 920)
foreach($case in @('Foreign','ZeroWindow','InvertedWork','MissingEdge','StringEdge','Excessive','Fractional')){
 $rect=Rectangle 0 0 500 500;$area=$work.Clone();$owned=$true
 switch($case){
  Foreign {$owned=$false}
  ZeroWindow {$rect.right=0}
  InvertedWork {$area.bottom=-1}
  MissingEdge {$rect.Remove('left')}
  StringEdge {$rect.left='0'}
  Excessive {$rect.right=20001}
  Fractional {$rect.left=0.5}
 }
 $rejected=$false
 try{[void](Get-V3WindowFitPlan $rect $area $owned)}catch{$rejected=$true}
 Assert-Fit $rejected
}
Assert-Fit (Test-V3WindowContained (Rectangle 0 0 1280 720) $work)
# Simulate the application's minimum-size refusal: the requested fit target
# is safe, but the actual returned 900px-tall window must remain rejected.
Assert-Fit (-not (Test-V3WindowContained (Rectangle 0 0 1200 900) $work))
Assert-Fit (-not (Test-V3WindowContained $large $work))
'PASS: bounded same-window fit, containment, foreign and malformed refusal'
