# Check what's forcing GitHub/npm traffic through 127.0.0.1 (causing connection refused).
# Run in PowerShell: .\scripts\check-proxy.ps1
# Fix (current session): .\scripts\check-proxy.ps1 -FixSession

param([switch]$FixSession)

Write-Host "`n=== Environment proxy variables ===" -ForegroundColor Cyan
$vars = @('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy')
foreach ($v in $vars) {
  $val = [Environment]::GetEnvironmentVariable($v, 'Process')
  if (-not $val) { $val = [Environment]::GetEnvironmentVariable($v, 'User') }
  if (-not $val) { $val = [Environment]::GetEnvironmentVariable($v, 'Machine') }
  if ($val) { Write-Host "  $v = $val" }
}

Write-Host "`n=== Git proxy config ===" -ForegroundColor Cyan
git config --global --get-regexp '.*proxy.*' 2>$null
if (-not $?) { Write-Host "  (none)" }

Write-Host "`n=== NPM proxy config ===" -ForegroundColor Cyan
$npmProxy = npm config get proxy 2>$null
$npmHttps  = npm config get https-proxy 2>$null
Write-Host "  proxy: $npmProxy"
Write-Host "  https-proxy: $npmHttps"

if ($FixSession) {
  Write-Host "`n=== Clearing proxy for this session only ===" -ForegroundColor Yellow
  $vars | ForEach-Object { Remove-Item "Env:$_" -ErrorAction SilentlyContinue }
  Write-Host "  Unset proxy env vars in this session."
  Write-Host "  To clear git proxy permanently, run:"
  Write-Host "    git config --global --unset http.proxy"
  Write-Host "    git config --global --unset https.proxy"
  Write-Host "  Then try: git push origin main"
}

Write-Host ""
