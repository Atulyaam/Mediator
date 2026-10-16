# scripts/create-audit-archive.ps1
param(
    [string]$ArchiveName = "mediator-audit-candidate-v0.1.0-beta.1.post1.zip",
    [string]$SourceWorktree = ".worktrees/audit-candidate"
)

$ErrorActionPreference = "Stop"

$workspaceRoot = (Resolve-Path ".").Path
$srcPath = Join-Path $workspaceRoot $SourceWorktree
$destZipPath = Join-Path $workspaceRoot $ArchiveName
$checksumPath = Join-Path $workspaceRoot "$ArchiveName.sha256"

$tempStaging = Join-Path $env:TEMP "mediator-audit-staging-$(Get-Random)"
if (Test-Path $tempStaging) {
    Remove-Item -Recurse -Force $tempStaging
}
New-Item -ItemType Directory -Path $tempStaging | Out-Null

Write-Host "Staging candidate files from $srcPath to $tempStaging..."

# 1. Root configuration files
$rootFiles = @('package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'README.md')
foreach ($f in $rootFiles) {
    $srcFile = Join-Path $srcPath $f
    if (Test-Path $srcFile) {
        Copy-Item $srcFile -Destination (Join-Path $tempStaging $f)
    }
}

# 2. Packages (excluding node_modules and dist, preserving native-host binary)
$destPackages = Join-Path $tempStaging "packages"
New-Item -ItemType Directory -Path $destPackages | Out-Null
Get-ChildItem (Join-Path $srcPath "packages") -Directory | ForEach-Object {
    $pkgDir = $_
    $targetPkgDir = Join-Path $destPackages $pkgDir.Name
    New-Item -ItemType Directory -Path $targetPkgDir | Out-Null
    Get-ChildItem $pkgDir.FullName | Where-Object { $_.Name -notin @('node_modules', 'dist') } | ForEach-Object {
        Copy-Item -Recurse $_.FullName -Destination (Join-Path $targetPkgDir $_.Name)
    }
}

# Preserve native host binary
$nativeHostExe = Join-Path $srcPath "packages/native-host/dist/mediator-native-host.exe"
if (Test-Path $nativeHostExe) {
    $targetDist = Join-Path $destPackages "native-host/dist"
    New-Item -ItemType Directory -Path $targetDist -Force | Out-Null
    Copy-Item $nativeHostExe -Destination (Join-Path $targetDist "mediator-native-host.exe") -Force
}

# 3. Applications (excluding node_modules and dist)
$destApps = Join-Path $tempStaging "apps"
New-Item -ItemType Directory -Path $destApps | Out-Null
Get-ChildItem (Join-Path $srcPath "apps") -Directory | ForEach-Object {
    $appDir = $_
    $targetAppDir = Join-Path $destApps $appDir.Name
    New-Item -ItemType Directory -Path $targetAppDir | Out-Null
    Get-ChildItem $appDir.FullName | Where-Object { $_.Name -notin @('node_modules', 'dist') } | ForEach-Object {
        Copy-Item -Recurse $_.FullName -Destination (Join-Path $targetAppDir $_.Name)
    }
}

# 4. Tests
Copy-Item -Recurse (Join-Path $srcPath "tests") -Destination (Join-Path $tempStaging "tests")

# 5. Documentation
Copy-Item -Recurse (Join-Path $srcPath "docs") -Destination (Join-Path $tempStaging "docs")

# 6. Reviewed Operational Scripts
$destScripts = Join-Path $tempStaging "scripts"
New-Item -ItemType Directory -Path $destScripts | Out-Null
$reviewedScripts = @('install-windows.ps1', 'uninstall-windows.ps1', 'prepare-wsl2-sandbox.ps1', 'dev-runner.mjs')
foreach ($s in $reviewedScripts) {
    $srcScript = Join-Path $srcPath "scripts/$s"
    if (Test-Path $srcScript) {
        Copy-Item $srcScript -Destination (Join-Path $destScripts $s)
    }
}

Write-Host "Creating clean portable zip archive..."
if (Test-Path $destZipPath) {
    Remove-Item $destZipPath -Force
}

# Use Compress-Archive
Compress-Archive -Path "$tempStaging/*" -DestinationPath $destZipPath -CompressionLevel Optimal

Write-Host "Cleaning up staging directory..."
Remove-Item -Recurse -Force $tempStaging

# Verify archive
$zipItem = Get-Item $destZipPath
$hashResult = Get-FileHash -Path $destZipPath -Algorithm SHA256
$sha256 = $hashResult.Hash

Write-Host "`n=== PORTABLE AUDIT ARCHIVE CREATED ==="
Write-Host "File Name:    $($zipItem.Name)"
Write-Host "File Size:    $($zipItem.Length) bytes ($([Math]::Round($zipItem.Length / 1MB, 2)) MB)"
Write-Host "SHA-256 Hash: $sha256"

# Write Checksum File
"$sha256 *$($zipItem.Name)" | Out-File -FilePath $checksumPath -Encoding ascii
Write-Host "Checksum File: $ArchiveName.sha256 written successfully."
