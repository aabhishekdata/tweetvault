# Deploy Tweet Vault to your server over SSH. Run from PowerShell. Set $env:VAULT_SSH_HOST (user@host) first.
#   powershell -File deploy\deploy.ps1                         the server only (as always)
#   powershell -File deploy\deploy.ps1 -App                    the server, then publish a new Android app build
#   powershell -File deploy\deploy.ps1 -AppOnly                publish a new Android app build, server untouched
#   ... -App -Notes "What changed"                             notes shown with the update (default: last commit subject)
# Every deploy keeps the previous release and a database snapshot on the server. If the new version does not
# come up healthy, the previous release is put back automatically. Manual rollback: see deploy\RUNBOOK.md.
# The server-side steps live in deploy\remote.sh (copied and run by name; no script text is piped through PowerShell).
param(
  [switch]$App,
  [switch]$AppOnly,
  [string]$Notes
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$hostAlias = if ($env:VAULT_SSH_HOST) { $env:VAULT_SSH_HOST } else { throw 'Set VAULT_SSH_HOST first, for example: $env:VAULT_SSH_HOST = "user@your-server"' }
$remote = '~/tweet-vault'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$appRepo = if ($env:VAULT_APP_REPO) { $env:VAULT_APP_REPO } else { Join-Path (Split-Path $PSScriptRoot -Parent | Split-Path -Parent) 'tweet-vault-app' }   # a checkout of the Android app, beside this repo by default
$publishApp = $App -or $AppOnly

# shell files must reach Linux with LF line endings
foreach ($f in Get-ChildItem "$root\deploy\*.sh") {
  if ((Get-Content -Raw $f.FullName) -match "`r") { throw "$($f.Name) has Windows line endings; convert it to LF first." }
}

# ---- Android app: build and check it first, so a failed build changes nothing on the server ----
if ($publishApp) {
  if (-not (Test-Path "$appRepo\gradlew.bat")) { throw "No app project at $appRepo. Nothing was changed." }
  if (-not $env:JAVA_HOME) { $env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr' }
  if (-not (Test-Path "$env:JAVA_HOME\bin\java.exe")) { throw "No Java at $env:JAVA_HOME (set JAVA_HOME). Nothing was changed." }

  # version from app/build.gradle.kts
  $gradle = Get-Content -Raw "$appRepo\app\build.gradle.kts"
  $mCode = [regex]::Match($gradle, '(?m)^\s*versionCode\s*=\s*(\d+)\s*$')
  $mName = [regex]::Match($gradle, '(?m)^\s*versionName\s*=\s*"([^"]+)"\s*$')
  if (-not $mCode.Success) { throw 'versionCode not found in app\build.gradle.kts. Nothing was changed.' }
  if (-not $mName.Success) { throw 'versionName not found in app\build.gradle.kts. Nothing was changed.' }
  $versionCode = [long]$mCode.Groups[1].Value
  $versionName = $mName.Groups[1].Value
  if ($versionCode -lt 1 -or $versionCode -gt 2000000000) { throw "versionCode $versionCode is out of range. Nothing was changed." }
  if ($versionName -notmatch '^[0-9A-Za-z.+\-_ ]{1,40}$' -or $versionName.Trim() -ne $versionName) {
    throw "versionName '$versionName' may only use letters, digits, . + - _ and spaces (40 at most). Nothing was changed."
  }

  # never publish the same or an older version: the phone would not offer it anyway
  Write-Host 'Checking the app version published on the server...'
  $cur = ssh $hostAlias "cat $remote/data/app/latest.json 2>/dev/null || true"
  if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server. Nothing was changed.' }
  $curText = ($cur -join "`n").Trim()
  $publishedCode = 0
  if ($curText) {
    try { $publishedCode = [long](($curText | ConvertFrom-Json).version_code) }
    catch { throw "The server's data/app/latest.json can't be read. Fix or remove it on the server first. Nothing was changed." }
  }
  if ($versionCode -le $publishedCode) {
    throw "versionCode $versionCode is not newer than the published one ($publishedCode). Raise versionCode in app\build.gradle.kts. Nothing was changed."
  }

  $dirty = git -C $appRepo status --porcelain
  if ($dirty) { Write-Warning 'The app repository has uncommitted changes; they are part of this build.' }

  Write-Host "Building the app $versionName ($versionCode)..."
  Push-Location $appRepo
  try {
    & .\gradlew.bat assembleRelease
    if ($LASTEXITCODE -ne 0) { throw 'The app build failed (see above). Nothing was changed.' }
  } finally { Pop-Location }

  $apks = @(Get-ChildItem "$appRepo\app\build\outputs\apk\release\*.apk")
  if ($apks.Count -ne 1) { throw "Expected exactly one APK in app\build\outputs\apk\release, found $($apks.Count). Nothing was changed." }
  $apk = $apks[0]
  $apkSize = $apk.Length
  if ($apkSize -lt 1 -or $apkSize -gt 100MB) { throw "The APK is $apkSize bytes; the limit is 100 MB. Nothing was changed." }
  $apkSha = (Get-FileHash -Algorithm SHA256 $apk.FullName).Hash.ToLowerInvariant()

  if (-not $PSBoundParameters.ContainsKey('Notes')) {
    # read git's UTF-8 as UTF-8 (Windows PowerShell would otherwise mangle an em dash or emoji)
    $enc = [Console]::OutputEncoding
    try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $Notes = (git -C $appRepo log -1 --format=%s) -join ' ' }
    finally { [Console]::OutputEncoding = $enc }
  }
  $Notes = "$Notes".Trim()
  if ($Notes.Length -gt 2000) {
    $cut = 2000
    if ([char]::IsHighSurrogate($Notes[$cut - 1])) { $cut-- }   # never split an emoji in half
    $Notes = $Notes.Substring(0, $cut)
  }
  Write-Host "Built $($apk.Name): $apkSize bytes, SHA-256 $apkSha"
}

if (-not $AppOnly) {
  Write-Host 'Saving the current release and a database snapshot...'
  ssh $hostAlias "mkdir -p $remote"
  if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server. Nothing was changed.' }
  scp -q "$root\deploy\remote.sh" "${hostAlias}:$remote/remote.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy remote.sh. Nothing was changed.' }
  ssh $hostAlias "sh $remote/remote.sh prep $stamp"
  if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the server (see above). Nothing was changed.' }

  Write-Host 'Copying the app...'
  # a clean copy: files deleted locally don't linger on the server
  ssh $hostAlias "rm -rf $remote/server/src $remote/server/static"
  scp -q -r "$root\server\src" "$root\server\static" "$root\server\package.json" "$root\server\package-lock.json" "${hostAlias}:$remote/server/"
  if ($LASTEXITCODE -ne 0) { throw "Copying the app failed. To put the previous release back: ssh $hostAlias, then follow RUNBOOK.md (releases/$stamp)." }
  scp -q "$root\deploy\docker-compose.yml" "$root\deploy\nginx-vault.conf" "$root\deploy\install-public-vault.sh" "$root\deploy\set-vault-password.sh" "$root\deploy\backup-vault.sh" "$root\deploy\restore-vault.sh" "$root\deploy\RUNBOOK.md" "$root\deploy\apply-nginx-hardening.sh" "$root\deploy\apply-nginx-voice.sh" "$root\deploy\nginx-vault-extras.conf" "${hostAlias}:$remote/"

  Write-Host 'Installing dependencies and starting the container...'
  ssh $hostAlias "sh $remote/remote.sh install $stamp"
  $code = $LASTEXITCODE
  if ($code -eq 2) { throw 'The new version did not start; the previous version was put back and is running.' }
  if ($code -ne 0) { throw 'Deploy failed on the server (see above). See deploy\RUNBOOK.md.' }
  Write-Host "Deployed. Previous release kept as releases/$stamp on the server."
}

# ---- Android app: upload, verify on the server, switch latest.json ----
if ($publishApp) {
  Write-Host "Uploading the app $versionName ($versionCode)..."
  ssh $hostAlias "mkdir -p $remote/data/app"
  if ($LASTEXITCODE -ne 0) { throw 'Could not reach the server. The app was not published.' }
  scp -q "$root\deploy\remote.sh" "${hostAlias}:$remote/remote.sh"
  if ($LASTEXITCODE -ne 0) { throw 'Could not copy remote.sh. The app was not published.' }

  # the release record goes as a file (UTF-8, no BOM); remote.sh checks it and adds uploaded_at
  $meta = [ordered]@{
    version_code = $versionCode; version_name = $versionName; size = $apkSize; sha256 = $apkSha
    notes = $(if ($Notes) { $Notes } else { $null }); file = "$apkSha.apk"
  }
  $metaFile = Join-Path ([IO.Path]::GetTempPath()) "tweet-vault-latest-$stamp.json"
  [IO.File]::WriteAllText($metaFile, ($meta | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding $false))
  try {
    scp -q $apk.FullName "${hostAlias}:$remote/data/app/$apkSha.apk.tmp"
    if ($LASTEXITCODE -ne 0) { throw 'Uploading the APK failed. The app was not published.' }
    scp -q $metaFile "${hostAlias}:$remote/data/app/latest.json.incoming"
    if ($LASTEXITCODE -ne 0) { throw 'Uploading the release record failed. The app was not published.' }
  } finally { Remove-Item -Force $metaFile -ErrorAction SilentlyContinue }

  ssh $hostAlias "sh $remote/remote.sh app $apkSha"
  if ($LASTEXITCODE -ne 0) { throw 'Publishing the app failed on the server (see above). The previous release, if any, is still offered.' }

  Write-Host ''
  Write-Host "Published the app $versionName (versionCode $versionCode)."
  Write-Host '  - The phone checks on launch and once a day, then shows "Update to ..." in Vault.'
  Write-Host '  - Samsung Auto Blocker must be off to install it (Settings > Security and privacy > Auto Blocker).'
  Write-Host '  - The APK must be signed with the same key as the installed app. Until scripts\new-release-key.ps1'
  Write-Host '    has been run that is this PC''s debug key; after switching to the release key, uninstall and'
  Write-Host '    reinstall once by cable (and pair again). From then on updates come over the air.'
}
