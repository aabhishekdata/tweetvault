# Run the vault's daily AI categorizing on the server (cli.js categorize, server/src/categorize.js).
#   powershell -File deploy\categorize.ps1              file loose Inbox items into categories, merge the clearly related ones
#   powershell -File deploy\categorize.ps1 -DryRun      show what it would do and keep that plan; nothing is changed
#   powershell -File deploy\categorize.ps1 -Apply       carry out the plan the last dry run kept, exactly as shown
#   ... -MaxNew 40      new categories this run may make (default 5; a first run on a full Inbox needs more)
#   ... -NoMerge        categories only, no merging
#   ... -Limit 400      conversations to look at, newest first
# The work happens on the server with its own Claude key and daily call cap; this PC only starts it.
# Only numbers and fixed words go on the command line, so nothing here can add words to the server command.
param([switch]$DryRun, [switch]$Apply, [switch]$NoMerge, [ValidateRange(0, 200)][int]$MaxNew = 5, [ValidateRange(1, 2000)][int]$Limit = 400)
$ErrorActionPreference = 'Stop'
if ($DryRun -and $Apply) { throw 'Use -DryRun or -Apply, not both.' }
$hostAlias = if ($env:VAULT_SSH_HOST) { $env:VAULT_SSH_HOST } else { throw 'Set VAULT_SSH_HOST first, for example: $env:VAULT_SSH_HOST = "user@your-server"' }
$cli = 'docker exec tweet-vault node --disable-warning=ExperimentalWarning /app/src/cli.js'

$words = "categorize --limit $Limit --max-new $MaxNew"
if ($DryRun) { $words += ' --dry-run' }
if ($Apply) { $words = 'categorize --apply' }
if ($NoMerge -and -not $Apply) { $words += ' --no-merge' }

# the report holds category names and post previews: read it as UTF-8
$enc = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
  & ssh $hostAlias "$cli $words"
  $code = $LASTEXITCODE
} finally { [Console]::OutputEncoding = $enc }
if ($code -ne 0) { Write-Host "Categorizing ended with code $code (see above)."; exit 1 }
