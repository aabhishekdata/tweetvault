# Put your Groq API key on the Tweet Vault server, so voice notes get transcribed.
#   powershell -File deploy\set-groq-key.ps1              (asks for the key, hidden)
#   powershell -File deploy\set-groq-key.ps1 -DryRun      (shows what it would do, sends nothing)
#
# What it does (the same way set-anthropic-key.ps1 does):
#   1. asks for the key (typing is hidden) and the daily limits for voice notes
#   2. builds the .env lines in memory and sends them to the server over SSH (never saved on this PC)
#   3. on the server: backs up .env, replaces any old GROQ_API_KEY / VOICE_DAILY_* lines, keeps .env
#      private (mode 600), restarts the vault and checks it is healthy
#   4. checks the key with a free call that lists Groq's models
# The notes themselves are written by Claude with ANTHROPIC_API_KEY (set-anthropic-key.ps1).
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$hostAlias = if ($env:VAULT_SSH_HOST) { $env:VAULT_SSH_HOST } else { throw 'Set VAULT_SSH_HOST first, for example: $env:VAULT_SSH_HOST = "user@your-server"' }
$dir = '~/tweet-vault'

Write-Host 'Paste your Groq API key (starts with gsk_). Typing is hidden; press Enter when done.'
$secure = Read-Host -AsSecureString 'API key'
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

if ($key -notmatch '^gsk_[A-Za-z0-9]{20,}$') {
  $key = $null
  throw 'That does not look like a Groq API key (it should start with gsk_ and have no spaces). Nothing was changed.'
}

$minutes = Read-Host 'Most minutes of voice notes per day [240]'
if ([string]::IsNullOrWhiteSpace($minutes)) { $minutes = '240' }
if ($minutes -notmatch '^\d{1,5}$' -or [int]$minutes -lt 1) { throw 'The minutes limit must be a number from 1 to 99999. Nothing was changed.' }
$calls = Read-Host 'Most note-writing calls to Claude per day (notes plus extra passes) [50]'
if ([string]::IsNullOrWhiteSpace($calls)) { $calls = '50' }
if ($calls -notmatch '^\d{1,5}$' -or [int]$calls -lt 1) { throw 'The calls limit must be a number from 1 to 99999. Nothing was changed.' }

$masked = $key.Substring(0, 8) + '...' + $key.Substring($key.Length - 4)
Write-Host "Key $masked, at most $minutes minutes and $calls note-writing calls a day, for ${hostAlias}:$dir/.env"

if ($DryRun) {
  Write-Host 'Dry run: nothing was sent. The server would get these lines (key masked):'
  Write-Host "  GROQ_API_KEY=$masked"
  Write-Host "  VOICE_DAILY_MINUTES=$minutes"
  Write-Host "  VOICE_DAILY_LIMIT=$calls"
  $key = $null
  exit 0
}

scp -q "$PSScriptRoot\remote.sh" "${hostAlias}:$dir/remote.sh"
if ($LASTEXITCODE -ne 0) { $key = $null; throw 'Could not reach the server. Nothing was changed.' }

# the lines go to a private file on the server through stdin (not the command line, not this PC's disk)
$lines = "GROQ_API_KEY=$key`nVOICE_DAILY_MINUTES=$minutes`nVOICE_DAILY_LIMIT=$calls`n"
$lines | ssh $hostAlias "umask 077 && sed '1s/^\xEF\xBB\xBF//' | tr -d '\r' > $dir/.env.incoming"
$key = $null; $lines = $null
if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server. Nothing was changed.' }

ssh $hostAlias "sh $dir/remote.sh setgroq"
if ($LASTEXITCODE -ne 0) { throw 'Something went wrong on the server (see above).' }
Write-Host 'Done. Voice notes now get transcribed; the notes are written with your Claude key.'
