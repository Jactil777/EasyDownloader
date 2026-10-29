$ErrorActionPreference = 'Stop'
$toolDir = Join-Path $PSScriptRoot 'tools'
New-Item -ItemType Directory -Force -Path $toolDir | Out-Null

function Download-File([string]$Uri, [string]$Destination) {
  $temporary = "$Destination.download"
  & curl.exe -L --fail --retry 5 --retry-delay 2 --connect-timeout 20 -o $temporary $Uri
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $Uri" }
  Move-Item -LiteralPath $temporary -Destination $Destination -Force
}

Write-Host 'Downloading yt-dlp...'
Download-File 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' (Join-Path $toolDir 'yt-dlp.exe')

Write-Host 'Downloading gallery-dl...'
$releaseInfo = Join-Path $env:TEMP 'local-downloader-gallery-release.json'
Download-File 'https://api.github.com/repos/mikf/gallery-dl/releases/latest' $releaseInfo
$galleryTag = (Get-Content -Raw -LiteralPath $releaseInfo | ConvertFrom-Json).tag_name
Remove-Item -LiteralPath $releaseInfo -Force
if (-not $galleryTag) { throw 'Could not determine the latest gallery-dl version.' }
Download-File "https://codeberg.org/mikf/gallery-dl/releases/download/$galleryTag/gallery-dl.exe" (Join-Path $toolDir 'gallery-dl.exe')

Write-Host 'Downloading FFmpeg...'
$archive = Join-Path $env:TEMP 'local-downloader-ffmpeg.zip'
$extract = Join-Path $env:TEMP 'local-downloader-ffmpeg'
Download-File 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' $archive
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
Expand-Archive -LiteralPath $archive -DestinationPath $extract -Force
$ffmpeg = Get-ChildItem -LiteralPath $extract -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1
if (-not $ffmpeg) { throw 'ffmpeg.exe was not found in the downloaded archive.' }
Copy-Item -LiteralPath $ffmpeg.FullName -Destination (Join-Path $toolDir 'ffmpeg.exe') -Force
Remove-Item -LiteralPath $archive -Force
Remove-Item -LiteralPath $extract -Recurse -Force

Write-Host 'Preparing PhantomJS...'
$phantomZip = Join-Path $env:TEMP ('easydownloader-phantom-' + [guid]::NewGuid().ToString('N') + '.zip')
$phantomExtract = Join-Path $env:TEMP ('easydownloader-phantom-' + [guid]::NewGuid().ToString('N'))
try {
  Download-File 'https://bitbucket.org/ariya/phantomjs/downloads/phantomjs-2.1.1-windows.zip' $phantomZip
  if ((Get-FileHash -LiteralPath $phantomZip -Algorithm SHA256).Hash -ne 'D9FB05623D6B26D3654D008EAB3ADAFD1F6350433DFD16138C46161F42C7DCC8') { throw 'PhantomJS archive checksum mismatch.' }
  Expand-Archive -LiteralPath $phantomZip -DestinationPath $phantomExtract -Force
  $phantomExe = Join-Path $phantomExtract 'phantomjs-2.1.1-windows\bin\phantomjs.exe'
  if (-not (Test-Path -LiteralPath $phantomExe)) { throw 'phantomjs.exe was not found in the verified archive.' }
  Copy-Item -LiteralPath $phantomExe -Destination (Join-Path $toolDir 'phantomjs.exe') -Force
} finally {
  if (Test-Path -LiteralPath $phantomZip) { Remove-Item -LiteralPath $phantomZip -Force }
  if (Test-Path -LiteralPath $phantomExtract) { Remove-Item -LiteralPath $phantomExtract -Recurse -Force }
}

Write-Host 'Installing the optional WeChat Channels parser...'
$wxRoot = Join-Path $toolDir 'wx-downloader'
$uvZip = Join-Path $env:TEMP 'local-downloader-uv.zip'
$uvExtract = Join-Path $env:TEMP 'local-downloader-uv'
Download-File 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' $uvZip
if (Test-Path -LiteralPath $uvExtract) { Remove-Item -LiteralPath $uvExtract -Recurse -Force }
Expand-Archive -LiteralPath $uvZip -DestinationPath $uvExtract -Force
$uv = Get-ChildItem -LiteralPath $uvExtract -Filter 'uv.exe' -Recurse | Select-Object -First 1
if (-not $uv) { throw 'uv.exe was not found in the downloaded archive.' }
$uvExe = Join-Path $toolDir 'uv.exe'
Copy-Item -LiteralPath $uv.FullName -Destination $uvExe -Force
Remove-Item -LiteralPath $uvZip -Force
Remove-Item -LiteralPath $uvExtract -Recurse -Force

$wxBin = Join-Path $wxRoot 'bin'
New-Item -ItemType Directory -Force -Path $wxBin | Out-Null
$env:UV_TOOL_DIR = Join-Path $wxRoot 'tools'
$env:UV_TOOL_BIN_DIR = $wxBin
$env:UV_PYTHON_INSTALL_DIR = Join-Path $wxRoot 'python'
$env:UV_CACHE_DIR = Join-Path $wxRoot 'cache'
& $uvExe tool install --python 3.12 'wx-downloader==0.1.2'
if ($LASTEXITCODE -ne 0) { throw 'Could not install the WeChat Channels parser.' }
& (Join-Path $wxBin 'wx-downloader.exe') --version
if ($LASTEXITCODE -ne 0) { throw 'The WeChat Channels parser did not start correctly.' }

# These are installation-only artifacts; the installed tool environment does not need them at runtime.
$uvCache = Join-Path $wxRoot 'cache'
if (Test-Path -LiteralPath $uvCache) { Remove-Item -LiteralPath $uvCache -Recurse -Force }
if (Test-Path -LiteralPath $uvExe) { Remove-Item -LiteralPath $uvExe -Force }

Write-Host 'All tools are ready.' -ForegroundColor Green
