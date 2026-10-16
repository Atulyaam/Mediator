# scripts/verify-audit-archive.ps1
param(
    [string]$ArchiveName = "mediator-audit-candidate-v0.1.0-beta.1.post1.zip"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::OpenRead($ArchiveName)
Write-Host "Total entries in zip: $($zip.Entries.Count)"

$hasExe = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'packages/native-host/dist/mediator-native-host.exe' }
$hasSbom = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'docs/security-audit-package/sbom.cyclonedx.json' }
$hasTests = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'tests/s52StructuredBetaTrials.test.ts' }
$hasPackageJson = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'package.json' }
$hasManifest = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -eq 'docs/EXTERNAL_AUDIT_HANDOFF_MANIFEST.md' }

Write-Host "Native host binary present: $(($null -ne $hasExe) -and ($hasExe.Length -eq 90250240)) (Length: $($hasExe.Length))"
Write-Host "CycloneDX SBOM present:     $($null -ne $hasSbom)"
Write-Host "S52 Beta Trials present:    $($null -ne $hasTests)"
Write-Host "Root package.json present:  $($null -ne $hasPackageJson)"
Write-Host "Audit manifest present:     $($null -ne $hasManifest)"

$hasGit = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -like '.git*' }
$hasNodeModules = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -like '*node_modules*' }
$hasAdHoc = $zip.Entries | Where-Object { $_.FullName.Replace('\', '/') -like 'scripts/check-*' }

Write-Host "Has .git internals:         $($null -ne $hasGit)"
Write-Host "Has node_modules:           $($null -ne $hasNodeModules)"
Write-Host "Has ad-hoc scripts:         $($null -ne $hasAdHoc)"

$zip.Dispose()
