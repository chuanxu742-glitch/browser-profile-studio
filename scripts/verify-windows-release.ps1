param(
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedZipSha256,
  [switch]$SkipManifest
)

$ErrorActionPreference = 'Stop'

function Assert-Condition([bool]$condition, [string]$message) {
  if (!$condition) { throw $message }
}

function Read-ReleaseJson([string]$path) {
  try { return (Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop) }
  catch { throw "Invalid release JSON at $path : $($_.Exception.Message)" }
}

function Assert-HexHash([object]$value, [string]$label) {
  Assert-Condition ($value -is [string] -and $value -cmatch '^[a-fA-F0-9]{64}$') "Invalid SHA-256 for $label"
}

function Assert-RelativePath([string]$path, [string]$label) {
  Assert-Condition ($path -and $path -cnotmatch '\\' -and $path -cnotmatch '[\x00-\x1f\x7f<>:"|?*]' -and !$path.StartsWith('/') -and !$path.EndsWith('/')) "Unsafe path in $label : $path"
  foreach ($part in $path.Split('/')) {
    Assert-Condition ($part -and $part -cne '.' -and $part -cne '..' -and !$part.EndsWith('.') -and !$part.EndsWith(' ') -and $part -cnotmatch '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') "Unsafe path component in $label : $path"
  }
}

function Get-Properties([object]$value, [string]$label) {
  Assert-Condition ($null -ne $value -and $value -is [pscustomobject]) "Expected JSON object: $label"
  return @($value.PSObject.Properties)
}

function Assert-SameJson([object]$expected, [object]$actual, [string]$label) {
  if ($expected -is [pscustomobject]) {
    $properties = Get-Properties $actual $label
    $expectedProperties = @(Get-Properties $expected $label)
    Assert-Condition ($properties.Count -eq $expectedProperties.Count) "Different JSON fields in $label"
    foreach ($property in $expectedProperties) {
      $matches = @($properties | Where-Object { $_.Name -ceq $property.Name })
      Assert-Condition ($matches.Count -eq 1) "Missing JSON field $($property.Name) in $label"
      Assert-SameJson $property.Value $matches[0].Value "$label.$($property.Name)"
    }
  } elseif ($expected -is [array]) {
    Assert-Condition ($actual -is [array] -and $actual.Count -eq $expected.Count) "Different JSON array in $label"
    for ($index = 0; $index -lt $expected.Count; $index++) {
      Assert-SameJson $expected[$index] $actual[$index] "$label[$index]"
    }
  } else {
    Assert-Condition ($null -ne $actual -and $expected.GetType() -eq $actual.GetType() -and $expected -ceq $actual) "Different JSON value in $label"
  }
}

function Assert-FileHash([string]$path, [string]$hash, [string]$label) {
  Assert-HexHash $hash $label
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $actual = [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
    finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
  Assert-Condition ($actual -ieq $hash) "SHA-256 mismatch: $label"
}

function Assert-PeX64([string]$path, [string]$label) {
  $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $reader = [System.IO.BinaryReader]::new($stream)
    Assert-Condition ($stream.Length -ge 256 -and $reader.ReadUInt16() -eq 0x5a4d) "$label is not a PE executable"
    $stream.Position = 0x3c
    $offset = [long]$reader.ReadUInt32()
    Assert-Condition ($offset -ge 0x40 -and $offset -le $stream.Length - 26) "$label has an invalid PE header offset"
    $stream.Position = $offset
    Assert-Condition ($reader.ReadUInt32() -eq 0x00004550) "$label has no PE signature"
    Assert-Condition ($reader.ReadUInt16() -eq 0x8664) "$label is not an x64 PE executable"
    $stream.Position = $offset + 20
    $optionalSize = $reader.ReadUInt16()
    Assert-Condition ($optionalSize -ge 2 -and $offset + 24 + $optionalSize -le $stream.Length) "$label has an invalid PE optional header"
    $stream.Position = $offset + 24
    Assert-Condition ($reader.ReadUInt16() -eq 0x20b) "$label is not PE32+ (x64)"
  } finally { $stream.Dispose() }
}

