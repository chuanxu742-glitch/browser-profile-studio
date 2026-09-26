param(
  [Parameter(Mandatory = $true)][string]$ScratchDirectory,
  [Parameter(Mandatory = $true)][string]$InstallRoot,
  [string]$ArchivePath,
  [string]$FixtureExpectedSha256
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (!(Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
}
$pin = '1cfbe638212ba4d463a8c3330fcfbd8c88f9844ff6dfc0722f2c40745e0bc7f8'
$url = 'https://github.com/xiaozhou26/Chromix/releases/download/v152.0.7977.82/chromix-win-x64.zip'
if ($FixtureExpectedSha256) {
  if ($env:CHROMIX_INSTALL_FIXTURE_TEST -cne '1' -or !$ArchivePath -or $FixtureExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw 'Fixture digest override requires CHROMIX_INSTALL_FIXTURE_TEST=1, ArchivePath, and a SHA-256.'
  }
} elseif ($env:CHROMIX_INSTALL_FIXTURE_TEST -eq '1') {
  throw 'Fixture mode requires an explicit fixture digest.'
}
$expected = if ($FixtureExpectedSha256) { $FixtureExpectedSha256 } else { $pin }

function FullPath([string]$path) { return [System.IO.Path]::GetFullPath($path).TrimEnd([char[]]@('\', '/')) }
function Within([string]$path, [string]$parent) {
  return $path.StartsWith($parent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
}
function Assert-PlainAncestors([string]$path) {
  $current = $path
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Reparse point in path: $current" }
    }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if (!$parent -or $parent -eq $current) { break }
    $current = $parent
  }
}
function Check-PE([string]$path, [bool]$dll) {
  $stream = [System.IO.File]::OpenRead($path)
  $reader = New-Object System.IO.BinaryReader($stream)
  try {
    if ($stream.Length -lt 256 -or $reader.ReadUInt16() -ne 0x5a4d) { throw "Invalid PE DOS header: $path" }
    $stream.Position = 0x3c
    $offset = $reader.ReadInt32()
    if ($offset -lt 64 -or $offset -gt ($stream.Length - 26)) { throw "Invalid PE offset: $path" }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) { throw "Not a Windows x64 PE: $path" }
    $stream.Position = $offset + 22
    $flags = $reader.ReadUInt16()
    if (($flags -band 0x0002) -eq 0 -or (($flags -band 0x2000) -ne 0) -ne $dll) { throw "Incorrect PE executable/DLL flags: $path" }
    $stream.Position = $offset + 24
    if ($reader.ReadUInt16() -ne 0x20b) { throw "Not a PE32+ x64 image: $path" }
  } finally { $reader.Dispose(); $stream.Dispose() }
}
function SafeMember([System.IO.Compression.ZipArchiveEntry]$entry) {
  $name = $entry.FullName.Replace('\', '/')
  if (!$name -or $name.StartsWith('/') -or $name -match '[\x00-\x1f\x7f:]' -or
      $name -match '(^|/)\.{1,2}(/|$)' -or $name -match '//') { throw "Unsafe ZIP path: $($entry.FullName)" }
  $directory = $name.EndsWith('/')
  $segments = $name.TrimEnd('/').Split('/')
  if ($segments[0] -cne 'chromix') { throw "ZIP member outside chromix/: $($entry.FullName)" }
  foreach ($segment in $segments) {
    if ($segment -match '[<>"|?*]' -or $segment -match '[ .]$' -or
        $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
      throw "Windows-unsafe ZIP path: $($entry.FullName)"
    }
  }
  if ($segments.Count -eq 1 -and !$directory) { throw 'chromix root must be a directory.' }
  if ($name -ieq 'chromix/chromix-install.json') { throw 'Archive cannot supply installer manifest.' }
  $attributes = $entry.ExternalAttributes
  $dos = $attributes -band 0xffff
  $unixMode = ($attributes -shr 16) -band 0xffff
  $kind = $unixMode -band 0xf000
  if (($dos -band 0x400) -ne 0 -or ($dos -band 0x800) -ne 0 -or
      ($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) -or
      ($kind -eq 0x4000 -and !$directory) -or ($kind -eq 0x8000 -and $directory)) {
    throw "Reparse, special, or inconsistent ZIP entry: $($entry.FullName)"
  }
  return @{ Name = $name.TrimEnd('/'); Directory = $directory }
}

$scratch = FullPath $ScratchDirectory
$root = FullPath $InstallRoot
$destination = Join-Path $root 'chromix'
if ($scratch -eq $root -or (Within $scratch $root) -or (Within $root $scratch) -or
    $root -eq [System.IO.Path]::GetPathRoot($root).TrimEnd([char[]]@('\', '/'))) {
  throw 'ScratchDirectory and InstallRoot must be separate non-nested, non-root paths.'
}
Assert-PlainAncestors $scratch
Assert-PlainAncestors $root
if (!(Test-Path -LiteralPath $scratch -PathType Container)) { throw "Explicit scratch directory must exist: $scratch" }
if (Test-Path -LiteralPath $destination) { throw "Chromix installation already exists: $destination" }
if (!(Test-Path -LiteralPath $root -PathType Container)) { throw "Explicit install root must exist: $root" }
if ($ArchivePath) {
  $archive = FullPath $ArchivePath
  if (!(Within $archive $scratch) -or !(Test-Path -LiteralPath $archive -PathType Leaf)) {
    throw 'ArchivePath must be an existing regular file within explicit ScratchDirectory.'
  }
  Assert-PlainAncestors $archive
} else {
  $archive = Join-Path $scratch ('chromix-win-x64-' + [guid]::NewGuid().ToString('N') + '.zip')
  $curl = Get-Command curl.exe -ErrorAction Stop
  try {
    & $curl.Source --fail --location --silent --show-error --proto '=https' --proto-redir '=https' --output $archive $url
    if ($LASTEXITCODE -ne 0) { throw "Official Chromix download failed (curl exit $LASTEXITCODE)." }
  } catch { Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue; throw }
}
$stage = Join-Path $root ('.chromix-stage-' + [guid]::NewGuid().ToString('N'))
# Keep one handle open from hashing through extraction. Read sharing disallows
# another process replacing/writing the verified scratch ZIP on Windows.
$source = [System.IO.File]::Open($archive, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
$zip = $null
try {
  # Fixture-only handshake proves the read lock before an adversarial writer
  # probes it; production never creates or waits on these test signal files.
  if ($FixtureExpectedSha256 -and $env:CHROMIX_INSTALL_FIXTURE_LOCK_SIGNAL) {
    $signal = FullPath $env:CHROMIX_INSTALL_FIXTURE_LOCK_SIGNAL
    $ack = "$signal.ack"
    if (!(Within $signal $scratch) -or !(Within $ack $scratch) -or
        (Test-Path -LiteralPath $signal) -or (Test-Path -LiteralPath $ack)) {
      throw 'Fixture lock signal must name new files within scratch.'
    }
    $marker = [System.IO.File]::Open($signal, [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $marker.Dispose()
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    while (!(Test-Path -LiteralPath $ack)) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Timed out waiting for fixture lock probe.' }
      Start-Sleep -Milliseconds 10
    }
  }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $actual = [BitConverter]::ToString($sha.ComputeHash($source)).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($actual -cne $expected) { throw "Chromix ZIP SHA-256 mismatch: expected $expected; got $actual" }
  $source.Position = 0
  $zip = New-Object System.IO.Compression.ZipArchive($source, [System.IO.Compression.ZipArchiveMode]::Read, $true)
  $members = New-Object 'System.Collections.Generic.List[object]'
  $seen = New-Object 'System.Collections.Generic.Dictionary[string,bool]' ([System.StringComparer]::OrdinalIgnoreCase)
  $total = [long]0
  foreach ($entry in $zip.Entries) {
    $member = SafeMember $entry
    if ($seen.ContainsKey($member.Name)) { throw "Duplicate ZIP path (including case/separator): $($entry.FullName)" }
    $seen.Add($member.Name, $member.Directory)
    $total += $entry.Length
    if ($entry.Length -gt 1073741824 -or $total -gt 2147483648 -or $members.Count -ge 20000) {
      throw 'ZIP exceeds extraction size or entry limit.'
    }
    $members.Add(@{ Entry = $entry; Path = $member.Name; Directory = $member.Directory })
  }
  foreach ($member in $members) {
    $parts = $member.Path.Split('/')
    for ($i = 1; $i -lt $parts.Length; $i++) {
      $parent = [string]::Join('/', $parts[0..($i - 1)])
      if ($seen.ContainsKey($parent) -and !$seen[$parent]) { throw "File/directory ZIP collision: $($member.Path)" }
    }
  }
  if (!$seen.ContainsKey('chromix/chrome.exe') -or $seen['chromix/chrome.exe'] -or
      !$seen.ContainsKey('chromix/chrome.dll') -or $seen['chromix/chrome.dll']) {
    throw 'Archive must contain chromix/chrome.exe and chromix/chrome.dll.'
  }
  $null = New-Item -ItemType Directory -Path $stage
  $installed = Join-Path $stage 'chromix'
  $null = New-Item -ItemType Directory -Path $installed
  $files = [ordered]@{}
  foreach ($member in $members) {
    $relative = $member.Path.Substring('chromix'.Length).TrimStart('/')
    if (!$relative) { continue }
    $target = Join-Path $installed ($relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar))
    if ($member.Directory) {
      $null = New-Item -ItemType Directory -Path $target -Force
    } else {
      $parent = [System.IO.Path]::GetDirectoryName($target)
      $null = New-Item -ItemType Directory -Path $parent -Force
      $inputStream = $member.Entry.Open()
      try {
        $outputStream = [System.IO.File]::Open($target, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
      $files[$relative] = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  Check-PE (Join-Path $installed 'chrome.exe') $false
  Check-PE (Join-Path $installed 'chrome.dll') $true
  $manifest = [ordered]@{
    schemaVersion = 1
    distribution = 'chromix-152'
    browserVersion = '152.0.7977.82'
    archiveSha256 = $pin
    files = $files
  }
  $json = ConvertTo-Json -InputObject $manifest -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $installed 'chromix-install.json'), $json, (New-Object System.Text.UTF8Encoding($false)))
  [System.IO.Directory]::Move($installed, $destination)
  Write-Output (Join-Path $destination 'chrome.exe')
} finally {
  if ($zip) { $zip.Dispose() }
  $source.Dispose()
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
