# The vault's once-a-day job on this PC (Task Scheduler: "Tweet Vault - fetch YouTube transcripts", 10:00).
#   1. fetch-transcripts.ps1   YouTube transcripts the server could not get
#   2. categorize.ps1          file loose Inbox items into categories (after 1, so new transcripts count)
# Each step runs on its own: a failed or empty first step never stops the second.
$here = $PSScriptRoot
$failed = 0
foreach ($step in 'fetch-transcripts.ps1', 'categorize.ps1') {
  Write-Host "== $step"
  try {
    & (Join-Path $here $step)
    if ($LASTEXITCODE) { $failed++ }
  } catch {
    Write-Host "$step stopped: $($_.Exception.Message)"
    $failed++
  }
  $global:LASTEXITCODE = 0
}
if ($failed) { exit 1 }
