param([int]$AppPid,[string]$Executable,[string]$ExpectedSha256,[string]$Evidence)
$ErrorActionPreference='Stop'
if($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows' -or
   $env:RUNNER_ARCH -ne 'X64' -or -not [Environment]::Is64BitProcess){throw 'ERROR_HOST_GUARD'}
. (Join-Path $PSScriptRoot 'windows_ui_ownership.ps1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;using System.Runtime.InteropServices;
public static class V3Pointer {
 [StructLayout(LayoutKind.Sequential)]public struct Point{public int X,Y;}
 [DllImport("user32.dll")]public static extern bool GetCursorPos(out Point p);
 [DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(Point p);
 [DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr w,uint flag);
 [DllImport("user32.dll")]public static extern IntPtr GetWindow(IntPtr w,uint command);
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr w,out uint pid);
 [DllImport("user32.dll")]public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
}
'@
if($ExpectedSha256 -cnotmatch '^[0-9a-f]{64}$'){throw 'ERROR_MAIN_IDENTITY'}
$script:ExpectedImage=[IO.Path]::GetFullPath($Executable)
$script:Root=Read-V3NativeProcess $AppPid
$ownSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if($script:Root.Sid -cne $ownSid -or $script:Root.Session -ne [Diagnostics.Process]::GetCurrentProcess().SessionId){throw 'ERROR_MAIN_IDENTITY'}
function Assert-V3Main {
    $now=Read-V3NativeProcess $AppPid
    if(-not $now.Native -or $now.FileIdentity -cne $script:Root.FileIdentity -or $now.Birth -ne $script:Root.Birth -or $now.Sid -cne $script:Root.Sid -or $now.Session -ne $script:Root.Session -or
       -not [String]::Equals($now.Image,$script:ExpectedImage,[StringComparison]::OrdinalIgnoreCase) -or
       (Get-FileHash -LiteralPath $script:ExpectedImage -Algorithm SHA256).Hash.ToLowerInvariant() -cne $ExpectedSha256){throw 'ERROR_MAIN_IDENTITY'}
    return $true
}
[void](Assert-V3Main)
$condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$AppPid)
$window=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,$condition)
if(-not $window){throw 'GAP_ROOT_WINDOW_UNAVAILABLE'}
$script:RootHandle=[IntPtr]$window.Current.NativeWindowHandle
function Assert-V3Window {
    [void](Assert-V3Main);$id=[uint32]0
    [void][V3Pointer]::GetWindowThreadProcessId($script:RootHandle,[ref]$id)
    if($script:RootHandle -eq [IntPtr]::Zero -or $id -ne $AppPid){throw 'ERROR_MAIN_IDENTITY'}
}
Assert-V3Window
$script:Deadline=[DateTime]::UtcNow.AddSeconds(12)
$script:Visited=0;$script:Proofs=@{};$script:HelpFacts=@();$script:PopupFacts=@();$script:AcceptedPopup=$null;$script:Attempt='HELP_CONTROL_UNAVAILABLE';$script:Stage='HELP_FIND';$script:Activation='NONE'
function Test-V3PidOwner([int]$id,[switch]$Fresh) {
    if([DateTime]::UtcNow -gt $script:Deadline){throw 'GAP_UI_BUDGET'}
    if($id -eq $AppPid){return $true}
    if(-not $script:Proofs.ContainsKey($id) -or $Fresh) {
        if(-not $script:Proofs.ContainsKey($id) -and $script:Proofs.Count -ge 8){return $false}
        $proof=Test-V3ProcessOwner -CandidatePid $id -Root $script:Root -ReadProcess ${function:Read-V3NativeProcess} -AssertMain ${function:Assert-V3Main}
        $script:Proofs[$id]=$proof
    }
    return (Test-V3CachedOwner $script:Proofs[$id] ${function:Read-V3NativeProcess})
}
function Test-V3ElementOwner($Element,[switch]$Fresh) {
    return (Test-V3PidOwner $Element.Current.ProcessId -Fresh:$Fresh)
}
function Test-V3VisibleBounds($Element) {
    $bounds=$Element.Current.BoundingRectangle
    return -not $Element.Current.IsOffscreen -and -not $bounds.IsEmpty -and
        $bounds.Width -gt 0 -and $bounds.Height -gt 0 -and $bounds.Width -le 20000 -and $bounds.Height -le 20000
}
function Test-V3TooltipResult($Result) {
    $container=$Result.Container;$label=$Result.Label
    $containerOwned=Test-V3ElementOwner $container -Fresh
    if(-not $containerOwned -or $container.Current.ControlType -ne [System.Windows.Automation.ControlType]::ToolTip){return $false}
    $containerVisible=-not $container.Current.IsOffscreen;$containerBounds=Test-V3VisibleBounds $container
    $containerExact=$container.Current.Name -ceq $script:V3ExactSourceText
    $labelOwned=$false;$labelVisible=$false;$labelBounds=$false;$labelText=$false;$labelDescendant=$false;$labelExact=$false
    if($label) {
        $labelOwned=Test-V3ElementOwner $label -Fresh
        if($labelOwned) {
            $labelVisible=-not $label.Current.IsOffscreen;$labelBounds=Test-V3VisibleBounds $label
            $labelText=$label.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text
            $labelExact=$label.Current.Name -ceq $script:V3ExactSourceText
            $ancestor=$label;$walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
            for($depth=0;$ancestor -and $depth -lt 16;$depth++) {
                if([System.Windows.Automation.Automation]::Compare($ancestor,$container)){$labelDescendant=$true;break}
                if(-not (Test-V3ElementOwner $ancestor -Fresh)){break}
                $ancestor=$walker.GetParent($ancestor)
            }
        }
    }
    return (Test-V3TooltipTextProof $containerOwned $containerVisible $containerBounds $containerExact $labelOwned $labelVisible $labelBounds $labelText $labelDescendant $labelExact)
}
function Find-V3TooltipLabel($Container) {
    $queue=New-Object 'Collections.Generic.Queue[object]';$queue.Enqueue($Container)
    $walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
    while($queue.Count -gt 0) {
        if($script:Visited -ge 256 -or [DateTime]::UtcNow -gt $script:Deadline){throw 'GAP_UI_BUDGET'}
        $node=$queue.Dequeue();$script:Visited++
        if(-not (Test-V3ElementOwner $node)){continue}
        if($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::Text -and
            $node.Current.Name -ceq $script:V3ExactSourceText -and (Test-V3VisibleBounds $node)){return $node}
        $child=$walker.GetFirstChild($node);$count=0
        while($child){if($count++ -ge 32){throw 'GAP_UI_BUDGET'};$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
        if($queue.Count -gt 256){throw 'GAP_UI_BUDGET'}
    }
    return $null
}
function Find-V3Owned([string[]]$Names,[switch]$Tooltip,$SearchRoot=$window) {
    $queue=New-Object 'Collections.Generic.Queue[object]';$queue.Enqueue($SearchRoot)
    $walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
    while($queue.Count -gt 0) {
        if($script:Visited -ge 256 -or [DateTime]::UtcNow -gt $script:Deadline){throw 'GAP_UI_BUDGET'}
        $node=$queue.Dequeue();$script:Visited++
        if(-not (Test-V3ElementOwner $node)){continue}
        if($Tooltip) {
            if($node.Current.ControlType -eq [System.Windows.Automation.ControlType]::ToolTip -and (Test-V3VisibleBounds $node)) {
                $result=@{Container=$node;Label=$null}
                if($node.Current.Name -cne $script:V3ExactSourceText){$result.Label=Find-V3TooltipLabel $node}
                if(Test-V3TooltipResult $result){return $result}
            }
        } elseif($Names -ccontains $node.Current.Name -and -not $node.Current.IsOffscreen) {
            return $node
        }
        $child=$walker.GetFirstChild($node);$count=0
        while($child) {if($count++ -ge 32){throw 'GAP_UI_BUDGET'};$queue.Enqueue($child);$child=$walker.GetNextSibling($child)}
        if($queue.Count -gt 256){throw 'GAP_UI_BUDGET'}
    }
    return $null
}
function Test-V3PopupWindow($Popup) {
    $id=$Popup.Current.ProcessId;$handle=[IntPtr]$Popup.Current.NativeWindowHandle
    $fact=@{pid=[int]$id;control_type=[int]$Popup.Current.ControlType.Id;native_handle=($handle -ne [IntPtr]::Zero);process_proven=$false;owner_chain=$false;root_owner=$false}
    $proof=Test-V3PopupChain -Handle $handle.ToInt64() -RootHandle $script:RootHandle.ToInt64() -PopupPid $id -ReadWindow {
        param([long]$WindowHandle)
        $native=[IntPtr]$WindowHandle;$ownerPid=[uint32]0
        [void][V3Pointer]::GetWindowThreadProcessId($native,[ref]$ownerPid)
        return @{Pid=[int]$ownerPid;Owner=[V3Pointer]::GetWindow($native,4).ToInt64();RootOwner=[V3Pointer]::GetAncestor($native,3).ToInt64()}
    } -OwnerProof {param([int]$ProcessId) Test-V3PidOwner $ProcessId -Fresh}
    foreach($key in @('process_proven','owner_chain','root_owner')){$fact[$key]=$proof[$key]}
    if($script:PopupFacts.Count -lt 8){$script:PopupFacts+=$fact}
    return $fact.process_proven -and $fact.owner_chain -and $fact.root_owner
}
function Find-V3OwnedPopupTooltip {
    $walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
    $popup=$walker.GetFirstChild([System.Windows.Automation.AutomationElement]::RootElement)
    for($count=0;$popup -and $count -lt 64;$count++) {
        if($script:Visited -ge 256 -or [DateTime]::UtcNow -gt $script:Deadline){throw 'GAP_UI_BUDGET'}
        $script:Visited++
        if(-not [System.Windows.Automation.Automation]::Compare($popup,$window) -and (Test-V3PopupWindow $popup)) {
            # No popup text/state/descendants are read before both native owner
            # chains and the same-SID/session/process proof reach the root HWND.
            $candidate=Find-V3Owned @($script:V3ExactSourceText) -Tooltip -SearchRoot $popup
            if($candidate){$script:AcceptedPopup=$popup;return $candidate}
        }
        $popup=$walker.GetNextSibling($popup)
    }
    return $null
}
function Get-V3OwnedPoint($Element) {
    if(-not (Test-V3ElementOwner $Element -Fresh) -or $Element.Current.IsOffscreen){throw 'GAP_ELEMENT_OWNER'}
    $b=$Element.Current.BoundingRectangle
    if($b.IsEmpty -or $b.Width -le 0 -or $b.Height -le 0 -or $b.Width -gt 20000 -or $b.Height -gt 20000){throw 'GAP_POINTER_BOUNDS'}
    $p=New-Object V3Pointer+Point;$p.X=[int]($b.Left+$b.Width/2);$p.Y=[int]($b.Top+$b.Height/2)
    Assert-V3Window
    if([V3Pointer]::GetAncestor([V3Pointer]::WindowFromPoint($p),2) -ne $script:RootHandle){throw 'GAP_POINTER_WINDOW'}
    return $p
}
$saved=New-Object V3Pointer+Point;$savedOk=$false;$opened=$false;$help=$null;$sourceShowing=$false;$description=$false;$tipShowing=$false;$tipExact=$false;$cleanup='NOT_OPENED'
try {
    $help=Find-V3Owned 'Help'
    if($help) {
        $script:Stage='HELP_ACTIVATION'
        $invoke=$null;$hasInvoke=$help.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)
        $script:HelpFacts+=@{control_type=[int]$help.Current.ControlType.Id;pattern_mask=$(if($hasInvoke){1}else{0});visible=$true;owned=$true}
        Assert-V3Window
        if(-not (Test-V3ElementOwner $help -Fresh) -or $help.Current.Name -cne 'Help' -or $help.Current.IsOffscreen){throw 'GAP_ELEMENT_OWNER'}
        if($hasInvoke){$invoke.Invoke();$opened=$true;$script:Activation='INVOKE_PATTERN'}
        else {
            $point=Get-V3OwnedPoint $help;$savedOk=[V3Pointer]::GetCursorPos([ref]$saved)
            if(-not $savedOk -or -not [V3Pointer]::SetCursorPos($point.X,$point.Y)){throw 'GAP_POINTER_UNAVAILABLE'}
            Assert-V3Window;$fresh=Get-V3OwnedPoint $help;$cursor=New-Object V3Pointer+Point
            $cursorOk=[V3Pointer]::GetCursorPos([ref]$cursor)
            $hit=[System.Windows.Automation.AutomationElement]::FromPoint((New-Object System.Windows.Point($point.X,$point.Y)))
            $exactHit=$false;$walker=[System.Windows.Automation.TreeWalker]::RawViewWalker
            for($j=0;$hit -and $j -lt 16;$j++) {
                if([System.Windows.Automation.Automation]::Compare($hit,$help)){$exactHit=$true;break}
                if(-not (Test-V3ElementOwner $hit)){break};$hit=$walker.GetParent($hit)
            }
            $rootHit=[V3Pointer]::GetAncestor([V3Pointer]::WindowFromPoint($cursor),2) -eq $script:RootHandle
            if(-not (Test-V3HelpClickProof -OwnerFresh (Test-V3ElementOwner $help -Fresh) -Visible (-not $help.Current.IsOffscreen -and $help.Current.Name -ceq 'Help') `
                -PointUnchanged ($fresh.X -eq $point.X -and $fresh.Y -eq $point.Y) -CursorMatches ($cursorOk -and $cursor.X -eq $point.X -and $cursor.Y -eq $point.Y) -RootWindowHit $rootHit -ExactHelpHit $exactHit)){throw 'GAP_HELP_POINTER_TARGET'}
            [V3Pointer]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[V3Pointer]::mouse_event(4,0,0,0,[UIntPtr]::Zero);$opened=$true;$script:Activation='OWNED_HELP_POINTER'
        }
        $script:Stage='SOURCE_FIND';$script:Attempt='SOURCE_CONTROL_UNAVAILABLE';Start-Sleep -Milliseconds 300
        $source=Find-V3Owned @('Source Code…','Source Code...')
        if($source) {
            $sourceShowing=$true;$description=$source.Current.HelpText -ceq $script:V3ExactSourceText
            $script:Stage='SOURCE_HOVER';$point=Get-V3OwnedPoint $source
            if(-not $savedOk){$savedOk=[V3Pointer]::GetCursorPos([ref]$saved)}
            if(-not $savedOk -or -not [V3Pointer]::SetCursorPos($point.X,$point.Y)){throw 'GAP_POINTER_UNAVAILABLE'}
            $script:Stage='TOOLTIP_FIND';$script:Attempt='VISIBLE_TOOLTIP_UNAVAILABLE';Start-Sleep -Milliseconds 800
            $tip=Find-V3Owned @($script:V3ExactSourceText) -Tooltip
            if(-not $tip){$tip=Find-V3OwnedPopupTooltip}
            if($tip -and (-not $script:AcceptedPopup -or (Test-V3PopupWindow $script:AcceptedPopup)) -and (Test-V3TooltipResult $tip) -and
                (Test-V3ElementOwner $source -Fresh) -and -not $source.Current.IsOffscreen -and
                @('Source Code…','Source Code...') -ccontains $source.Current.Name){Assert-V3Window;$tipShowing=$true;$tipExact=$true}
            if($tipShowing -and $tipExact){$script:Attempt='EXACT_SOURCE_TOOLTIP_OBSERVED'}
        }
    }
} catch {
    if($_.Exception.Message -ceq 'ERROR_MAIN_IDENTITY'){throw 'ERROR_MAIN_IDENTITY'}
    $script:Attempt=$script:Stage+'_UNAVAILABLE'
} finally {
    if($opened -and $help) {
        $cleanup='HELP_CLOSE_UNAVAILABLE'
        try {Assert-V3Window;if((Test-V3ElementOwner $help -Fresh) -and $help.Current.Name -ceq 'Help' -and -not $help.Current.IsOffscreen){$close=$null;if($help.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern,[ref]$close)){$close.Invoke();$cleanup='HELP_INVOKED_TO_CLOSE'}}}catch{}
    }
    if($savedOk){[void][V3Pointer]::SetCursorPos($saved.X,$saved.Y)}
}
Assert-V3Window
$observation=New-V3UiObservation -SourceShowing $sourceShowing -TooltipShowing $tipShowing -TooltipExact $tipExact -DescriptionExact $description
$observation.attempt=$script:Attempt;$observation.help_cleanup=$cleanup
$observation.diagnostics=@{nodes_visited=$script:Visited;attempt_stage=$script:Stage;activation=$script:Activation;help_candidates=$script:HelpFacts;popup_candidates=$script:PopupFacts;foreign_processes=@($script:Proofs.Values|ForEach-Object{$_.Diagnostic})}
$observation.source_commit='de25611461ad0559ce237c4f59b812decd91dec1';$observation.source_offer_id='19c760a782e0ab84152ee990e8f9014f7e677f448bc58d6a3e548d8f485f1c6b';$observation.executable_sha256=$ExpectedSha256
$output=Join-Path $Evidence 'windows-ui-only.json'
if(Test-Path -LiteralPath $output){throw 'ERROR_EVIDENCE_EXISTS'}
$observation|ConvertTo-Json -Depth 8|Set-Content -Encoding UTF8 -LiteralPath $output
