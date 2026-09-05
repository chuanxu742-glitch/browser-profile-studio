param(
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (!(Test-Path 'dist/index.js')) { throw 'Run npm run build before packaging.' }
$commit = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve source commit.' }
$package = Get-Content package.json -Raw | ConvertFrom-Json
$run = if ($env:GITHUB_RUN_ID) { "$($env:GITHUB_RUN_ID).$($env:GITHUB_RUN_ATTEMPT)" } else { 'local' }
$name = "browser-profile-studio-$($package.version)-windows-x64-unsigned-test-$run"
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
$output = (Resolve-Path $OutputDirectory).Path
$staging = Join-Path $output $name
if (Test-Path $staging) { throw "Package staging already exists: $staging" }
New-Item -ItemType Directory $staging | Out-Null
$sourceZip = Join-Path $output 'source.zip'
# Only committed, explicitly selected application sources; never local data, credentials or binaries.
git archive --format=zip --output=$sourceZip HEAD src scripts public tests docs browser-bridge-extension browser-core package.json package-lock.json tsconfig.json tsconfig.build.json README.md LICENSE NOTICE THIRD_PARTY_NOTICES.md SECURITY.md CONTRIBUTING.md .env.example mcp-config.example.json start-browser-studio.bat
if ($LASTEXITCODE -ne 0) { throw 'Cannot archive committed application source.' }
Expand-Archive -LiteralPath $sourceZip -DestinationPath $staging
Remove-Item -LiteralPath $sourceZip
Copy-Item dist (Join-Path $staging 'dist') -Recurse
@'
UNSIGNED WINDOWS TEST PACKAGE - NOT AN INSTALLER OR STANDALONE EXECUTABLE

Prerequisites: supported Windows x64, Node.js 22 LTS with npm on PATH,
network access to npm and Playwright browser downloads. Edge/Chrome (or a
configured default browser) is needed for the automatic Studio desktop window.

1. Extract the ZIP to a writable folder. Open PowerShell in that folder.
2. npm ci
   Include development dependencies: the real Studio entry uses tsx and src/.
3. npm run install:browsers
   Downloads the exact lockfile-compatible stock Firefox and Chromium into the
   current user's Playwright cache. Node/dependencies/browsers are NOT bundled.
4. npm run studio
   Or double-click start-browser-studio.bat after completing steps 2-3.
   Studio listens only on 127.0.0.1:3000 and opens a one-time authenticated URL.
   Keep the terminal open; Ctrl+C stops Studio. Set STUDIO_PORT for another port.

The ZIP includes src/, scripts/, public/, tests/, dist/, exact npm manifests,
TypeScript configuration, browser bridge extension and custom-core SOURCE only.
MCP users may use npm start after configuring the environment per README.md.
This is an unsigned test distribution, not a production qualification or stable
release. No signing certificate, native Launcher.exe, custom Firefox binary,
Node runtime, npm dependency, browser executable, account or secret is included.
First launch creates sensitive data/ including Windows DPAPI-protected local
credentials. Protect this folder and do not upload it with support reports.

Compatibility: use the Playwright version pinned in package-lock.json. Do not
replace browsers with arbitrary system executables or update Playwright without
runtime review. Stock Firefox basic smoke is separate from deep fingerprint
acceptance: Firefox Worker Canvas full consistency remains NOT PASSED. Optional
integration cases may skip; successful CI does not imply their acceptance.

License: project Apache-2.0 (LICENSE and NOTICE). Dependencies retain their own
licenses (THIRD_PARTY_NOTICES.md and installed packages). Mozilla source patches
in browser-core/ remain subject to applicable Mozilla/source availability terms;
no browser binary is redistributed here.

Verify the downloaded ZIP against SHA256SUMS.txt with Get-FileHash -Algorithm
SHA256. PACKAGE-CONTENTS.sha256 lists each payload file hash. SHA-256 detects
changes but is NOT a publisher signature. RELEASE-METADATA.json records source
commit, application version, run and explicit unsigned status.
'@ | Set-Content (Join-Path $staging 'INSTALL-WINDOWS.txt') -Encoding utf8
[ordered]@{
  applicationVersion = $package.version
  sourceCommit = $commit
  githubRun = $run
  platform = 'windows-x64'
  unsigned = $true
  prerelease = $true
  packageKind = 'source-and-built-runtime-with-first-run-dependency-install'
  requiredNodeMajor = 22
  buildNodeVersion = (node --version).Trim()
  playwright = $package.dependencies.playwright
  firefoxWorkerCanvas = 'NOT PASSED'
} | ConvertTo-Json | Set-Content (Join-Path $staging 'RELEASE-METADATA.json') -Encoding utf8
$manifest = Get-ChildItem $staging -File -Recurse | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($staging.Length + 1).Replace('\', '/')
  "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
}
$manifest | Set-Content (Join-Path $staging 'PACKAGE-CONTENTS.sha256') -Encoding utf8
$zip = Join-Path $output "$name.zip"
Compress-Archive -Path $staging -DestinationPath $zip
"$((Get-FileHash $zip -Algorithm SHA256).Hash.ToLowerInvariant())  $name.zip" | Set-Content (Join-Path $output 'SHA256SUMS.txt') -Encoding utf8
Copy-Item (Join-Path $staging 'RELEASE-METADATA.json') $output
Copy-Item (Join-Path $staging 'PACKAGE-CONTENTS.sha256') $output
Copy-Item (Join-Path $staging 'INSTALL-WINDOWS.txt') $output
Write-Output "Created $zip"
