<#
.SYNOPSIS
    Unregisters and removes the Mediator Native Messaging Host from Windows 11.

.DESCRIPTION
    Safely removes current-user registry entries in HKCU for Google Chrome and Microsoft Edge.
    Optionally removes installed host binary and manifest files.
    Optionally purges local application database and staging caches.

    Security guarantees:
    - Never modifies machine-wide registry settings (HKLM).
    - Idempotent: safe to run even if already uninstalled.
    - Preserves user workspace projects and unrelated files.

.PARAMETER InstallDir
    Directory where host manifest and executable were installed.
    Defaults to $env:LOCALAPPDATA\Mediator\native-host.

.PARAMETER RemoveFiles
    If set, removes the manifest JSON and executable binary from $InstallDir.

.PARAMETER PurgeUserData
    If set, purges the local SQLite database, logs, and staging directories in $env:LOCALAPPDATA\Mediator.
    User workspace files are NEVER deleted.

.EXAMPLE
    .\scripts\uninstall-windows.ps1 -RemoveFiles
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Mediator\native-host"),

    [Parameter(Mandatory = $false)]
    [switch]$RemoveFiles = $false,

    [Parameter(Mandatory = $false)]
    [switch]$PurgeUserData = $false,

    [Parameter(Mandatory = $false)]
    [switch]$UnregisterSandbox = $false
)

$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Mediator Native Messaging Host -- Windows 11 Uninstaller   " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

$hostName = "com.mediator.native_host"
$chromeRegPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
$edgeRegPath   = "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName"

# 1. Unregister Chrome
if (Test-Path $chromeRegPath) {
    Remove-Item -Path $chromeRegPath -Recurse -Force
    Write-Host "[+] Removed Chrome registry key: $chromeRegPath" -ForegroundColor Green
} else {
    Write-Host "[i] Chrome registry key not present (already uninstalled)." -ForegroundColor Gray
}

# 2. Unregister Edge
if (Test-Path $edgeRegPath) {
    Remove-Item -Path $edgeRegPath -Recurse -Force
    Write-Host "[+] Removed Edge registry key: $edgeRegPath" -ForegroundColor Green
} else {
    Write-Host "[i] Edge registry key not present (already uninstalled)." -ForegroundColor Gray
}

# 3. Clean files if requested
if ($RemoveFiles -and (Test-Path $InstallDir)) {
    $manifestPath = Join-Path $InstallDir "$hostName.json"
    $exePath = Join-Path $InstallDir "mediator-native-host.exe"

    if (Test-Path $manifestPath) {
        Remove-Item -Path $manifestPath -Force
        Write-Host "[+] Removed manifest file: $manifestPath" -ForegroundColor Green
    }
    if (Test-Path $exePath) {
        Remove-Item -Path $exePath -Force
        Write-Host "[+] Removed executable binary: $exePath" -ForegroundColor Green
    }

    # Remove install dir if empty
    $remaining = Get-ChildItem -Path $InstallDir -ErrorAction SilentlyContinue
    if (-not $remaining -or $remaining.Count -eq 0) {
        Remove-Item -Path $InstallDir -Force -ErrorAction SilentlyContinue
        Write-Host "[+] Removed empty installation directory: $InstallDir" -ForegroundColor Green
    }
}

# 4. Unregister dedicated MediatorSandbox if explicitly requested
if ($UnregisterSandbox) {
    Write-Host "[!] Unregistering dedicated MediatorSandbox distribution..." -ForegroundColor Yellow
    # CRITICAL INVARIANT: Only unregister MediatorSandbox; NEVER touch user's personal Ubuntu or Docker distros
    $targetDistro = "MediatorSandbox"
    try {
        $wslList = (wsl.exe -l -q 2>$null) | Out-String
        if ($wslList -match "\b$targetDistro\b") {
            & wsl.exe --unregister $targetDistro
            Write-Host "[+] Safely unregistered dedicated distribution: $targetDistro" -ForegroundColor Green
        } else {
            Write-Host "[i] Distribution '$targetDistro' is not currently registered." -ForegroundColor Gray
        }
    } catch {
        Write-Warning "[!] Could not unregister $targetDistro: $_"
    }
}

# 5. Purge local user data if requested
if ($PurgeUserData) {
    $mediatorAppData = Join-Path $env:LOCALAPPDATA "Mediator"
    if (Test-Path $mediatorAppData) {
        Write-Host "[!] Purging Mediator-managed local app data in: $mediatorAppData" -ForegroundColor Yellow
        # CRITICAL INVARIANT: Only delete Mediator application cache and logs; user workspace repositories are NEVER touched
        $subdirs = @("native-host", "bundles", "staging", "logs")
        foreach ($sub in $subdirs) {
            $subPath = Join-Path $mediatorAppData $sub
            if (Test-Path $subPath) {
                Remove-Item -Path $subPath -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "[+] Removed Mediator cache: $sub" -ForegroundColor Green
            }
        }
        # If unregister sandbox was also requested, remove wsl dir
        if ($UnregisterSandbox) {
            $wslDir = Join-Path $mediatorAppData "wsl"
            if (Test-Path $wslDir) {
                Remove-Item -Path $wslDir -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "[+] Removed Mediator WSL data directory." -ForegroundColor Green
            }
        }
        Write-Host "[+] Purged Mediator-managed app data cleanly. User workspaces remain untouched." -ForegroundColor Green
    }
}


Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  Mediator Native Host Unregistration COMPLETED.            " -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
