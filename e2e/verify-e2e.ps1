# reasoning-loop-guard — end-to-end verification against a REAL agent loop.
#
# Both runs boot the real `dsh` CLI on an isolated profile whose default model
# is a fake adapter serving a degenerate reasoning blob from test/fixtures.
# Nothing here is a replica of the loop, the waterfall, the invariant gate, or
# the CLI error surface.
#
#   run 1 (guard armed, via the plugin's own cordis.patch.yml): must abort the
#          stream early and surface REASONING_LOOP;
#   run 2 (guard off,  via --patch e2e/guard-off.patch.yml): the identical
#          stream must complete and the task must succeed.
#
# The harness is self-contained: it recreates e2e-home/ (an isolated DSH_HOME)
# and the profile-local copies of the plugin and the fake provider from the
# repository sources on every run, so `git clone && pwsh -File e2e/verify-e2e.ps1`
# works with no prior state.
#
# Requirements: DSH Desktop installed, Node on PATH.
# Usage:        pwsh -File e2e/verify-e2e.ps1
$ErrorActionPreference = "Stop"

$root     = Split-Path -Parent $PSScriptRoot
$home_    = Join-Path $root "e2e-home"
$profile  = Join-Path $home_ "profiles\e2e"
$nodeMods = Join-Path $profile "node_modules"

# Locate the DSH installation (its bundled CLI is the only entry point that can
# boot a profile from the command line).
$dshBin = $env:DSH_BIN
if (-not $dshBin) {
  $candidates = @(
    (Join-Path $env:ProgramFiles "DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js"),
    (Join-Path $env:LOCALAPPDATA "Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js")
  )
  $dshBin = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $dshBin -or -not (Test-Path $dshBin)) {
  throw "could not find the DSH CLI; set DSH_BIN to ...\@deepseek-ai\dsh\lib\bin.js"
}

# --- materialise the isolated profile -------------------------------------
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Copy-Item -Force (Join-Path $root "e2e\profile\package.json")      (Join-Path $profile "package.json")
Copy-Item -Force (Join-Path $root "e2e\profile\cordis.yml")        (Join-Path $profile "cordis.yml")
Copy-Item -Force (Join-Path $root "e2e\profile\pnpm-workspace.yaml") (Join-Path $profile "pnpm-workspace.yaml")

# The profile patch layer names the two bundles it mounts, so it is generated
# from the shipped sources rather than duplicated.
@"
# E2E profile patch layer.
#
# 1. mount the test-only fake provider bundle and the guard bundle;
# 2. point the default model at the fake provider so a real agent loop drives
#    the degenerate reasoning stream.
- insert:
    - id: tg-fake-provider-bundle
      name: dsh-tg-fake
    - id: reasoning-loop-guard
      name: dsh-reasoning-loop-guard
- id: agent-default-model
  config:
    provider: tg-fake
    model: tg-fake-model
"@ | Set-Content -Encoding utf8 (Join-Path $profile "cordis.patch.yml")

# Deploy the plugin and the fake provider the way a real install would.
foreach ($pkg in @("dsh-reasoning-loop-guard", "dsh-tg-fake")) {
  $dest = Join-Path $nodeMods $pkg
  if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
}
foreach ($file in @("package.json", "cordis.patch.yml", "README.md")) {
  $source = Join-Path $root $file
  if (Test-Path $source) { Copy-Item -Force $source (Join-Path $nodeMods "dsh-reasoning-loop-guard\$file") }
}
Copy-Item -Recurse -Force (Join-Path $root "lib") (Join-Path $nodeMods "dsh-reasoning-loop-guard\lib")
foreach ($file in @("package.json", "cordis.patch.yml", "index.js")) {
  Copy-Item -Force (Join-Path $root "e2e\fake-provider\$file") (Join-Path $nodeMods "dsh-tg-fake\$file")
}

# --- run the two arms ------------------------------------------------------
$env:DSH_HOME         = $home_
$env:TG_FAKE_CHUNK    = "40"
$env:TG_FAKE_FIXTURES = Join-Path $root "test\fixtures"

$fixtureIndex = 5
$fixtureLen   = 7659  # degenerate.json[5], the fastest-firing fixture

$failures = 0
function Check([bool]$ok, [string]$label) {
  if ($ok) { "ok    $label" } else { "FAIL  $label"; $script:failures += 1 }
}

function Invoke-Run([string]$tag, [string[]]$extra) {
  $out = Join-Path $root "e2e\run-$tag.log"
  $err = Join-Path $root "e2e\run-$tag.err.log"
  $sw  = [Diagnostics.Stopwatch]::StartNew()
  $argv = @($dshBin, "--profile", "e2e") + $extra + @("say TG-HELLO")
  & node @argv 1> $out 2> $err
  $sw.Stop()
  [pscustomobject]@{
    Tag     = $tag
    Exit    = $LASTEXITCODE
    Seconds = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    Stdout  = (Get-Content $out -Raw)
    Stderr  = (Get-Content $err -Raw)
  }
}

"=== run 1: guard ARMED (plugin's own cordis.patch.yml) ==="
$on = Invoke-Run "guard-on" @()
$onServed = [regex]::Match($on.Stderr, "SERVED=(\d+)/(\d+) completed=(\w+)").Groups
"      exit=$($on.Exit) elapsed=$($on.Seconds)s served=$($onServed[1].Value)/$($onServed[2].Value) completed=$($onServed[3].Value)"
Check ($on.Exit -ne 0) "guarded run fails the task (exit != 0)"
Check ($on.Stderr -match "REASONING_LOOP") "guarded run surfaces failure code REASONING_LOOP"
Check ($on.Stderr -match "周期 \d+ 字符，重复 \d+ 次") "failure message carries the measured period and run length"
Check ([int]$onServed[1].Value -lt $fixtureLen) "upstream stream was cut short ($($onServed[1].Value) of $fixtureLen chars served)"
Check ($onServed[3].Value -eq "false") "upstream generator never reached its terminal finish"
Check ($on.Stdout -notmatch "TG-FAKE-OK") "the healthy tail after the loop was never reached"

"`n=== run 2: guard OFF (same stream, same profile) ==="
$off = Invoke-Run "guard-off" @("--patch", (Join-Path $root "e2e\guard-off.patch.yml"))
$offServed = [regex]::Match($off.Stderr, "SERVED=(\d+)/(\d+) completed=(\w+)").Groups
"      exit=$($off.Exit) elapsed=$($off.Seconds)s served=$($offServed[1].Value)/$($offServed[2].Value) completed=$($offServed[3].Value)"
Check ($off.Exit -eq 0) "unguarded run completes the task (exit 0)"
Check ($off.Stderr -notmatch "REASONING_LOOP") "no guard failure without the guard"
Check ([int]$offServed[1].Value -eq $fixtureLen) "the whole degenerate stream was served ($($offServed[1].Value) chars)"
Check ($offServed[3].Value -eq "true") "upstream generator ran to its terminal finish"
Check ($off.Stdout -match "TG-FAKE-OK") "the final message reaches stdout"

"`n=== verdict ==="
"fixture index $fixtureIndex ($fixtureLen chars); guarded served $($onServed[1].Value) chars and aborted, unguarded served $($offServed[1].Value) chars and completed."
if ($failures -eq 0) { "`nALL E2E CHECKS PASSED" } else { "`n$failures E2E CHECK(S) FAILED" }
exit $(if ($failures -eq 0) { 0 } else { 1 })
