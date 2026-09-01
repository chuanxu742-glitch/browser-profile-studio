[CmdletBinding()]
param(
  [string]$CheckoutRoot = $(if ($env:ABS_FIREFOX_CHECKOUT) { $env:ABS_FIREFOX_CHECKOUT } else { 'D:\abs-browser-core\firefox-153' })
)

$ErrorActionPreference = 'Stop'
$coreRoot = $PSScriptRoot
$lock = Get-Content -LiteralPath (Join-Path $coreRoot 'core.lock.json') -Raw | ConvertFrom-Json
$checkout = [IO.Path]::GetFullPath($CheckoutRoot)
$source = Join-Path $checkout 'mozilla-source'
$playwright = Join-Path $checkout 'inputs/playwright'
$mach = Join-Path $source 'mach.ps1'
if (-not (Test-Path -LiteralPath $mach)) { throw "Run prepare.ps1 first: missing $mach" }
if (-not (Test-Path -LiteralPath 'C:\mozilla-build')) {
  throw 'MozillaBuild is required on Windows. Install the official package, then rerun this script.'
}

Push-Location $source
try {
  & $mach build
  if ($LASTEXITCODE -ne 0) { throw "Firefox build failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

$dist = Join-Path $source 'obj-abs-firefox/dist/bin'
$executable = Join-Path $dist 'firefox.exe'
if (-not (Test-Path -LiteralPath $executable)) { throw "Build completed without $executable" }
$defaults = Join-Path $dist 'defaults/pref'
New-Item -ItemType Directory -Force -Path $defaults | Out-Null
Copy-Item -LiteralPath (Join-Path $playwright 'browser_patches/firefox/preferences/playwright.cfg') -Destination (Join-Path $dist 'playwright.cfg') -Force
Copy-Item -LiteralPath (Join-Path $playwright 'browser_patches/firefox/preferences/00-playwright-prefs.js') -Destination (Join-Path $defaults '00-playwright-prefs.js') -Force

$patchHashes = @()
foreach ($relativePatch in $lock.patches) {
  $patchHashes += [ordered]@{
    path = $relativePatch
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $coreRoot $relativePatch)).Hash.ToLowerInvariant()
  }
}
$provenance = [ordered]@{
  schemaVersion = 1
  engine = 'firefox'
  browserVersion = $lock.browserVersion
  playwrightVersion = $lock.playwrightVersion
  playwrightBrowserRevision = $lock.playwrightBrowserRevision
  playwrightGitRevision = $lock.playwrightGitRevision
  mozillaRevision = $lock.mozillaRevision
  patches = $patchHashes
  executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $executable).Hash.ToLowerInvariant()
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
$provenance | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $dist 'build-provenance.json') -Encoding utf8
Write-Output "Built and pinned Firefox core: $executable"
Write-Output "Set ABS_FIREFOX_EXECUTABLE_PATH=$executable to use it."
