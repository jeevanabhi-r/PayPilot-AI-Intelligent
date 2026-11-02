
$raw = Get-Content ".env" -Raw

$lines = $raw -split "`r?`n"
$line = $lines | Where-Object { $_.StartsWith("FIREBASE_PRIVATE_KEY=") } | Select-Object -First 1

if (!$line) {
    Write-Host "Private key variable not found"
    exit
}

Write-Host "Key stored on one line:" ($line.Length -gt 100)
Write-Host "Contains escaped newlines:" ($line.Contains('\n'))
Write-Host "Opening quote:" ($line.StartsWith('FIREBASE_PRIVATE_KEY="'))
Write-Host "Closing quote:" ($line.EndsWith('"'))
