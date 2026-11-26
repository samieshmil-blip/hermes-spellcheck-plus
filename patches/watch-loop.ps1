# hermes-ru-spellcheck watcher (event driven, no polling).
#
# The patch has to be in place BEFORE Hermes reads its bundle, so "check only
# when the app opens" is impossible: by then the files are already loaded and a
# fresh patch needs one more restart. Instead this script does nothing while
# idle and wakes up only when the app folder changes - i.e. exactly when an
# update rewrites the bundle - then re-applies apply-fix.cjs (a few seconds),
# so the next Hermes launch already has the underline.
#
# One extra check runs when the script starts (logon).
# Logs: watch.log next to this file.
$ErrorActionPreference = 'SilentlyContinue'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$apply = Join-Path $root 'apply-fix.cjs'
$log = Join-Path $root 'watch.log'

$local = $env:LOCALAPPDATA
$dist = Join-Path $local 'hermes\hermes-agent\apps\desktop\release\win-unpacked\resources\app.asar.unpacked\dist'
$mainFile = Join-Path $dist 'electron-main.mjs'

function Write-Log($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -Path $log -Value $line -Encoding UTF8
}

function Find-Node {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $tools = Join-Path $local 'hermes\tools'
  $candidate = Get-ChildItem -Path $tools -Filter 'node.exe' -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
  if ($candidate) { return $candidate }

  $pf = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $pf) { return $pf }

  return $null
}

function Test-Patched {
  if (-not (Test-Path $mainFile)) { return $true }  # app not installed here: nothing to do
  return [bool](Select-String -Path $mainFile -Pattern 'ru-spellcheck' -Quiet)
}

function Invoke-Fix {
  if (Test-Patched) { return }
  Write-Log 'patch is missing (app update?) - applying'
  & $node $apply | Out-Null
  if (Test-Patched) { Write-Log 'result: patched, Hermes will pick it up on its next start' }
  else { Write-Log 'result: FAILED, see apply-fix.log' }
}

$node = Find-Node
if (-not $node) { Write-Log 'node.exe not found, watcher exits'; exit 1 }

Write-Log "watcher started (node: $node, event driven)"
Invoke-Fix

while ($true) {
  try {
    $watcher = New-Object System.IO.FileSystemWatcher
    $watcher.Path = $dist
    $watcher.Filter = '*'
    $watcher.IncludeSubdirectories = $true
    $watcher.NotifyFilter = [System.IO.NotifyFilters]::LastWrite -bor [System.IO.NotifyFilters]::FileName -bor [System.IO.NotifyFilters]::DirectoryName
    $watcher.EnableRaisingEvents = $true

    while ($true) {
      $change = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::All, 3600000)
      if ($change.TimedOut) { continue }

      # an update writes many files: wait for it to settle, then check once
      Start-Sleep -Seconds 6
      Invoke-Fix
    }
  } catch {
    Write-Log ("watcher error: " + $_.Exception.Message + " - recreating")
    Start-Sleep -Seconds 30
  } finally {
    if ($watcher) { $watcher.Dispose() }
  }
}
