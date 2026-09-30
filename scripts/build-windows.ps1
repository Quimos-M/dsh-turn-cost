# One-command build for this plugin from the Windows side: hand the work to WSL.
# The toolchain (typescript / tsdown / lightningcss) lives in the WSL DSH checkout and
# lightningcss ships only a Linux binary, so the client bundle must be built inside WSL.
#   wsl.exe -e bash /mnt/<drive>/<path>/scripts/dev-build.sh
# Manual equivalent (inside WSL):
#   cd /mnt/e/DSH-plugin/dsh-turn-cost && bash scripts/dev-build.sh
# NOTE: keep ErrorActionPreference at Continue: native commands (wsl/tsc/bash) write progress
# to stderr, and 'Stop' would turn that into a fatal error.
$ErrorActionPreference = 'Continue'
$winRoot = Split-Path -Parent $PSScriptRoot
$drive   = $winRoot.Substring(0, 1).ToLower()
$wslRoot = '/mnt/' + $drive + ($winRoot.Substring(2) -replace '\\', '/')
$wslScript = "$wslRoot/scripts/dev-build.sh"
Write-Host "-> WSL: $wslScript"
wsl.exe -e bash $wslScript
$code = $LASTEXITCODE
if ($code -ne 0) { Write-Host "BUILD FAILED (exit $code)" } else { Write-Host "BUILD OK" }
exit $code