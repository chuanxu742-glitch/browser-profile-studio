param(
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  [Parameter(Mandatory = $true)][string]$InstallDirectory,
  [ValidateSet('Install', 'Uninstall')][string]$Action = 'Install',
  [switch]$RemoveData
)

$ErrorActionPreference = 'Stop'
if (!(Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
}
$verifier = Join-Path $PSScriptRoot 'verify-windows-release.ps1'
if ($Action -eq 'Install' -and $RemoveData) {
  throw 'RemoveData is valid only for Uninstall.'
}

function Get-ReleasePath([string]$path) {
  $full = [System.IO.Path]::GetFullPath($path)
  $root = [System.IO.Path]::GetPathRoot($full)
  if ($full.Length -gt $root.Length) { return $full.TrimEnd([char[]]@('\', '/')) }
  return $full
}

function Test-Within([string]$path, [string]$directory) {
  $prefix = $directory
  if (!$prefix.EndsWith([System.IO.Path]::DirectorySeparatorChar.ToString())) {
    $prefix += [System.IO.Path]::DirectorySeparatorChar
  }
  return $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparseAncestors([string]$path) {
  $current = $path
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse point in release path: $current"
      }
    }
    $parent = [System.IO.Path]::GetDirectoryName($current)
    if (!$parent -or $parent -eq $current) { break }
    $current = $parent
  }
}

function Assert-SafeTree([string]$directory) {
  if (!(Test-Path -LiteralPath $directory)) { return }
  $rootItem = Get-Item -LiteralPath $directory -Force
  if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Reparse point in installed data: $directory"
  }
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($directory)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($item in (Get-ChildItem -LiteralPath $current -Force)) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse point in installed data: $($item.FullName)"
      }
      if ($item.PSIsContainer) { $pending.Push($item.FullName) }
    }
  }
}

