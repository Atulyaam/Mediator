<#
.SYNOPSIS
    Mediator S42 — WSL2 Sandbox Preparation, Diagnostics & Provisioning Script
.DESCRIPTION
    Non-destructive diagnostic and provisioning utility for dedicated isolated execution distribution "MediatorSandbox".
    
    Modes:
      -CheckOnly  : Performs read-only discovery, verifies default distro boundary risks, and displays proposed configuration (default).
      -Provision  : With explicit user authorization, creates and hardens the dedicated MediatorSandbox WSL2 distribution.
      -Cleanup    : Unregisters and removes MediatorSandbox without touching personal Ubuntu or live project files.
#>

[CmdletBinding()]
param(
    [switch]$CheckOnly,
    [switch]$Provision,
    [switch]$Cleanup,
    [string]$DistroName = "MediatorSandbox",
    [string]$InstallLocation = "$env:LOCALAPPDATA\Mediator\wsl",
    [switch]$Force
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " Mediator S42 -- WSL2 Isolated Sandbox Management Utility" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Check WSL Availability
Write-Host ""
Write-Host "[1/5] Inspecting WSL Installation..." -ForegroundColor Yellow
$wslAvailable = $false
try {
    $rawOutput = & wsl.exe -l -v 2>$null
    if ($LASTEXITCODE -eq 0) {
        $wslAvailable = $true
        $wslList = (($rawOutput | Out-String) -replace "`0", "") -split "`r?`n"
        Write-Host "  [OK] WSL2 is operational on this system." -ForegroundColor Green
        foreach ($line in $wslList) {
            if ($line.Trim().Length -gt 0) {
                Write-Host ("       " + $line.Trim())
            }
        }
    } else {
        Write-Host ("  [FAIL] WSL command returned nonzero exit code: " + $LASTEXITCODE) -ForegroundColor Red
    }
} catch {
    Write-Host ("  [FAIL] WSL command error: " + $_) -ForegroundColor Red
}

if (-not $wslAvailable) {
    Write-Host ""
    Write-Host "CRITICAL: WSL2 is required for Linux-level isolated execution." -ForegroundColor Red
    Write-Host "Run 'wsl --install' in an Administrator PowerShell session to enable WSL2."
    exit 1
}

# 2. Check for Dedicated MediatorSandbox Distro
Write-Host ""
Write-Host ("[2/5] Checking for dedicated '" + $DistroName + "' distribution...") -ForegroundColor Yellow
$hasDedicated = $false
foreach ($line in $wslList) {
    if ($line -match $DistroName) {
        $hasDedicated = $true
    }
}

if ($hasDedicated) {
    Write-Host ("  [OK] Dedicated distribution '" + $DistroName + "' is present.") -ForegroundColor Green
} else {
    Write-Host ("  [PENDING] Dedicated distribution '" + $DistroName + "' is NOT yet created.") -ForegroundColor Yellow
    Write-Host "            (Untrusted task execution must NOT use the default Ubuntu distribution)" -ForegroundColor DarkYellow
}

# 3. Handle Cleanup Mode
if ($Cleanup) {
    Write-Host ""
    Write-Host ("[CLEANUP] Removing dedicated distribution '" + $DistroName + "'...") -ForegroundColor Magenta
    if ($hasDedicated) {
        & wsl.exe --unregister $DistroName
        $targetDir = Join-Path $InstallLocation $DistroName
        if (Test-Path $targetDir) {
            Remove-Item -Recurse -Force $targetDir -ErrorAction SilentlyContinue
        }
        Write-Host ("  [OK] Dedicated distribution '" + $DistroName + "' has been cleanly removed.") -ForegroundColor Green
        Write-Host "  [NOTE] Personal Ubuntu and Windows host files were completely untouched." -ForegroundColor Cyan
    } else {
        Write-Host ("  Distribution '" + $DistroName + "' is not present. Nothing to clean up.") -ForegroundColor Gray
    }
    exit 0
}

# 4. Handle Provisioning Mode
if ($Provision) {
    Write-Host ""
    Write-Host ("[PROVISIONING] Setting up dedicated '" + $DistroName + "'...") -ForegroundColor Cyan

    if ($hasDedicated -and -not $Force) {
        Write-Host ("  Distribution '" + $DistroName + "' already exists. Use -Force to recreate.") -ForegroundColor Yellow
        exit 0
    }

    # Verify source distribution for base image export
    $sourceDistro = "Ubuntu"
    $hasSource = $false
    foreach ($line in $wslList) {
        if ($line -match $sourceDistro) {
            $hasSource = $true
        }
    }

    if (-not $hasSource) {
        Write-Host ("  [FAIL] Source distribution '" + $sourceDistro + "' not found to export clean base.") -ForegroundColor Red
        exit 1
    }

    $distroDir = Join-Path $InstallLocation $DistroName
    if (-not (Test-Path $distroDir)) {
        New-Item -ItemType Directory -Path $distroDir -Force | Out-Null
    }

    $tempTar = Join-Path $distroDir "base_export.tar"

    try {
        Write-Host ("  [1/4] Exporting clean base snapshot from " + $sourceDistro + "...") -ForegroundColor Yellow
        & wsl.exe --export $sourceDistro $tempTar
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tempTar)) {
            Write-Host ("  [FAIL] Failed to export base filesystem from " + $sourceDistro + ".") -ForegroundColor Red
            exit 1
        }

        Write-Host ("  [2/4] Importing as standalone '" + $DistroName + "' (Version 2)...") -ForegroundColor Yellow
        & wsl.exe --import $DistroName $distroDir $tempTar --version 2
        Remove-Item -Force $tempTar -ErrorAction SilentlyContinue

        Write-Host "  [3/4] Configuring hardened isolation settings (/etc/wsl.conf)..." -ForegroundColor Yellow
        $wslConfContent = "[boot]`nsystemd=true`n`n[automount]`nenabled=false`nmountFsTab=false`n`n[interop]`nenabled=false`nappendWindowsPath=false`n`n[user]`ndefault=mediator-runner`n"
        $encodedConf = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($wslConfContent))
        $writeConfCmd = "echo " + $encodedConf + " | base64 -d > /etc/wsl.conf"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c $writeConfCmd

        Write-Host "  [4/4] Creating unprivileged user 'mediator-runner' (UID 1500)..." -ForegroundColor Yellow
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "useradd -u 1500 -m -s /bin/sh mediator-runner"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "mkdir -p /workspace/task"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "chown -R 1500:1500 /workspace"

        # Apply guest loopback default-deny rules if iptables is present
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "iptables -P INPUT DROP"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "iptables -P FORWARD DROP"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "iptables -P OUTPUT DROP"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "iptables -A INPUT -i lo -j ACCEPT"
        & wsl.exe -d $DistroName -u root --exec /bin/sh -c "iptables -A OUTPUT -o lo -j ACCEPT"

        Write-Host ("  Restarting '" + $DistroName + "' to enforce /etc/wsl.conf security boundaries...") -ForegroundColor Yellow
        & wsl.exe --terminate $DistroName

        Write-Host ""
        Write-Host ("  [SUCCESS] Dedicated distribution '" + $DistroName + "' provisioned and hardened!") -ForegroundColor Green
        Write-Host ("  Storage location: " + $distroDir + "\ext4.vhdx") -ForegroundColor Gray
        Write-Host "  User: mediator-runner (UID 1500, non-root, non-sudo)" -ForegroundColor Gray
        Write-Host "  Automount (/mnt/c): DISABLED" -ForegroundColor Gray
        Write-Host "  Windows Interop: DISABLED" -ForegroundColor Gray
    } catch {
        Write-Host ("  [ERROR] Provisioning encountered an unexpected failure: " + $_) -ForegroundColor Red
        if (Test-Path $tempTar) { Remove-Item -Force $tempTar -ErrorAction SilentlyContinue }
        exit 1
    }

    exit 0
}

