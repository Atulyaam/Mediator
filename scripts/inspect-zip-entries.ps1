# scripts/inspect-zip-entries.ps1
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead("mediator-audit-candidate-v0.1.0-beta.1.post1.zip")
$zip.Entries | Select-Object -First 20 FullName, Length | Format-Table -AutoSize
$zip.Entries | Where-Object { $_.FullName -like "*mediator-native-host.exe*" -or $_.FullName -like "*sbom*" } | Select-Object FullName, Length | Format-Table -AutoSize
$zip.Dispose()