$root = [System.IO.Path]::GetFullPath($PackageRoot)
Assert-Condition ([System.IO.Directory]::Exists($root) -and $root.Length -gt [System.IO.Path]::GetPathRoot($root).Length) "PackageRoot must be a non-root directory: $root"
# Verify each ancestor, including the package root, before enumerating anything below it.
$current = $root
while ($current) {
  $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
  Assert-Condition (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) "Reparse point in package path: $current"
  $parent = [System.IO.Path]::GetDirectoryName($current)
  if (!$parent -or $parent -eq $current) { break }
  $current = $parent
}
$root = $root.TrimEnd([char[]]@('\', '/'))
$files = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
$names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$pending = [Collections.Generic.Stack[System.IO.DirectoryInfo]]::new()
$pending.Push([System.IO.DirectoryInfo]::new($root))
while ($pending.Count -gt 0) {
  foreach ($entry in $pending.Pop().EnumerateFileSystemInfos()) {
    $relative = $entry.FullName.Substring($root.Length + 1).Replace('\', '/')
    Assert-RelativePath $relative 'package tree'
    Assert-Condition ($names.Add($relative)) "Duplicate case-insensitive package path: $relative"
    Assert-Condition (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) "Link or reparse point in package: $relative"
    if (($entry.Attributes -band [System.IO.FileAttributes]::Directory) -ne 0) {
      $pending.Push([System.IO.DirectoryInfo]$entry)
    } else {
      Assert-Condition (($entry.Attributes -band [System.IO.FileAttributes]::Device) -eq 0) "Non-regular file in package: $relative"
      if ($relative -notmatch '^(?i:data)/') { $files.Add($relative, $entry.FullName) }
    }
  }
}

$required = @('node.exe', 'chromium/chrome.exe', 'chromium/chrome.dll', 'chromium/build-provenance.json',
  'browser-core/chromium/core.lock.json', 'package.json', 'package-lock.json',
  'RELEASE-METADATA.json', 'Start-Studio.bat', 'scripts/start-studio.ts',
  'scripts/verify-windows-release.ps1', 'scripts/install-windows-release.ps1',
  'node_modules/tsx/package.json', 'node_modules/playwright/package.json')
if (!$SkipManifest) { $required += 'PACKAGE-CONTENTS.sha256' }
foreach ($relative in $required) {
  Assert-Condition ($files.ContainsKey($relative)) "Missing package file: $relative"
}
foreach ($directory in @('src', 'public', 'dist', 'node_modules', 'chromium')) {
  Assert-Condition ($names.Contains($directory)) "Missing package directory: $directory"
}
if ($SkipManifest) {
  Assert-Condition (!$files.ContainsKey('PACKAGE-CONTENTS.sha256')) 'SkipManifest only applies before manifest creation'
} else {
  $manifestFiles = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
  $lines = [System.IO.File]::ReadAllLines($files['PACKAGE-CONTENTS.sha256'])
  Assert-Condition ($lines.Length -gt 0) 'Empty package contents manifest'
  foreach ($line in $lines) {
    $line = $line.TrimStart([char]0xfeff)
    $match = [regex]::Match($line, '^([a-fA-F0-9]{64})  (.+)$')
    Assert-Condition ($match.Success) "Invalid package contents line: $line"
    $relative = $match.Groups[2].Value
    Assert-RelativePath $relative 'package manifest'
    Assert-Condition ($relative -cne 'PACKAGE-CONTENTS.sha256' -and $relative -notmatch '^(?i:data)(/|$)') "Excluded file in manifest: $relative"
    Assert-Condition (!$manifestFiles.ContainsKey($relative)) "Duplicate case-insensitive manifest path: $relative"
    $manifestFiles.Add($relative, $match.Groups[1].Value)
  }
  Assert-Condition ($manifestFiles.Count -eq $files.Count - 1) 'Package manifest is not a complete file inventory'
  foreach ($relative in $manifestFiles.Keys) {
    Assert-Condition ($files.ContainsKey($relative)) "Unexpected manifest entry: $relative"
    Assert-Condition ($relative -ceq $files[$relative].Substring($root.Length + 1).Replace('\', '/')) "Manifest path case mismatch: $relative"
    Assert-FileHash $files[$relative] $manifestFiles[$relative] $relative
  }
}

$metadata = Read-ReleaseJson $files['RELEASE-METADATA.json']
$package = Read-ReleaseJson $files['package.json']
$lock = Read-ReleaseJson $files['browser-core/chromium/core.lock.json']
$installedPlaywright = Read-ReleaseJson $files['node_modules/playwright/package.json']
$provenance = Read-ReleaseJson $files['chromium/build-provenance.json']
foreach ($object in @($metadata, $package, $lock, $provenance, $installedPlaywright)) { $null = Get-Properties $object 'release identity' }
Assert-Condition ($metadata.packageKind -ceq 'offline-native-chromium-win-x64' -and $metadata.target -ceq 'win-x64' -and
  $metadata.unsigned -is [bool] -and $metadata.unsigned -eq $true -and
  ($metadata.nodeMajor -is [int] -or $metadata.nodeMajor -is [long]) -and $metadata.nodeMajor -eq 22) 'Invalid Windows release metadata identity'
Assert-HexHash $metadata.nativeArchiveSha256 'native archive metadata'
Assert-Condition ($metadata.sourceCommit -is [string] -and $metadata.sourceCommit -cmatch '^[a-f0-9]{40}$') 'Invalid release source commit'
if ($PSBoundParameters.ContainsKey('ExpectedZipSha256')) {
  Assert-Condition ($metadata.nativeArchiveSha256 -ieq $ExpectedZipSha256) 'Native archive digest differs from independently expected digest'
}
Assert-Condition ($metadata.applicationVersion -is [string] -and $metadata.applicationVersion -ceq $package.version) 'Application version differs across release and application'
Assert-Condition ($metadata.playwrightVersion -is [string] -and $metadata.playwrightVersion -ceq $package.dependencies.playwright -and
  $metadata.playwrightVersion -ceq $lock.playwrightVersion -and
  $metadata.playwrightVersion -ceq $installedPlaywright.version) 'Playwright version differs across release, lock and installed runtime'
Assert-Condition (($lock.schemaVersion -is [int] -or $lock.schemaVersion -is [long]) -and $lock.schemaVersion -eq 1 -and $lock.engine -ceq 'chromium') 'Invalid native core lock identity'
Assert-Condition (@(Get-Properties $provenance 'native provenance').Count -eq
  @(Get-Properties $lock 'native core lock').Count + 4) 'Unexpected native provenance fields'
foreach ($property in (Get-Properties $lock 'native core lock')) {
  $matches = @((Get-Properties $provenance 'native provenance') | Where-Object { $_.Name -ceq $property.Name })
  Assert-Condition ($matches.Count -eq 1) "Missing native lock field in provenance: $($property.Name)"
  Assert-SameJson $property.Value $matches[0].Value "provenance.$($property.Name)"
}
Assert-Condition ($provenance.target -ceq 'win-x64') 'Native provenance target is not win-x64'
Assert-HexHash $provenance.argsSha256 'native build arguments'
Assert-HexHash $provenance.executableSha256 'native executable'
$native = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($relative in $files.Keys) {
  if ($relative.StartsWith('chromium/', [StringComparison]::OrdinalIgnoreCase) -and $relative -ine 'chromium/build-provenance.json') {
    $native.Add($relative.Substring('chromium/'.Length), $files[$relative])
  }
}
$provenanceFiles = @(Get-Properties $provenance.files 'native provenance files')
Assert-Condition ($provenanceFiles.Count -eq $native.Count) 'Native provenance is not a complete core file inventory'
$seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($entry in $provenanceFiles) {
  Assert-RelativePath $entry.Name 'native provenance files'
  Assert-Condition ($seen.Add($entry.Name) -and $native.ContainsKey($entry.Name)) "Unknown or duplicate native file: $($entry.Name)"
  Assert-Condition ($entry.Name -ceq $native[$entry.Name].Substring($root.Length + 1 + 'chromium/'.Length).Replace('\', '/')) "Native provenance path case mismatch: $($entry.Name)"
  Assert-HexHash $entry.Value "native file $($entry.Name)"
  Assert-FileHash $native[$entry.Name] $entry.Value "chromium/$($entry.Name)"
}
Assert-Condition ($seen.Contains('chrome.exe') -and $provenance.files.'chrome.exe' -ieq $provenance.executableSha256) 'Native executable digest differs from provenance inventory'
Assert-PeX64 $files['node.exe'] 'node.exe'
$nodeVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($files['node.exe'])
Assert-Condition ($nodeVersion.FileMajorPart -eq 22) 'node.exe does not declare Node.js major version 22'
Assert-PeX64 $files['chromium/chrome.exe'] 'chromium/chrome.exe'
