# Fetch YouTube transcripts on this PC and save them in the vault (the server's IP is often bot-checked by YouTube).
#   powershell -File deploy\fetch-transcripts.ps1            (fetch and save)
#   powershell -File deploy\fetch-transcripts.ps1 -DryRun    (list what it would do; downloads and sends nothing)
#
# What it does:
#   1. asks the server which saved videos have no transcript (cli.js youtube-pending: item id <TAB> video id)
#   2. for each one, runs the local yt-dlp for English subtitles only (no video download, json3 or vtt) into a temp folder
#   3. sends the subtitle file to the server on stdin (cli.js set-transcript <item id> --lang <code>); when yt-dlp
#      finds no English subtitles, tells the server so (cli.js set-transcript <item id> --none), so the next run
#      moves on to other videos instead of asking about the same ones again
#   4. prints a summary
# Ids from the server are checked (item id: digits; video id: exactly 11 of A-Z a-z 0-9 _ -) before they are used in
# any command, so nothing the server or YouTube sends can add words to a command line here or on the server.
param([switch]$DryRun, [ValidateRange(1, 100)][int]$Limit = 20)
$ErrorActionPreference = 'Stop'
$hostAlias = if ($env:VAULT_SSH_HOST) { $env:VAULT_SSH_HOST } else { throw 'Set VAULT_SSH_HOST first, for example: $env:VAULT_SSH_HOST = "user@your-server"' }
$cli = 'docker exec tweet-vault node --disable-warning=ExperimentalWarning /app/src/cli.js'
$cliIn = 'docker exec -i tweet-vault node --disable-warning=ExperimentalWarning /app/src/cli.js'

if (-not (Get-Command yt-dlp -ErrorAction SilentlyContinue)) { throw 'yt-dlp is not on PATH. Install it first (winget install yt-dlp).' }

$lines = & ssh $hostAlias "$cli youtube-pending --limit $Limit"
if ($LASTEXITCODE -ne 0) { throw 'Could not ask the server for videos (see above). Nothing was changed.' }

$todo = @()
foreach ($l in @($lines)) {
  if ("$l" -match '^(\d{1,15})\t([A-Za-z0-9_-]{11})$') { $todo += [pscustomobject]@{ Item = $Matches[1]; Video = $Matches[2] } }
  elseif ("$l".Trim()) { Write-Warning "Skipped a line the server sent that is not 'item<TAB>video': $l" }
}
if (-not $todo.Count) { Write-Host 'Every saved video already has a transcript (or has none to get).'; exit 0 }
Write-Host "$($todo.Count) video(s) without a transcript."

$saved = 0; $noSubs = 0; $failed = 0
foreach ($t in $todo) {
  $url = "https://www.youtube.com/watch?v=$($t.Video)"
  if ($DryRun) {
    Write-Host "Would run: yt-dlp --skip-download --write-auto-subs --write-subs --sub-langs 'en-orig,en' --sub-format json3/vtt -- $url"
    Write-Host "Would send the subtitle file to: ssh $hostAlias '$cliIn set-transcript $($t.Item) --lang <code>'"
    Write-Host "  (or, with no English subtitles: ssh $hostAlias '$cli set-transcript $($t.Item) --none')"
    continue
  }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("tv-yt-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    # "--" ends the options, so the address can never be read as one
    # json3 first: YouTube answers the vtt address with "429 Too Many Requests" from some networks, while json3
    # for the same video downloads (seen 2026-11-11); the server reads both. Two languages at most per try, so
    # one video is a handful of requests: the plain and original English, then any other English if neither exists.
    $ytOut = ''
    $files = @()
    foreach ($langs in @('en-orig,en', 'en.*')) {
      # yt-dlp reports problems on its error stream; with 'Stop' PowerShell would end the script on the first such line
      $ErrorActionPreference = 'Continue'
      try {
        $ytOut += (& yt-dlp --quiet --no-warnings --skip-download --write-auto-subs --write-subs --sub-langs $langs --sub-format 'json3/vtt' `
          --sleep-subtitles 1 --output (Join-Path $tmp '%(id)s.%(ext)s') -- $url 2>&1 | Out-String)
      } finally { $ErrorActionPreference = 'Stop' }
      $files = @(Get-ChildItem -Path $tmp -File | Where-Object { $_.Extension -in '.json3', '.vtt' -and $_.Length -gt 0 })
      # stop at the first file, and after an error (asking again right away only adds to "too many requests")
      if ($files.Count -or $ytOut -match 'ERROR') { break }
    }
    # yt-dlp said something went wrong (blocked, rate-limited, no network) and wrote no file: that is not
    # "this video has no subtitles". Leave the video on the server's list, so the next run tries again.
    if (-not $files.Count -and $ytOut -match 'ERROR') {
      $why = (($ytOut -split "`r?`n") | Where-Object { $_ -match 'ERROR' } | Select-Object -First 1)
      Write-Host "  $($t.Video): could not download subtitles, will try again next time. $("$why".Trim())"
      $failed++
      continue
    }
    if (-not $files.Count) {
      $noSubs++
      $msg = & ssh $hostAlias "$cli set-transcript $($t.Item) --none"
      if ($LASTEXITCODE -eq 0) { Write-Host "  $($t.Video): no English subtitles (the server won't list it again)." }
      else { Write-Host "  $($t.Video): no English subtitles; the server could not record that: $("$msg".Trim())"; $failed++ }
      continue
    }
    # the plain "en" file first (manual subtitles when there are any), then en-GB / en-orig and the like
    $pick = $files | Sort-Object @{ Expression = { if ($_.Name -match '\.en\.(vtt|json3)$') { 0 } elseif ($_.Name -match '\.en-orig\.(vtt|json3)$') { 1 } else { 2 } } }, Name | Select-Object -First 1
    $lang = 'en'
    if ($pick.Name -match '\.(en(?:-[A-Za-z0-9]{1,8})?)\.(?:vtt|json3)$') { $lang = $Matches[1] -replace '-orig$', '' }
    if ($lang -notmatch '^en(-[A-Za-z0-9]{1,8})?$') { $lang = 'en' }
    # the server takes 4 MB at most (youtube.js MAX_STDIN)
    if ($pick.Length -gt 4MB) { Write-Host "  $($t.Video): subtitle file too large."; $failed++; continue }
    # the file goes to ssh's stdin byte for byte (a PowerShell pipe would re-encode it)
    $outFile = Join-Path $tmp 'ssh-out.txt'
    $errFile = Join-Path $tmp 'ssh-err.txt'
    $p = Start-Process -FilePath 'ssh' -ArgumentList @($hostAlias, "`"$cliIn set-transcript $($t.Item) --lang $lang`"") `
      -RedirectStandardInput $pick.FullName -RedirectStandardOutput $outFile -RedirectStandardError $errFile -NoNewWindow -Wait -PassThru
    $msg = (Get-Content -Raw -ErrorAction SilentlyContinue $outFile) + (Get-Content -Raw -ErrorAction SilentlyContinue $errFile)
    if ($p.ExitCode -eq 0) { Write-Host "  $($t.Video): $($msg.Trim())"; $saved++ }
    else { Write-Host "  $($t.Video): the server refused it: $($msg.Trim())"; $failed++ }
  } catch {
    Write-Host "  $($t.Video): $($_.Exception.Message)"; $failed++
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
  }
}
if ($DryRun) { Write-Host 'Dry run: nothing was downloaded or sent.'; exit 0 }
Write-Host "Done: $saved saved, $noSubs without English subtitles, $failed failed."
if ($failed) { exit 1 }
