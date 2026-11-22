param([int]$AppPid, [string]$Evidence, [string]$Executable)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'UIA smoke is restricted to ephemeral GitHub-hosted runners'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
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
$version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($Executable).ProductVersion
if ($version -notmatch '^3\.0\.0(?:\.0)?$') { throw 'Native Windows executable product version mismatch' }
$names = @()
$elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
    [System.Windows.Automation.Condition]::TrueCondition)
foreach ($element in $elements) { $names += $element.Current.Name }
$connections = $null
foreach ($element in $elements) {
    if ($element.Current.Name -eq 'Connections') { $connections = $element; break }
}
$uiEmpty = $false
$limitation = 'Connections UI was unavailable to UIA; exact freshly created backends.json is independently required to equal []. About dialog is not observed remotely.'
if ($connections) {
    $invoke = $null
    if ($connections.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$invoke)) {
        $invoke.Invoke()
        $deadline = [DateTime]::UtcNow.AddSeconds(10)
        do {
            $names = @()
            $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($element in $elements) { $names += $element.Current.Name }
            $uiEmpty = $names -contains 'No backends configured'
            if (-not $uiEmpty) { Start-Sleep -Milliseconds 500 }
        } while (-not $uiEmpty -and [DateTime]::UtcNow -lt $deadline)
        if (-not $uiEmpty) { throw 'Connections opened but did not show No backends configured' }
        $limitation = 'About dialog not observed remotely; product version metadata and pinned Tauri version are recorded separately.'
    }
}
$record = [ordered]@{
    process_id = $AppPid
    native_window_title = $window.Current.Name
    product_version = $version
    empty_connections_ui_observed = $uiEmpty
    displayed_about = 'NOT_OBSERVED'
    limitation = $limitation
    uia_names = $names
}
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $Evidence 'windows-ui.json')
