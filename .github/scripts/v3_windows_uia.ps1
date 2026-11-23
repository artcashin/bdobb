param([int]$AppPid, [string]$Evidence, [string]$Executable)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or [Environment]::Is64BitProcess -ne $true) {
    throw 'UIA smoke is restricted to native x64 ephemeral GitHub-hosted Windows runners'
}
. (Join-Path $PSScriptRoot 'v3_windows_ui_observation.ps1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class V3UiNative {
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X; public int Y; }
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
function Assert-AppProcess {
    $process = Get-Process -Id $AppPid -ErrorAction Stop
    $actual = [IO.Path]::GetFullPath($process.MainModule.FileName)
    if (-not [String]::Equals($actual, $script:expectedPath, [StringComparison]::OrdinalIgnoreCase) -or
        (Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash -cne $script:expectedHash) {
        throw 'UIA process executable identity mismatch'
    }
}
$expectedPath = [IO.Path]::GetFullPath($Executable)
$file = Get-Item -LiteralPath $expectedPath
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'UIA executable must be a regular native file'
}
$expectedHash = (Get-FileHash -LiteralPath $expectedPath -Algorithm SHA256).Hash
Assert-AppProcess
$version = [Diagnostics.FileVersionInfo]::GetVersionInfo($expectedPath).ProductVersion
if ($version -notmatch '^3\.0\.0(?:\.0)?$') { throw 'Native Windows executable product version mismatch' }
$condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $AppPid)
$deadline = [DateTime]::UtcNow.AddSeconds(25)
$window = $null
do {
    $window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
        [System.Windows.Automation.TreeScope]::Children, $condition)
    if (-not $window) { Start-Sleep -Milliseconds 500 }
} while (-not $window -and [DateTime]::UtcNow -lt $deadline)
if (-not $window) { throw 'Native application did not expose a UIA window' }
$windowHandle = [IntPtr]$window.Current.NativeWindowHandle
$windowPid = [uint32]0
[void][V3UiNative]::GetWindowThreadProcessId($windowHandle, [ref]$windowPid)
if ($windowHandle -eq [IntPtr]::Zero -or $windowPid -ne $AppPid) { throw 'Native UIA window ownership mismatch' }
function Get-OwnedElements {
    return $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
}
function Find-OwnedNamedElement([string[]]$Names) {
    foreach ($element in (Get-OwnedElements)) {
        if ($Names -ccontains $element.Current.Name -and -not $element.Current.IsOffscreen) { return $element }
    }
    return $null
}
function Test-TooltipOwnership($Tooltip) {
    if ($Tooltip.Current.ProcessId -ne $AppPid -or $Tooltip.Current.IsOffscreen) { return $false }
    # A descendant is owned by the already-validated window. Separate native
    # tooltip windows must have a GW_OWNER chain back to that exact window.
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $ancestor = $Tooltip
    for ($i = 0; $ancestor -and $i -lt 30; $i++) {
        if ([System.Windows.Automation.Automation]::Compare($ancestor, $window)) { return $true }
        $ancestor = $walker.GetParent($ancestor)
    }
    $handle = [IntPtr]$Tooltip.Current.NativeWindowHandle
    for ($i = 0; $handle -ne [IntPtr]::Zero -and $i -lt 16; $i++) {
        if ($handle -eq $windowHandle) { return $true }
        $ownerPid = [uint32]0
        [void][V3UiNative]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
        if ($ownerPid -ne $AppPid) { return $false }
        $handle = [V3UiNative]::GetWindow($handle, 4)
    }
    return $false
}

