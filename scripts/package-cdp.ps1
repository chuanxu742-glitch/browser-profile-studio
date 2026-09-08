param([string]$Name = ('antigravity-cdp-source-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
$ErrorActionPreference = 'Stop'
if ($Name -notmatch '^[a-zA-Z0-9_-]+$') { throw 'Invalid bundle name' }
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bundleRoot = Join-Path $projectRoot "artifacts/releases/$Name"
if (Test-Path -LiteralPath $bundleRoot) { throw 'Bundle directory already exists; choose a new name' }
New-Item -ItemType Directory -Path $bundleRoot | Out-Null
foreach ($item in @('src','tests','examples','docs','package.json','package-lock.json','tsconfig.json','tsconfig.build.json','Dockerfile.cdp','docker-compose.cdp.yml','.dockerignore','README.md','LICENSE','NOTICE','THIRD_PARTY_NOTICES.md')) {
  Copy-Item -LiteralPath (Join-Path $projectRoot $item) -Destination $bundleRoot -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $bundleRoot 'scripts') | Out-Null
foreach ($script in @('smoke-cdp.mjs','package-cdp.ps1')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination (Join-Path $bundleRoot 'scripts')
}
$utf8 = [Text.UTF8Encoding]::new($false)
[IO.File]::WriteAllText((Join-Path $bundleRoot 'BUILD-STATUS.txt'), 'Source build bundle, not a docker load image. See docs/docker-cdp.md for validation status.', $utf8)
$manifest = Get-ChildItem -LiteralPath $bundleRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
  $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $relative = [IO.Path]::GetRelativePath($bundleRoot, $_.FullName).Replace('\','/')
  "$hash  $relative"
}
[IO.File]::WriteAllLines((Join-Path $bundleRoot 'SHA256SUMS'), $manifest, $utf8)
$zip = "$bundleRoot.zip"
Compress-Archive -Path (Join-Path $bundleRoot '*') -DestinationPath $zip
$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText("$zip.sha256", "$zipHash  $Name.zip`n", $utf8)
Write-Output $zip
Write-Output $zipHash
