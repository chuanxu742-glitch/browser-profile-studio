param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [Parameter(Mandatory = $true)][string]$NativeArchive,
  [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$NativeArchiveSha256
)
$ErrorActionPreference = 'Stop'
if (!(Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = Split-Path -Parent $PSScriptRoot
$lock = Get-Content -LiteralPath (Join-Path $root 'browser-core/chromium/core.lock.json') -Raw | ConvertFrom-Json
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$expectedName = "abs-chromium-$($lock.browserVersion)-win-x64.zip"
$archive = (Resolve-Path -LiteralPath $NativeArchive -ErrorAction Stop).Path
if ([IO.Path]::GetFileName($archive) -cne $expectedName) { throw "Expected native archive $expectedName, got $archive" }
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $NativeArchiveSha256) { throw 'Native archive SHA-256 differs from independently supplied digest.' }
$zipFile = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $totalSize = [long]0
  if ($zipFile.Entries.Count -gt 100000) { throw 'Native archive has too many entries.' }
  foreach ($entry in $zipFile.Entries) {
    $name = $entry.FullName
    if ($name -cnotmatch '^chromium/' -or $name -match '[\\:]' -or $name -match '(^|/)\.\.?(/|$)' -or $name -match '//') { throw "Unsafe native archive entry: $name" }
    if (!$names.Add($name.TrimEnd('/'))) { throw "Duplicate native archive entry: $name" }
    $unixMode = ($entry.ExternalAttributes -shr 16) -band 0xF000
    if ($unixMode -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { throw "Link/reparse native entry: $name" }
    if ($name.EndsWith('/') -and $entry.Length -ne 0) { throw "Invalid directory: $name" }
    $totalSize += $entry.Length
    if ($totalSize -gt 12GB) { throw 'Native archive exceeds the unpacked size limit.' }
  }
  if (!$names.Contains('chromium/chrome.exe') -or !$names.Contains('chromium/chrome.dll') -or !$names.Contains('chromium/build-provenance.json')) { throw 'Native archive lacks chrome.exe, chrome.dll or provenance.' }
} finally { $zipFile.Dispose() }
if (!(Test-Path -LiteralPath (Join-Path $root 'dist/index.js') -PathType Leaf)) { throw 'Run npm run build before packaging.' }
if (!(Test-Path -LiteralPath (Join-Path $root 'node_modules/tsx/package.json') -PathType Leaf)) { throw 'Run npm ci --include=dev before packaging.' }
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nodeVersion = (& $node --version).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v22\.[0-9]+\.[0-9]+$') { throw 'Packaging requires Node.js 22 Windows x64.' }
$nodePlatform = (& $node -p process.platform).Trim()
if ($LASTEXITCODE -ne 0 -or $nodePlatform -cne 'win32') { throw 'Packaging requires Windows Node.js.' }
$nodeArch = (& $node -p process.arch).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeArch -cne 'x64') { throw 'Packaging requires x64 Node.js.' }
$commit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve source commit.' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$output = (Resolve-Path -LiteralPath $OutputDirectory).Path
$name = "browser-profile-studio-$($package.version)-win-x64-unsigned-native"
$staging = Join-Path $output $name
$releaseZip = Join-Path $output "$name.zip"
$hashes = Join-Path $output 'SHA256SUMS.txt'
$metadataOut = Join-Path $output 'RELEASE-METADATA.json'
if ((Test-Path -LiteralPath $hashes) -or (Test-Path -LiteralPath $metadataOut)) { throw 'Output metadata already exists; use a clean release directory.' }
if ((Test-Path -LiteralPath $staging) -or (Test-Path -LiteralPath $releaseZip)) { throw 'Production staging directory or ZIP already exists.' }
New-Item -ItemType Directory -Path $staging | Out-Null
$complete = $false
try {
  Expand-Archive -LiteralPath $archive -DestinationPath $staging
  foreach ($item in @('src', 'dist', 'public', 'node_modules', 'browser-bridge-extension', 'scripts/start-studio.ts', 'scripts/verify-windows-release.ps1', 'scripts/install-windows-release.ps1', 'scripts/smoke-windows-native-release.mjs', 'package.json', 'package-lock.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.md', 'browser-core/chromium/core.lock.json')) {
    $source = Join-Path $root $item
    if (!(Test-Path -LiteralPath $source)) { throw "Missing required application payload: $item" }
    $target = Join-Path $staging $item
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
  }
  Copy-Item -LiteralPath $node -Destination (Join-Path $staging 'node.exe')
  # Resolve both the TS loader and Playwright from the copied payload, not the build checkout.
  Push-Location $staging
  try {
    & (Join-Path $staging 'node.exe') --import tsx/esm -e 'if(!require(process.argv.at(-1)).chromium)process.exitCode=1' playwright
    if ($LASTEXITCODE -ne 0) { throw 'Bundled Node cannot load bundled tsx/Playwright without installation.' }
  } finally { Pop-Location }
  # The browser cache is intentionally absent: the verified native runtime is the only bundled Chromium.
  [ordered]@{
    applicationVersion = $package.version
    packageKind = 'offline-native-chromium-win-x64'
    target = 'win-x64'
    sourceCommit = $commit
    nativeArchiveSha256 = $NativeArchiveSha256.ToLowerInvariant()
    unsigned = $true
    nodeMajor = 22
    playwrightVersion = $package.dependencies.playwright
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $staging 'RELEASE-METADATA.json') -Encoding utf8
  @'
@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify-windows-release.ps1" -PackageRoot "%~dp0."
if errorlevel 1 (echo Release integrity check failed. & exit /b 1)
set "ABS_CHROMIUM_EXECUTABLE_PATH=%~dp0chromium\chrome.exe"
set "ABS_REQUIRE_NATIVE_CHROMIUM=1"
set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
"%~dp0node.exe" --import tsx/esm scripts/start-studio.ts
if errorlevel 1 pause
'@ | Set-Content -LiteralPath (Join-Path $staging 'Start-Studio.bat') -Encoding ascii
  & (Join-Path $staging 'scripts/verify-windows-release.ps1') -PackageRoot $staging -ExpectedZipSha256 $NativeArchiveSha256 -SkipManifest
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Native core preflight failed.' }
  $manifest = @(Get-ChildItem -LiteralPath $staging -Recurse -File -Force | Sort-Object FullName | ForEach-Object {
    $relative = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
  })
  $manifest | Set-Content -LiteralPath (Join-Path $staging 'PACKAGE-CONTENTS.sha256') -Encoding utf8
  & (Join-Path $staging 'scripts/verify-windows-release.ps1') -PackageRoot $staging -ExpectedZipSha256 $NativeArchiveSha256
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw 'Release integrity validation failed.' }
  [IO.Compression.ZipFile]::CreateFromDirectory($staging, $releaseZip, [IO.Compression.CompressionLevel]::Optimal, $true)
  "$((Get-FileHash -LiteralPath $releaseZip -Algorithm SHA256).Hash.ToLowerInvariant())  $name.zip" | Set-Content -LiteralPath $hashes -Encoding ascii
  Copy-Item -LiteralPath (Join-Path $staging 'RELEASE-METADATA.json') -Destination $metadataOut
  $complete = $true
  Write-Output "Created unsigned offline native package: $releaseZip"
} finally {
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  if (!$complete) {
    foreach ($partial in @($releaseZip, $hashes, $metadataOut)) {
      if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force }
    }
  }
}