# Attempt the local Help popup before opening the Connections dialog. Only
# Help is invoked. Source Code is inspected/hovered and is NEVER invoked.
$helpText = ''
$tooltipText = ''
$ownedButton = $false
$ownedVisibleTooltip = $false
$attempt = 'HELP_CONTROL_UNAVAILABLE'
$help = Find-OwnedNamedElement @('Help')
$helpOpened = $false
$helpCleanup = 'NOT_OPENED'
$savedCursor = New-Object V3UiNative+Point
$cursorSaved = $false
$cursorMoved = $false
try {
    $invokeHelp = $null
    if ($help -and $help.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
        $help.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invokeHelp)) {
        Assert-AppProcess
        $invokeHelp.Invoke()
        $helpOpened = $true
        $attempt = 'SOURCE_CONTROL_UNAVAILABLE'
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $source = Find-OwnedNamedElement @('Source Code…', 'Source Code...')
            if (-not $source) { Start-Sleep -Milliseconds 250 }
        } while (-not $source -and [DateTime]::UtcNow -lt $deadline)
        if ($source) {
            $ownedButton = $true
            $helpText = $source.Current.HelpText
            $attempt = 'SOURCE_RELEASE_TEXT_UNAVAILABLE'
            $bounds = $source.Current.BoundingRectangle
            if (-not $bounds.IsEmpty -and $bounds.Width -gt 0 -and $bounds.Height -gt 0) {
                $point = New-Object V3UiNative+Point
                $point.X = [int]($bounds.Left + $bounds.Width / 2)
                $point.Y = [int]($bounds.Top + $bounds.Height / 2)
                $hit = [V3UiNative]::WindowFromPoint($point)
                if ([V3UiNative]::GetAncestor($hit, 2) -eq $windowHandle) {
                    $cursorSaved = [V3UiNative]::GetCursorPos([ref]$savedCursor)
                    Assert-AppProcess
                    if ($cursorSaved) { $cursorMoved = [V3UiNative]::SetCursorPos($point.X, $point.Y) }
                    $deadline = [DateTime]::UtcNow.AddSeconds(4)
                    $tooltipType = New-Object System.Windows.Automation.PropertyCondition(
                        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                        [System.Windows.Automation.ControlType]::ToolTip)
                    while ($cursorMoved -and -not $ownedVisibleTooltip -and [DateTime]::UtcNow -lt $deadline) {
                        $tips = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                            [System.Windows.Automation.TreeScope]::Descendants, $tooltipType)
                        foreach ($tip in $tips) {
                            if ((Test-TooltipOwnership $tip) -and $tip.Current.Name -ceq 'Download the corresponding source for v3.0.0 (GNU AGPL v3).') {
                                $tooltipText = $tip.Current.Name
                                $ownedVisibleTooltip = $true
                                break
                            }
                        }
                        if (-not $ownedVisibleTooltip) { Start-Sleep -Milliseconds 250 }
                    }
                }
            }
        }
    }
} catch {
    # UI accessibility differences are a recorded gap; never serialize UI text
    # or exception contents. Identity failures still fail at the final recheck.
    $attempt = 'UIA_SOURCE_ATTEMPT_UNAVAILABLE'
} finally {
    if ($cursorSaved -and $cursorMoved) { [void][V3UiNative]::SetCursorPos($savedCursor.X, $savedCursor.Y) }
    if ($helpOpened) {
        Assert-AppProcess
        # Closing the same local Help toggle does not activate a menu item.
        $helpCleanup = 'HELP_CLOSE_UNAVAILABLE'
        try {
            $help = Find-OwnedNamedElement @('Help')
            $closeHelp = $null
            if ($help -and $help.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$closeHelp)) {
                $closeHelp.Invoke()
                $helpCleanup = 'LOCAL_HELP_TOGGLE_INVOKED_TO_CLOSE'
            }
        } catch { $helpCleanup = 'HELP_CLOSE_UNAVAILABLE' }
    }
}
Assert-AppProcess
$sourceObservation = New-SourceOfferObservation -OwnedButton $ownedButton -HelpText $helpText `
    -OwnedVisibleTooltip $ownedVisibleTooltip -TooltipText $tooltipText
if ($sourceObservation.status -ne 'NOT_OBSERVED') { $attempt = 'EXACT_SOURCE_RELEASE_TEXT_OBSERVED' }
$sourceObservation['attempt'] = $attempt
$sourceObservation['help_popup_cleanup'] = $helpCleanup

# Preserve the existing Connections proof; UIA fallback is an explicit gap and
# the separate exact freshly-created backends.json == [] check remains required.
$connections = Find-OwnedNamedElement @('Connections')
$uiEmpty = $false
$connectionsScope = 'UIA_UNAVAILABLE; independent fresh backends.json proof remains mandatory'
if ($connections) {
    $invoke = $null
    if ($connections.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        Assert-AppProcess
        $invoke.Invoke()
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $uiEmpty = $null -ne (Find-OwnedNamedElement @('No backends configured'))
            if (-not $uiEmpty) { Start-Sleep -Milliseconds 500 }
        } while (-not $uiEmpty -and [DateTime]::UtcNow -lt $deadline)
        if (-not $uiEmpty) { throw 'Connections opened but did not show No backends configured' }
        $connectionsScope = 'OWNED_UIA_EMPTY_CONNECTIONS_OBSERVED'
    }
}
Assert-AppProcess
$record = [ordered]@{
    process_id = $AppPid
    process_executable_path_matches = $true
    process_executable_sha256 = $expectedHash.ToLowerInvariant()
    native_window_pid_matches = $true
    product_version = $version
    product_version_scope = 'Executable metadata only; never used to infer displayed version'
    empty_connections_ui_observed = $uiEmpty
    connections_scope = $connectionsScope
    displayed_about = 'NOT_OBSERVED'
    source_offer_release_ui = $sourceObservation
    limitation = 'Frontend source-offer release text and native About are separate scopes; native About is not observed'
}
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Evidence 'windows-ui.json')
