$ErrorActionPreference = "Stop"

# Purr CLI Windows installer
# Usage:
#   irm https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.ps1 | iex
# Pin a version:
#   $env:PURR_VERSION="v0.2.2"; irm https://raw.githubusercontent.com/Pieverse-Eng/purr-cli/main/install.ps1 | iex

$Repo = "Pieverse-Eng/purr-cli"
$InstallDir = Join-Path $HOME ".purrfectclaw\bin"
$BinaryName = "purr.exe"
$AssetName = "purr-windows-x64.exe"

if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne "X64") {
  throw "Unsupported Windows architecture. Only x64 is currently supported."
}

if ($env:PURR_VERSION) {
  $Tag = $env:PURR_VERSION
  if (-not $Tag.StartsWith("v")) {
    $Tag = "v$Tag"
  }
  $DownloadUrl = "https://github.com/$Repo/releases/download/$Tag/$AssetName"
} else {
  $DownloadUrl = "https://github.com/$Repo/releases/latest/download/$AssetName"
}

Write-Host "Installing purr CLI..."
Write-Host "  OS:   windows"
Write-Host "  Arch: x64"
Write-Host "  From: $DownloadUrl"

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$Target = Join-Path $InstallDir $BinaryName
Invoke-WebRequest -Uri $DownloadUrl -OutFile $Target

Write-Host "Installed purr to $Target"

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ";") -notcontains $InstallDir) {
  [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
  Write-Host ""
  Write-Host "Added purr to your user PATH. Restart your terminal before running purr."
}

Write-Host ""
& $Target version
Write-Host "Installation complete!"
