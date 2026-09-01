[CmdletBinding()]
param(
  [string]$CheckoutRoot = $(if ($env:ABS_FIREFOX_CHECKOUT) { $env:ABS_FIREFOX_CHECKOUT } else { 'D:\abs-browser-core\firefox-153' }),
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$coreRoot = $PSScriptRoot
$lock = Get-Content -LiteralPath (Join-Path $coreRoot 'core.lock.json') -Raw | ConvertFrom-Json
$checkout = [IO.Path]::GetFullPath($CheckoutRoot)
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($checkout).TrimEnd('\').TrimEnd(':'))
if ($drive.Free -lt 40GB) {
  throw "Firefox preparation requires at least 40 GB free on $($drive.Name):; found $([math]::Round($drive.Free / 1GB, 1)) GB"
}

$source = Join-Path $checkout 'mozilla-source'
$inputs = Join-Path $checkout 'inputs'
$playwright = Join-Path $inputs 'playwright'
$marker = Join-Path $checkout '.abs-prepared.json'
if ((Test-Path -LiteralPath $marker) -and -not $Force) {
  Write-Output "Already prepared: $checkout"
  exit 0
}

New-Item -ItemType Directory -Force -Path $checkout, $inputs | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $playwright '.git'))) {
  git clone --filter=blob:none --no-checkout $lock.playwrightRepository $playwright
}
git -C $playwright fetch --depth 1 origin $lock.playwrightGitRevision
git -C $playwright checkout --detach $lock.playwrightGitRevision
git -C $playwright sparse-checkout init --cone
git -C $playwright sparse-checkout set browser_patches/firefox

if (-not (Test-Path -LiteralPath (Join-Path $source '.git'))) {
  git clone --filter=blob:none --no-checkout $lock.mozillaRepository $source
}
git -C $source fetch --depth 1 origin $lock.mozillaRevision
git -C $source checkout --detach $lock.mozillaRevision

$bootstrapPatch = Join-Path $playwright 'browser_patches/firefox/patches/bootstrap.diff'
git -C $source apply --check $bootstrapPatch
git -C $source apply $bootstrapPatch
Copy-Item -LiteralPath (Join-Path $playwright 'browser_patches/firefox/juggler') -Destination (Join-Path $source 'juggler') -Recurse -Force
Copy-Item -LiteralPath (Join-Path $coreRoot 'mozconfig') -Destination (Join-Path $source '.mozconfig') -Force

foreach ($relativePatch in $lock.patches) {
  $patch = Join-Path $coreRoot $relativePatch
  git -C $source apply --check $patch
  git -C $source apply $patch
}

$prepared = [ordered]@{
  schemaVersion = 1
  preparedAt = (Get-Date).ToUniversalTime().ToString('o')
  browserVersion = $lock.browserVersion
  playwrightVersion = $lock.playwrightVersion
  playwrightBrowserRevision = $lock.playwrightBrowserRevision
  playwrightGitRevision = $lock.playwrightGitRevision
  mozillaRevision = $lock.mozillaRevision
}
$prepared | ConvertTo-Json | Set-Content -LiteralPath $marker -Encoding utf8
Write-Output "Prepared Firefox source: $source"
