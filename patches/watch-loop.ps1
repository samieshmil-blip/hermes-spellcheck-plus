# hermes-ru-spellcheck watcher.
# Every minute it checks whether the spell-check patch is still present in the
# built Hermes Desktop bundle; if an app update replaced the files, it runs
# apply-fix.cjs again. Nothing is restarted: the underline comes back on the
# next Hermes launch (an update relaunches the app anyway).
# Logs: watch.log and apply-fix.log next to this file.
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

$node = Find-Node
if (-not $node) {
  Write-Log 'node.exe not found, watcher exits'
  exit 1
}

Write-Log "watcher started (node: $node)"

while ($true) {
  if (-not (Test-Path $mainFile)) {
    Write-Log 'app bundle not found, waiting'
  } else {
    $patched = Select-String -Path $mainFile -Pattern 'ru-spellcheck' -Quiet

    if (-not $patched) {
      Write-Log 'patch is missing (app update?) - applying'
      & $node $apply | Out-Null
      $again = Select-String -Path $mainFile -Pattern 'ru-spellcheck' -Quiet
      if ($again) {
        Write-Log 'result: patched again'
      } else {
        Write-Log 'result: FAILED, see apply-fix.log'
      }
    }
  }

  Start-Sleep -Seconds 60
}
