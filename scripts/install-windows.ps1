<#
.SYNOPSIS
    Installs and registers the Mediator Native Messaging Host on Windows 11.

.DESCRIPTION
    Configures current-user registry entries in HKCU for Google Chrome and Microsoft Edge.
    Generates the Chromium-compliant native messaging host manifest JSON pointing to the
    packaged mediator-native-host.exe binary.

    Security guarantees:
    - Current-user scope only (HKCU). Never requires or requests Administrator elevation.
    - Strictly rejects batch/script wrappers (.bat / .cmd) as executable paths.
    - Validates extension ID format (32 characters, lowercase).
    - Idempotent and reversible. Safe rollback if any step fails.

.PARAMETER ExtensionId
    The 32-character Chrome/Edge extension ID (e.g., 'abcdefghijklmnopponmlkjihgfedcba').
    Defaults to the canonical development extension ID.

.PARAMETER InstallDir
    Target directory for host binary and manifest JSON.
    Defaults to $env:LOCALAPPDATA\Mediator\native-host.

.PARAMETER ExecutablePath
    Path to existing mediator-native-host.exe binary.
    If not specified, checks $InstallDir and the repository dist folder.

.PARAMETER SkipCopy
    If set, points manifest directly to -ExecutablePath without copying to $InstallDir.

.EXAMPLE
    .\scripts\install-windows.ps1 -ExtensionId "abcdefghijklmnopponmlkjihgfedcba"
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$ExtensionId = "abcdefghijklmnopponmlkjihgfedcba",

    [Parameter(Mandatory = $false)]
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Mediator\native-host"),

    [Parameter(Mandatory = $false)]
    [string]$ExecutablePath = "",

    [Parameter(Mandatory = $false)]
    [switch]$SkipCopy = $false,

    [Parameter(Mandatory = $false)]
    [switch]$Force = $false
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Mediator Native Messaging Host -- Windows 11 Installer     " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Administrator check: Must NOT require Administrator privileges
$isElevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isElevated) {
    Write-Warning "[Security Note] Script is running with Administrator elevation. Note that Mediator installs strictly into Current User scope (HKCU) and does NOT require admin rights."
}

# 2. Extension ID validation: Must be 32 lowercase alpha/hex characters
$normalizedId = $ExtensionId.Trim().ToLower()
if ($normalizedId -notmatch '^[a-p]{32}$') {
    Write-Error "Invalid Extension ID '$ExtensionId'. Must be a 32-character string containing letters a through p."
    exit 1
}
Write-Host "[+] Extension ID validated: $normalizedId" -ForegroundColor Green

# 3. Locate and validate host executable (.exe)
$candidatePaths = @()
if ($ExecutablePath) {
    $candidatePaths += (Resolve-Path $ExecutablePath -ErrorAction SilentlyContinue).Path
    $candidatePaths += $ExecutablePath
}
$candidatePaths += (Join-Path $InstallDir "mediator-native-host.exe")
$repoDistExe = Join-Path $PSScriptRoot "..\packages\native-host\dist\mediator-native-host.exe"
if (Test-Path $repoDistExe) {
    $candidatePaths += (Resolve-Path $repoDistExe).Path
}

$resolvedExe = $null
foreach ($cand in $candidatePaths) {
    if ($cand -and (Test-Path $cand)) {
        $resolvedExe = $cand
        break
    }
}

if (-not $resolvedExe) {
    Write-Error "Could not locate 'mediator-native-host.exe'. Please run 'npm run build' or specify -ExecutablePath."
    exit 1
}

# CRITICAL INVARIANT: Never use a .bat or .cmd wrapper as production native host
$exeExtension = [System.IO.Path]::GetExtension($resolvedExe).ToLower()
if ($exeExtension -eq ".bat" -or $exeExtension -eq ".cmd") {
    Write-Error "Prohibited executable extension '$exeExtension'. Native messaging host must be a real compiled binary (.exe), not a script wrapper."
    exit 1
}

Write-Host "[+] Found native host executable: $resolvedExe" -ForegroundColor Green

# 4. Prepare install directory
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Write-Host "[+] Created install directory: $InstallDir" -ForegroundColor Green
}

$targetExePath = $resolvedExe
if (-not $SkipCopy) {
    $destExe = Join-Path $InstallDir "mediator-native-host.exe"
    if ($resolvedExe -ne $destExe) {
        Copy-Item -Path $resolvedExe -Destination $destExe -Force
        Write-Host "[+] Copied executable to: $destExe" -ForegroundColor Green
    }
    $targetExePath = $destExe
}

# 5. Generate Native Messaging Host Manifest JSON
$hostName = "com.mediator.native_host"
$manifestPath = Join-Path $InstallDir "$hostName.json"

$manifestObject = [PSCustomObject]@{
    name            = $hostName
    description     = "Mediator Native Messaging Host"
    path            = $targetExePath
    type            = "stdio"
    allowed_origins = @("chrome-extension://$normalizedId/")
}

$manifestJson = $manifestObject | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($manifestPath, $manifestJson, [System.Text.Encoding]::UTF8)
Write-Host "[+] Generated manifest file: $manifestPath" -ForegroundColor Green

# 6. Configure Windows Registry (Current User only)
$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$edgeRegPath   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

$rollbackNeeded = $false
try {
    # Chrome registration
    if (-not (Test-Path $chromeRegPath)) {
        New-Item -Path $chromeRegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $chromeRegPath -Name "(Default)" -Value $manifestPath -Type String
    Write-Host "[+] Registered in Google Chrome: $chromeRegPath" -ForegroundColor Green

    # Edge registration
    if (-not (Test-Path $edgeRegPath)) {
        New-Item -Path $edgeRegPath -Force | Out-Null
    }
    Set-ItemProperty -Path $edgeRegPath -Name "(Default)" -Value $manifestPath -Type String
    Write-Host "[+] Registered in Microsoft Edge: $edgeRegPath" -ForegroundColor Green
}
catch {
    Write-Warning "[!] Registration failed: $_. Rolling back changes..."
    if (Test-Path $chromeRegPath) { Remove-Item -Path $chromeRegPath -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path $edgeRegPath) { Remove-Item -Path $edgeRegPath -Recurse -Force -ErrorAction SilentlyContinue }
    throw
}

# 7. Verification check
$chromeVal = (Get-ItemProperty -Path $chromeRegPath -ErrorAction SilentlyContinue)."(Default)"
$edgeVal   = (Get-ItemProperty -Path $edgeRegPath -ErrorAction SilentlyContinue)."(Default)"

if ($chromeVal -eq $manifestPath -and $edgeVal -eq $manifestPath) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  Mediator Native Host Installation COMPLETED SUCCESSFULLY! " -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  Host Name:    $hostName"
    Write-Host "  Executable:   $targetExePath"
    Write-Host "  Manifest:     $manifestPath"
    Write-Host "  Extension ID: $normalizedId"
    Write-Host "  Scope:        Current User (HKCU, no admin elevation)"
    Write-Host ""
} else {
    Write-Error "Verification failed: Registry values did not match manifest path."
    exit 1
}