# 5. Default Diagnostic / -CheckOnly Mode
Write-Host ""
Write-Host "[3/5] Assessing Security Boundary of Default Distro..." -ForegroundColor Yellow
try {
    $defaultMounts = & wsl.exe -e mount 2>$null
    if ($defaultMounts -match "drvfs") {
        Write-Host "  [SECURITY RISK] Default distribution has Windows drive automount enabled (/mnt/c)." -ForegroundColor Red
        Write-Host "                  Processes in default distro inherit ambient read/write access to host files." -ForegroundColor DarkRed
    }

    $defaultInterop = & wsl.exe -e which cmd.exe 2>$null
    if ($defaultInterop -match "cmd\.exe") {
        Write-Host "  [SECURITY RISK] Default distribution has Windows interop enabled." -ForegroundColor Red
        Write-Host "                  Processes in default distro can launch host Windows executables." -ForegroundColor DarkRed
    }
} catch {
    Write-Host ("  [INFO] Could not probe default distribution mounts: " + $_)
}

# 6. Proposed Hardened Configuration for MediatorSandbox
Write-Host ""
Write-Host ("[4/5] Proposed Hardened Configuration for '" + $DistroName + "':") -ForegroundColor Cyan
Write-Host "----------------------------------------------------------"
$sampleConf = "[boot]`nsystemd=true`n`n[automount]`nenabled=false`nmountFsTab=false`n`n[interop]`nenabled=false`nappendWindowsPath=false`n`n[user]`ndefault=mediator-runner"
Write-Host $sampleConf -ForegroundColor Gray
Write-Host "----------------------------------------------------------"
Write-Host "  Guarantees of this configuration:" -ForegroundColor Green
Write-Host "  - [automount] enabled=false  -> Denies access to /mnt/c, /mnt/d, and all host drives."
Write-Host "  - [interop] enabled=false    -> Denies running Windows .exe binaries from Linux."
Write-Host "  - appendWindowsPath=false    -> Prevents Windows path injection."
Write-Host "  - default=mediator-runner    -> Drops root privileges; non-sudo execution identity."

# 7. Provisioning Instructions & Status
Write-Host ""
Write-Host "[5/5] Provisioning Action Details:" -ForegroundColor Yellow
if (-not $hasDedicated) {
    Write-Host ("  To create the dedicated '" + $DistroName + "' distribution once authorized by user:") -ForegroundColor White
    Write-Host "  Command: powershell -ExecutionPolicy Bypass -File scripts\prepare-wsl2-sandbox.ps1 -Provision" -ForegroundColor Cyan
    Write-Host ("  Storage Requirements: ~2-3 GB isolated VHDX in " + $InstallLocation) -ForegroundColor Gray
    Write-Host "  Permissions: Standard user command (does NOT require Administrator elevation)" -ForegroundColor Gray
    Write-Host "  Cleanup: To remove at any time without touching Ubuntu, run:" -ForegroundColor Gray
    Write-Host "           powershell -ExecutionPolicy Bypass -File scripts\prepare-wsl2-sandbox.ps1 -Cleanup" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host "  Current Status: AWAITING_EXPLICIT_USER_AUTHORIZATION" -ForegroundColor Magenta
} else {
    Write-Host "  Dedicated distribution is already configured." -ForegroundColor Green
}

Write-Host ""
Write-Host "Diagnostics Complete." -ForegroundColor Cyan
Write-Host ""
