$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (!(Get-Command Get-FileHash -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
}
$installer = Join-Path $PSScriptRoot 'install-chromix.ps1'
$temp = Join-Path ([System.IO.Path]::GetTempPath()) ('chromix-installer-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temp
$env:CHROMIX_INSTALL_FIXTURE_TEST = '1'
function PE([bool]$dll, [int]$machine = 0x8664) {
  $bytes = New-Object byte[] 256
  $bytes[0] = 0x4d; $bytes[1] = 0x5a
  $bytes[0x3c] = 0x80; $bytes[0x80] = 0x50; $bytes[0x81] = 0x45
  $bytes[0x84] = $machine -band 255; $bytes[0x85] = ($machine -shr 8) -band 255
  $bytes[0x96] = 0x02
  if ($dll) { $bytes[0x97] = 0x20 }
  $bytes[0x98] = 0x0b; $bytes[0x99] = 0x02
  return ,$bytes
}
function Fixture([string]$label, [object[]]$extra, [switch]$BadExe, [switch]$NoDll) {
  $scratch = Join-Path $temp "$label-scratch"
  $root = Join-Path $temp "$label-root"
  $null = New-Item -ItemType Directory -Path $scratch
  $null = New-Item -ItemType Directory -Path $root
  $zipPath = Join-Path $scratch 'fixture.zip'
  $archive = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    $entries = @(@{ Name = 'chromix/chrome.exe'; Data = $(if ($BadExe) { PE $false 0x14c } else { PE $false }) })
    if (!$NoDll) { $entries += @{ Name = 'chromix/chrome.dll'; Data = (PE $true) } }
    $entries += @{ Name = 'chromix/resources/fixture.dat'; Data = [byte[]]@(1, 2, 3) }
    $entries += $extra
    foreach ($item in $entries) {
      $entry = $archive.CreateEntry($item.Name)
      if ($item.ContainsKey('Attributes')) { $entry.ExternalAttributes = $item.Attributes }
      if ($item.Data) {
        $stream = $entry.Open()
        try { $stream.Write($item.Data, 0, $item.Data.Length) } finally { $stream.Dispose() }
      }
    }
  } finally { $archive.Dispose() }
  return @{ Scratch = $scratch; Root = $root; Zip = $zipPath; Hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant() }
}
function Scenario([string]$name, [object[]]$extra, [string]$errorPattern, [switch]$BadExe, [switch]$NoDll) {
  $case = Fixture $name $extra -BadExe:$BadExe -NoDll:$NoDll
  try {
    $output = & $installer -ScratchDirectory $case.Scratch -InstallRoot $case.Root -ArchivePath $case.Zip -FixtureExpectedSha256 $case.Hash
    if ($errorPattern) { throw "Expected rejection for $name but installer returned $output" }
    if ($output -cne (Join-Path $case.Root 'chromix/chrome.exe')) { throw "Wrong executable path in $name : $output" }
    $manifest = Get-Content -LiteralPath (Join-Path $case.Root 'chromix/chromix-install.json') -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.distribution -cne 'chromix-152' -or
        $manifest.browserVersion -cne '152.0.7977.82' -or
        $manifest.archiveSha256 -cne '1cfbe638212ba4d463a8c3330fcfbd8c88f9844ff6dfc0722f2c40745e0bc7f8') { throw "Manifest identity mismatch: $name" }
    $inventory = @(Get-ChildItem -LiteralPath (Join-Path $case.Root 'chromix') -File -Recurse |
      Where-Object { $_.Name -cne 'chromix-install.json' })
    if ($inventory.Count -ne @($manifest.files.PSObject.Properties).Count) { throw "Incomplete inventory: $name" }
    foreach ($file in $inventory) {
      $relative = $file.FullName.Substring((Join-Path $case.Root 'chromix').Length + 1).Replace('\', '/')
      $record = $manifest.files.PSObject.Properties[$relative]
      if (!$record -or $record.Value -cne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw "Inventory mismatch for $relative"
      }
    }
  } catch {
    if (!$errorPattern -or $_.Exception.Message -notmatch $errorPattern) { throw }
  }
  if ($errorPattern -and (Test-Path -LiteralPath (Join-Path $case.Root 'chromix'))) { throw "Rejected $name published installation" }
  if (@(Get-ChildItem -LiteralPath $case.Root -Force | Where-Object { $_.Name -like '.chromix-stage-*' }).Count) { throw "Staging tree leaked after $name" }
  Write-Output "PASS $name"
}
try {
  Scenario 'valid' @() ''
  Scenario 'backslash-valid' @(@{ Name = 'chromix\resources\extra.txt'; Data = [byte[]]@(4) }) ''
  Scenario 'dotdot-backslash' @(@{ Name = 'chromix\..\outside.txt'; Data = [byte[]]@(1) }) 'Unsafe ZIP path'
  Scenario 'absolute' @(@{ Name = '\evil.txt'; Data = [byte[]]@(1) }) 'Unsafe ZIP path'
  Scenario 'dot-segment' @(@{ Name = 'chromix/./nested.txt'; Data = [byte[]]@(1) }) 'Unsafe ZIP path'
  Scenario 'reserved-windows' @(@{ Name = 'chromix/AUX.txt'; Data = [byte[]]@(1) }) 'Windows-unsafe ZIP path'
  Scenario 'trailing-dot' @(@{ Name = 'chromix/dir./file'; Data = [byte[]]@(1) }) 'Windows-unsafe ZIP path'
  Scenario 'drive' @(@{ Name = 'chromix/C:\evil.txt'; Data = [byte[]]@(1) }) 'Unsafe ZIP path'
  Scenario 'case-duplicate' @(@{ Name = 'chromix/CHROME.EXE'; Data = [byte[]]@(1) }) 'Duplicate ZIP path'
  Scenario 'separator-duplicate' @(@{ Name = 'chromix\chrome.exe'; Data = [byte[]]@(1) }) 'Duplicate ZIP path'
  Scenario 'directory-collision' @(@{ Name = 'chromix/chrome.exe/child.txt'; Data = [byte[]]@(1) }) 'collision'
  Scenario 'symlink' @(@{ Name = 'chromix/link'; Data = [byte[]]@(1); Attributes = ([int](0xa000 -shl 16)) }) 'Reparse, special'
  Scenario 'reparse' @(@{ Name = 'chromix/link'; Data = [byte[]]@(1); Attributes = 0x400 }) 'Reparse, special'
  Scenario 'ads' @(@{ Name = 'chromix/evil:stream'; Data = [byte[]]@(1) }) 'Unsafe ZIP path'
  Scenario 'manifest-supplied' @(@{ Name = 'chromix/chromix-install.json'; Data = [byte[]]@(1) }) 'cannot supply'
  Scenario 'wrong-machine' @() 'Not a Windows x64 PE' -BadExe
  Scenario 'missing-dll' @() 'must contain' -NoDll
  $mismatch = Fixture 'digest' @()
  try {
    & $installer -ScratchDirectory $mismatch.Scratch -InstallRoot $mismatch.Root -ArchivePath $mismatch.Zip -FixtureExpectedSha256 ('0' * 64) | Out-Null
    throw 'Tampered digest was accepted.'
  } catch { if ($_.Exception.Message -notmatch 'SHA-256 mismatch') { throw } }
  if (Test-Path -LiteralPath (Join-Path $mismatch.Root 'chromix')) { throw 'Digest failure published installation.' }
  Write-Output 'PASS digest'
  $existing = Fixture 'existing' @()
  $installed = Join-Path $existing.Root 'chromix'
  $null = New-Item -ItemType Directory -Path $installed
  [System.IO.File]::WriteAllText((Join-Path $installed 'keep.txt'), 'user-owned')
  try {
    & $installer -ScratchDirectory $existing.Scratch -InstallRoot $existing.Root -ArchivePath $existing.Zip -FixtureExpectedSha256 $existing.Hash | Out-Null
    throw 'Existing installation was overwritten.'
  } catch { if ($_.Exception.Message -notmatch 'already exists') { throw } }
  if ([System.IO.File]::ReadAllText((Join-Path $installed 'keep.txt')) -cne 'user-owned') { throw 'Existing installation mutated.' }
  Write-Output 'PASS existing installation preservation'
  $junction = Join-Path $temp 'linked-root'
  $null = New-Item -ItemType Junction -Path $junction -Target $mismatch.Root
  try {
    & $installer -ScratchDirectory $mismatch.Scratch -InstallRoot $junction -ArchivePath $mismatch.Zip -FixtureExpectedSha256 $mismatch.Hash | Out-Null
    throw 'Reparse install root accepted.'
  } catch { if ($_.Exception.Message -notmatch 'Reparse point in path') { throw } }
  Write-Output 'PASS reparse install root'
  # The fixture-only handshake begins after the installer opens its locked
  # read handle, so this writer cannot accidentally win the startup race.
  $locked = Fixture 'locked-archive' @()
  $signal = Join-Path $locked.Scratch 'lock.signal'
  $env:CHROMIX_INSTALL_FIXTURE_LOCK_SIGNAL = $signal
  $job = Start-Job -ArgumentList $installer,$locked.Scratch,$locked.Root,$locked.Zip,$locked.Hash -ScriptBlock {
    param($script,$scratch,$root,$archive,$digest)
    & $script -ScratchDirectory $scratch -InstallRoot $root -ArchivePath $archive -FixtureExpectedSha256 $digest
  }
  try {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (!(Test-Path -LiteralPath $signal) -and $job.State -in @('NotStarted','Running')) {
      if ([DateTime]::UtcNow -ge $deadline) { throw 'Installer did not acquire the archive lock.' }
      Start-Sleep -Milliseconds 10
    }
    if (!(Test-Path -LiteralPath $signal)) { throw "Installer failed before acquiring archive lock: $(Receive-Job $job -Wait)" }
    $writeDenied = $false
    try {
      $handle = [System.IO.File]::Open($locked.Zip, [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Write, [System.IO.FileShare]::ReadWrite)
      $handle.Dispose()
    } catch [System.IO.IOException] { $writeDenied = $true }
    finally { [System.IO.File]::WriteAllText("$signal.ack", 'probed') }
    $output = Receive-Job $job -Wait -ErrorAction Stop
    if (!$writeDenied -or $output -cne (Join-Path $locked.Root 'chromix/chrome.exe')) {
      throw 'Verified archive was not locked against concurrent writes through extraction.'
    }
  } finally {
    if ($job.State -eq 'Running') { Stop-Job $job }
    Remove-Job $job -Force
    Remove-Item Env:CHROMIX_INSTALL_FIXTURE_LOCK_SIGNAL -ErrorAction SilentlyContinue
  }
  Write-Output 'PASS archive write denied after verified lock acquisition'
  $env:CHROMIX_INSTALL_FIXTURE_TEST = ''
  try {
    & $installer -ScratchDirectory $mismatch.Scratch -InstallRoot $mismatch.Root -ArchivePath $mismatch.Zip -FixtureExpectedSha256 $mismatch.Hash | Out-Null
    throw 'Fixture override accepted without test opt-in.'
  } catch { if ($_.Exception.Message -notmatch 'Fixture digest override') { throw } }
  Write-Output 'PASS override gate'
  Write-Output 'All PowerShell 5.1 Chromix installer scenarios passed.'
} finally {
  Remove-Item Env:CHROMIX_INSTALL_FIXTURE_TEST -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temp -Recurse -Force
  Remove-Item Env:CHROMIX_INSTALL_FIXTURE_LOCK_SIGNAL -ErrorAction SilentlyContinue
}
