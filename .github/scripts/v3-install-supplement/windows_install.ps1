param(
    [Parameter(Mandatory=$true)][ValidateSet('Preflight','Install','Remove')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Package,
    [Parameter(Mandatory=$true)][string]$Evidence
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Actual installation is restricted to ephemeral GitHub-hosted runners'
}
if ([Environment]::Is64BitProcess -ne $true) { throw 'Native x64 PowerShell required' }
if (-not (Test-Path -LiteralPath $Package -PathType Leaf) -or [IO.Path]::GetExtension($Package) -cne '.msi') {
    throw 'Expected exact original MSI package'
}

function Get-ProductProperties {
    # Read-only MSI database access; this does not install/register the product.
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.GetType().InvokeMember('OpenDatabase', 'InvokeMethod', $null, $installer, @($Package, 0))
    $properties = @{}
    try {
        foreach ($name in @('ProductCode', 'ProductName', 'ProductVersion')) {
            $view = $database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $database,
                @("SELECT ``Value`` FROM ``Property`` WHERE ``Property``='$name'"))
            try {
                $null = $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null)
                $row = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
                if (-not $row) { throw "Missing MSI property $name" }
                try { $properties[$name] = $row.GetType().InvokeMember('StringData', 'GetProperty', $null, $row, @(1)) }
                finally { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($row) }
            } finally {
                $null = $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null)
                $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)
            }
        }
    } finally {
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)
        $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer)
    }
    if ($properties.ProductName -cne 'BDOBB' -or $properties.ProductVersion -cne '3.0.0' -or
        $properties.ProductCode -notmatch '^\{[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\}$') {
        throw 'Original MSI database product identity/version mismatch'
    }
    return $properties
}

function Get-BdobbRegistration {
    $roots = @('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
    foreach ($root in $roots) {
        foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue)) {
            $item = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
            if ($item.DisplayName -like 'BDOBB*') { $item }
        }
    }
}

function Assert-Fresh {
    if (@(Get-BdobbRegistration).Count -ne 0) { throw 'Existing BDOBB registration; refusing install/change' }
    $roaming = [Environment]::GetFolderPath([Environment+SpecialFolder]::ApplicationData)
    foreach ($name in @('com.artcashin.bdobb', 'com.artcashin.bdobb.clean.v3.repair')) {
        if (Test-Path -LiteralPath (Join-Path $roaming $name)) { throw 'Existing app/migration profile; refusing install/change' }
    }
}

$product = Get-ProductProperties
if ($Mode -eq 'Preflight') {
    Assert-Fresh
    [ordered]@{method='MSI readonly metadata, registry and native profile absence checks'; product_code=$product.ProductCode;
        product_name=$product.ProductName; product_version=$product.ProductVersion; fresh=$true} |
        ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $Evidence 'windows-preflight.json')
    exit 0
}

if ($Mode -eq 'Install') {
    Assert-Fresh
    $log = Join-Path $Evidence 'msi-install.log'
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/i', ('"{0}"' -f $Package), '/qn', '/norestart', '/l*v', ('"{0}"' -f $log)) -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "Actual MSI install failed or requires restart: $($process.ExitCode)" }
    $entries = @(Get-BdobbRegistration)
    if ($entries.Count -ne 1 -or $entries[0].PSChildName -ine $product.ProductCode -or $entries[0].DisplayVersion -cne '3.0.0') {
        throw 'Exact installed product registration/version missing or ambiguous'
    }
    $entry = $entries[0]
    # ARPINSTALLLOCATION is authoritative; do not substitute an extracted executable.
    if (-not $entry.InstallLocation) { throw 'Installed MSI registry does not expose InstallLocation' }
    $installed = Join-Path $entry.InstallLocation 'bdobb.exe'
    if (-not (Test-Path -LiteralPath $installed -PathType Leaf)) { throw 'Registry-installed native executable missing' }
    $record = [ordered]@{method='Actual msiexec /i /qn /norestart; uninstall registry registration verified';
        product_code=$product.ProductCode; product_name=$product.ProductName; version=$product.ProductVersion;
        registry_path=$entry.PSPath; install_location=$entry.InstallLocation; installed_path=$installed;
        uninstall_string=$entry.UninstallString; exit_code=$process.ExitCode; scope='MSI package default on fresh administrative hosted runner'}
    $record | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $Evidence 'windows-install.json')
} else {
    # Called only after the same process proved no registration/profile existed.
    $log = Join-Path $Evidence 'msi-uninstall.log'
    $process = Start-Process -FilePath 'msiexec.exe' -ArgumentList @('/x', $product.ProductCode, '/qn', '/norestart', '/l*v', ('"{0}"' -f $log)) -PassThru -Wait
    # 1605 means install failed before registration; no pre-existing product was allowed.
    if ($process.ExitCode -notin @(0, 1605)) { throw "MSI cleanup failed: $($process.ExitCode)" }
    if (@(Get-BdobbRegistration).Count -ne 0) { throw 'BDOBB registration remains after uninstall' }
    $installRecord = Join-Path $Evidence 'windows-install.json'
    if (Test-Path -LiteralPath $installRecord) {
        $original = Get-Content -Raw -LiteralPath $installRecord | ConvertFrom-Json
        if (Test-Path -LiteralPath $original.installed_path) { throw 'Installed native executable remains after uninstall' }
    }
    [ordered]@{method='Actual msiexec /x exact original ProductCode /qn /norestart'; product_code=$product.ProductCode;
        exit_code=$process.ExitCode; registration_absent=$true; installed_executable_absent=$true} |
        ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $Evidence 'windows-remove.json')
}
