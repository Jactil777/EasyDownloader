param(
  [switch]$UpdateTools,
  [switch]$PublishRelease
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

if ($PublishRelease -and -not ($env:GH_TOKEN -or $env:GITHUB_TOKEN)) {
  throw 'Publishing requires GH_TOKEN or GITHUB_TOKEN. Do not put the token in project files.'
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$Failure) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

function Download-File([string]$Uri, [string]$Destination) {
  & curl.exe -L --fail --retry 3 --connect-timeout 20 -o $Destination $Uri
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Uri" }
}

$requiredTools = @(
  'tools\yt-dlp.exe',
  'tools\gallery-dl.exe',
  'tools\ffmpeg.exe',
  'tools\wx-downloader\bin\wx-downloader.exe'
)
$toolsMissing = @($requiredTools | Where-Object { -not (Test-Path -LiteralPath $_) }).Count -gt 0
if ($UpdateTools -or $toolsMissing) {
  Write-Host 'Updating downloader tools...'
  Invoke-Checked 'powershell.exe' @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'install-tools.ps1')) 'Tool installation failed.'
}

$runtimeNode = Join-Path $PSScriptRoot 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $runtimeNode)) {
  Write-Host 'Preparing the embedded Node.js runtime...'
  $tempRoot = Join-Path $env:TEMP ("easydownloader-build-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tempRoot | Out-Null
  try {
    $releaseIndex = Join-Path $tempRoot 'index.json'
    Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -OutFile $releaseIndex
    $release = $null
    foreach ($candidate in (ConvertFrom-Json (Get-Content -Raw -LiteralPath $releaseIndex))) {
      if ($candidate.lts) { $release = $candidate; break }
    }
    if (-not $release) { throw 'Could not determine the current Node.js LTS release.' }
    $version = $release.version
    $archive = Join-Path $tempRoot 'node.zip'
    $extract = Join-Path $tempRoot 'node'
    Download-File "https://nodejs.org/dist/$version/node-$version-win-x64.zip" $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
    $nodeSource = Join-Path $extract "node-$version-win-x64\node.exe"
    if (-not (Test-Path -LiteralPath $nodeSource)) { throw 'node.exe was not found in the runtime archive.' }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $runtimeNode) | Out-Null
    Copy-Item -LiteralPath $nodeSource -Destination $runtimeNode -Force
  }
  finally {
    if (Test-Path -LiteralPath $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force }
  }
}

if (-not (Test-Path -LiteralPath 'node_modules\electron-builder\cli.js') -or -not (Test-Path -LiteralPath 'node_modules\electron\package.json') -or -not (Test-Path -LiteralPath 'node_modules\electron-updater\package.json')) {
  Write-Host 'Installing packaging dependencies...'
  if (Test-Path -LiteralPath 'package-lock.json') {
    Invoke-Checked 'npm.cmd' @('ci', '--no-audit', '--no-fund') 'Dependency installation failed.'
  }
  else {
    Invoke-Checked 'npm.cmd' @('install', '--no-audit', '--no-fund') 'Dependency installation failed.'
  }
}

# uv and its package cache are only needed while installing the optional parser.
$uvCache = Join-Path $PSScriptRoot 'tools\wx-downloader\cache'
$uvBootstrap = Join-Path $PSScriptRoot 'tools\uv.exe'
if (Test-Path -LiteralPath $uvCache) { Remove-Item -LiteralPath $uvCache -Recurse -Force }
if (Test-Path -LiteralPath $uvBootstrap) { Remove-Item -LiteralPath $uvBootstrap -Force }

Invoke-Checked 'npm.cmd' @('run', 'check') 'Source checks failed.'
Write-Host 'Building the Windows installer...'
if ($PublishRelease) {
  Invoke-Checked 'npx.cmd' @('electron-builder', '--win', 'nsis', '--x64', '--publish', 'always') 'Installer build or GitHub Release upload failed.'
}
else {
  Invoke-Checked 'npx.cmd' @('electron-builder', '--win', 'nsis', '--x64', '--publish', 'never') 'Installer build failed.'
}
Write-Host "Installer is ready in: $PSScriptRoot\release" -ForegroundColor Green