function Assert-UnlockedTree([string]$directory) {
  $pending = New-Object 'System.Collections.Generic.Stack[string]'
  $pending.Push($directory)
  while ($pending.Count -gt 0) {
    foreach ($item in (Get-ChildItem -LiteralPath $pending.Pop() -Force)) {
      if ($item.PSIsContainer) {
        $pending.Push($item.FullName)
      } else {
        try {
          $handle = [System.IO.File]::Open($item.FullName, [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
          $handle.Dispose()
        } catch {
          throw "Installed file is in use or inaccessible: $($item.FullName): $($_.Exception.Message)"
        }
      }
    }
  }
}

function Assert-NoRunningRelease([string]$directory) {
  foreach ($process in (Get-CimInstance Win32_Process)) {
    if ($process.ExecutablePath -and (Test-Within $process.ExecutablePath $directory)) {
      throw "Stop release process $($process.ProcessId) before changing $directory"
    }
  }
}

function Compare-NumericIdentifier([string]$left, [string]$right) {
  if ($left.Length -ne $right.Length) { return [Math]::Sign($left.Length - $right.Length) }
  return [Math]::Sign([string]::CompareOrdinal($left, $right))
}

function Get-VersionParts([string]$text) {
  $match = [regex]::Match($text, '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$')
  if (!$match.Success) { throw "Invalid application semantic version: $text" }
  $pre = $match.Groups[4].Value
  if ($pre) {
    foreach ($part in $pre.Split('.')) {
      if ($part -cmatch '^[0-9]+$' -and $part.Length -gt 1 -and $part[0] -eq '0') {
        throw "Invalid application semantic version: $text"
      }
    }
  }
  return @($match.Groups[1].Value, $match.Groups[2].Value, $match.Groups[3].Value, $pre)
}

function Compare-ReleaseVersion([string]$left, [string]$right) {
  $a = Get-VersionParts $left
  $b = Get-VersionParts $right
  for ($index = 0; $index -lt 3; $index++) {
    $order = Compare-NumericIdentifier $a[$index] $b[$index]
    if ($order) { return $order }
  }
  if (!$a[3] -and !$b[3]) { return 0 }
  if (!$a[3]) { return 1 }
  if (!$b[3]) { return -1 }
  $aParts = $a[3].Split('.')
  $bParts = $b[3].Split('.')
  for ($index = 0; $index -lt [Math]::Min($aParts.Length, $bParts.Length); $index++) {
    $aNumeric = $aParts[$index] -cmatch '^[0-9]+$'
    $bNumeric = $bParts[$index] -cmatch '^[0-9]+$'
    if ($aNumeric -and $bNumeric) {
      $order = Compare-NumericIdentifier $aParts[$index] $bParts[$index]
    } elseif ($aNumeric) {
      $order = -1
    } elseif ($bNumeric) {
      $order = 1
    } else {
      $order = [Math]::Sign([string]::CompareOrdinal($aParts[$index], $bParts[$index]))
    }
    if ($order) { return $order }
  }
  return [Math]::Sign($aParts.Length - $bParts.Length)
}

function Get-ReleaseMetadata([string]$directory) {
  return Get-Content -LiteralPath (Join-Path $directory 'RELEASE-METADATA.json') -Raw | ConvertFrom-Json
}

function Move-ReleaseDirectory([string]$from, [string]$to) {
  [System.IO.Directory]::Move($from, $to)
}

$source = Get-ReleasePath $PackageRoot
$install = Get-ReleasePath $InstallDirectory
$parent = [System.IO.Path]::GetDirectoryName($install)
if (!$parent -or $install -eq [System.IO.Path]::GetPathRoot($install)) {
  throw 'InstallDirectory must be a non-root directory.'
}
if ($Action -eq 'Install' -and
    ([string]::Equals($source, $install, [System.StringComparison]::OrdinalIgnoreCase) -or
     (Test-Within $source $install) -or (Test-Within $install $source))) {
  throw 'PackageRoot and InstallDirectory must be separate, non-nested directories.'
}
Assert-NoReparseAncestors $install
if (Test-Path -LiteralPath $install -PathType Leaf) { throw "Installation is not a directory: $install" }

if ($Action -eq 'Install') {
  if (!(Test-Path -LiteralPath $source -PathType Container)) { throw "Missing package root: $source" }
  Assert-NoReparseAncestors $source
  if (Test-Path -LiteralPath (Join-Path $source 'data')) {
    throw 'A release package cannot contain installed data.'
  }
  & $verifier -PackageRoot $source
  $incoming = Get-ReleaseMetadata $source
  $null = Get-VersionParts $incoming.applicationVersion
}

$exists = Test-Path -LiteralPath $install -PathType Container
$data = Join-Path $install 'data'
$marker = Join-Path $install 'INSTALL-STATE.json'
$hasData = $exists -and (Test-Path -LiteralPath $data)
$retainedOnly = $false
$legacyDataOnly = $false
if ($exists) {
  $entries = @(Get-ChildItem -LiteralPath $install -Force)
  $legacyDataOnly = $entries.Count -eq 1 -and $entries[0].Name -ieq 'data'
  $retainedOnly = $entries.Count -eq 2 -and
    @($entries | Where-Object { $_.Name -ieq 'data' }).Count -eq 1 -and
    @($entries | Where-Object { $_.Name -ieq 'INSTALL-STATE.json' }).Count -eq 1
  if ($retainedOnly) {
    if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { throw "Invalid retained release marker: $marker" }
    try { $state = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json }
    catch { throw "Invalid retained release marker: $marker : $($_.Exception.Message)" }
    $fields = @($state.PSObject.Properties.Name)
    if ($fields.Count -ne 3 -or !($fields -ccontains 'schemaVersion') -or
        !($fields -ccontains 'applicationVersion') -or !($fields -ccontains 'manifestSha256') -or
        ($state.schemaVersion -isnot [int] -and $state.schemaVersion -isnot [long]) -or $state.schemaVersion -ne 1 -or
        $state.applicationVersion -isnot [string] -or
        $state.manifestSha256 -isnot [string] -or $state.manifestSha256 -cnotmatch '^[a-fA-F0-9]{64}$') {
      throw "Invalid retained release marker: $marker"
    }
    $priorVersion = $state.applicationVersion
    $priorHash = $state.manifestSha256
    $null = Get-VersionParts $priorVersion
  } elseif (!$legacyDataOnly) {
    & $verifier -PackageRoot $install
    $installed = Get-ReleaseMetadata $install
    $priorVersion = $installed.applicationVersion
    $null = Get-VersionParts $priorVersion
    if ($Action -eq 'Install' -or $hasData) {
      $priorHash = (Get-FileHash -LiteralPath (Join-Path $install 'PACKAGE-CONTENTS.sha256') -Algorithm SHA256).Hash
    }
  }
  if ($hasData) {
    if (!(Test-Path -LiteralPath $data -PathType Container)) {
      throw "Installed data is not a directory: $data"
    }
    Assert-SafeTree $data
  }
  Assert-NoRunningRelease $install
  Assert-UnlockedTree $install
  if ($Action -eq 'Install') {
    if ($legacyDataOnly) { throw 'Retained data has no verified release version; refusing installation.' }
    $order = if ($retainedOnly -or $installed) {
      Compare-ReleaseVersion $incoming.applicationVersion $priorVersion
    } else { 1 }
    if ($order -lt 0) { throw "Downgrade refused: $priorVersion to $($incoming.applicationVersion)" }
    if ($order -eq 0) {
      $newHash = (Get-FileHash -LiteralPath (Join-Path $source 'PACKAGE-CONTENTS.sha256') -Algorithm SHA256).Hash
      if ($priorHash -ne $newHash) { throw 'Conflicting releases have the same application version.' }
    }
  }
}
if ($Action -eq 'Uninstall' -and !$exists) { return }
if ($Action -eq 'Uninstall' -and ($retainedOnly -or $legacyDataOnly) -and !$RemoveData) { return }
# Stage beside the destination so all commits and rollbacks are directory renames
# on one volume. Never copy mutable user data: move its directory only at commit.
$stage = Join-Path $parent ('.release-stage-' + [guid]::NewGuid().ToString('N'))
$backup = Join-Path $parent ('.release-backup-' + [guid]::NewGuid().ToString('N'))
$oldMoved = $false
$dataMoved = $false
$newMoved = $false
$committed = $false
try {
  if ($Action -eq 'Install') {
    if (!(Test-Path -LiteralPath $parent -PathType Container)) {
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $stage | Out-Null
    foreach ($item in (Get-ChildItem -LiteralPath $source -Force)) {
      if ($item.Name -ieq 'data') { continue }
      Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $stage $item.Name) -Recurse -Force
    }
    & $verifier -PackageRoot $stage
  } elseif ($hasData -and !$RemoveData) {
    New-Item -ItemType Directory -Path $stage | Out-Null
    [ordered]@{
      schemaVersion = 1
      applicationVersion = $priorVersion
      manifestSha256 = $priorHash.ToLowerInvariant()
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'INSTALL-STATE.json') -Encoding utf8
  }

  if ($exists) {
    Move-ReleaseDirectory $install $backup
    $oldMoved = $true
  }
  if ($Action -eq 'Install' -or ($hasData -and !$RemoveData)) {
    if ($hasData) {
      Move-ReleaseDirectory (Join-Path $backup 'data') (Join-Path $stage 'data')
      $dataMoved = $true
    }
    Move-ReleaseDirectory $stage $install
    $newMoved = $true
  }
  $committed = $true
} catch {
  $originalError = $_
  try {
    if ($newMoved) {
      Move-ReleaseDirectory $install $stage
      $newMoved = $false
    }
    if ($dataMoved) {
      Move-ReleaseDirectory (Join-Path $stage 'data') (Join-Path $backup 'data')
      $dataMoved = $false
    }
    if ($oldMoved) {
      Move-ReleaseDirectory $backup $install
      $oldMoved = $false
    }
  } catch {
    throw "Release operation failed: $originalError. Rollback also failed: $_. Recovery directories: $stage, $backup"
  }
  throw $originalError
} finally {
  # On rollback failure, the stage may contain the only copy of user data.
  if (!$dataMoved -and !$newMoved -and (Test-Path -LiteralPath $stage)) {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
if ($committed -and $oldMoved) {
  Remove-Item -LiteralPath $backup -Recurse -Force
}
