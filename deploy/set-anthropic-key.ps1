# Put your Claude API key on the Tweet Vault server, so translations work.
#   powershell -File deploy\set-anthropic-key.ps1              (asks for the key, hidden)
#   powershell -File deploy\set-anthropic-key.ps1 -DryRun      (shows what it would do, sends nothing)
#
# What it does:
#   1. asks for the key (typing is hidden) and the daily translation limit
#   2. builds the two .env lines in memory and sends them to the server over SSH (never saved on this PC)
#   3. on the server: backs up .env, replaces any old ANTHROPIC_API_KEY / TRANSLATE_DAILY_LIMIT lines,
#      keeps .env private (mode 600), restarts the vault and checks it is healthy
#   4. checks the key with a free Models API call (no tokens are used)
# The key is never printed, never put in a command line, and never written to a file on this PC.
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$hostAlias = if ($env:VAULT_SSH_HOST) { $env:VAULT_SSH_HOST } else { throw 'Set VAULT_SSH_HOST first, for example: $env:VAULT_SSH_HOST = "user@your-server"' }
$dir = '~/tweet-vault'

Write-Host 'Paste your Claude API key (starts with sk-ant-). Typing is hidden; press Enter when done.'
$secure = Read-Host -AsSecureString 'API key'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ($key -notmatch '^sk-ant-[A-Za-z0-9_\-]{20,}$') {
  $key = $null
  throw 'That does not look like a Claude API key (it should start with sk-ant- and have no spaces). Nothing was changed.'
}
if ($key -match '^sk-ant-admin') {
  $key = $null
  throw 'That is an Admin key. Create a normal API key instead. Nothing was changed.'
}

$limit = Read-Host 'Most translations per day [200]'
if ([string]::IsNullOrWhiteSpace($limit)) { $limit = '200' }
if ($limit -notmatch '^\d{1,5}$' -or [int]$limit -lt 1) { throw 'The daily limit must be a number from 1 to 99999. Nothing was changed.' }

$masked = $key.Substring(0, 10) + '...' + $key.Substring($key.Length - 4)
Write-Host "Key $masked, at most $limit translations a day, for ${hostAlias}:$dir/.env"

if ($DryRun) {
  Write-Host 'Dry run: nothing was sent. The server would get these lines (key masked):'
  Write-Host "  ANTHROPIC_API_KEY=$masked"
  Write-Host "  TRANSLATE_DAILY_LIMIT=$limit"
  $key = $null
  exit 0
}

# 0) the server-side helper (run by name, so no script text is piped through PowerShell)
scp -q "$PSScriptRoot\remote.sh" "${hostAlias}:$dir/remote.sh"
if ($LASTEXITCODE -ne 0) { $key = $null; throw 'Could not reach the server. Nothing was changed.' }

# 1) the new lines go to a private file on the server through stdin (not the command line, not this PC's disk).
#    Only plain ASCII travels (the key is checked above), so the pipe can't change it; the server strips any
#    byte-order mark and Windows line endings.
$lines = "ANTHROPIC_API_KEY=$key`nTRANSLATE_DAILY_LIMIT=$limit`n"
$lines | ssh $hostAlias "umask 077 && sed '1s/^\xEF\xBB\xBF//' | tr -d '\r' > $dir/.env.incoming"
$key = $null; $lines = $null
if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server. Nothing was changed.' }

# 2) merge into .env, restart, health check, then test the key with a free Models API call
ssh $hostAlias "sh $dir/remote.sh setkey"
if ($LASTEXITCODE -ne 0) { throw 'Something went wrong on the server (see above).' }
Write-Host 'Done. Reload the vault: Chinese and other non-Latin posts now translate themselves.'
