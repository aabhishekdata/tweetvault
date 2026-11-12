# Tweet Vault runbook

Server: `user@your-server`, app folder `~/tweet-vault`, public at https://vault.example.com.
Secrets live only in `~/tweet-vault/.env` (mode 600). They are never in this repository, the page or the logs.

## Secrets in `.env`

| Name | What it is | If it leaks or is lost |
|---|---|---|
| `VAULT_SECRET` | Signs nothing public; seals the two-step secret in the database | Keep a copy in your password manager. Lost: see "Lost .env". |
| `VAULT_PASSWORD_HASH` | Salted PBKDF2 hash of the vault password | Change the password: `./set-vault-password.sh` (signs every device out). |
| `ANTHROPIC_API_KEY` | Claude key for translations (server only) | Rotate it in the Claude Console, put the new one here, restart. |
| `TRANSLATE_DAILY_LIMIT` | Optional, default 200 translations a day | |
| `GROQ_API_KEY` | Groq key for voice-note transcription (Whisper, server only). The notes use `ANTHROPIC_API_KEY` (Claude Sonnet 5.5) | Rotate it in the Groq console, then `set-groq-key.ps1` again. |
| `VOICE_DAILY_MINUTES`, `VOICE_DAILY_LIMIT` | Optional, default 240 minutes of audio and 50 Claude calls (notes plus extra passes) a day | |
| `YOUTUBE_API_KEY` | Optional YouTube Data API v3 key: adds the description (chapters), date and length of saved videos. Without it, oEmbed and the watch page are used | Delete it in Google Cloud Console, make a new one, put it here, restart. |
| `YOUTUBE_TRANSCRIPTS` | Optional. `pc` stops the server trying transcripts at all (they come only from `fetch-transcripts.ps1`) | |
| `ALERT_WEBHOOK_URL` | Optional `https://` URL (for example an ntfy.sh topic) that gets a short push on server errors and failed backups | |
| `VAULT_UID`, `VAULT_GID` | Written by deploy.ps1 | |

### Turn on translation

1. In the Claude Console (platform.claude.com), create an API key for a workspace used only by the vault, and set a monthly
   **spend limit** on that workspace (a few dollars is plenty: Haiku costs about $0.10 per million input tokens).
2. Deploy the current version once (`powershell -File deploy\deploy.ps1`), so the server has translation.
3. On your PC: `powershell -File deploy\set-anthropic-key.ps1`. It asks for the key (hidden), sends it over SSH
   straight into `~/tweet-vault/.env` (never saved on the PC), restarts the vault and checks the key with a free
   Models API call. `-DryRun` shows what it would do without sending anything. Re-run it to rotate the key.
4. Reload the vault. Chinese, Japanese and other non-Latin posts translate themselves; any post has
   "Translate to English" in its ⋯ menu.

Never paste the key into the vault, a chat, an email or this repository. If it was ever shared anywhere, rotate it.

### Turn on voice notes (PLAN-VOICE.md)

1. Translation's Claude key (above) also writes the voice notes. Raise that workspace's spend limit a little:
   one 90-minute note is roughly 25k tokens in and up to 10k out on Sonnet 5.5.
2. Create a Groq API key at console.groq.com, then on your PC: `powershell -File deploy\set-groq-key.ps1`.
3. Once, on the server: `sudo sh ~/tweet-vault/apply-nginx-voice.sh` (`--preview` without sudo shows the change).
   It lets `/api/voice/` take 512 KB upload pieces with a 60 s body timeout; the rest of the site keeps 256k / 15 s.
4. Audio lives in `data/voice/<id>.ogg|webm|m4a` and goes to Google Drive with the nightly backup (`voice/`).
   Housekeeping deletes uploads abandoned for a week.
5. Optional: the spellings Whisper should prefer (names, products):
   `ssh user@your-server "docker exec tweet-vault node --disable-warning=ExperimentalWarning /app/src/cli.js voice-vocab 'Tweet Vault, Claude, ...'"`

## Deploying and rolling back

`powershell -File deploy\deploy.ps1` keeps the previous release in `~/tweet-vault/releases/<time>` and a database
snapshot in `data/backups/pre-deploy-<time>.db` (the last 3 of each). If the new version does not come up healthy,
the script puts the previous release back by itself.

Roll back by hand (for example, a bug you notice after a deploy):

```sh
cd ~/tweet-vault
ls -1t releases/                        # newest first
rm -rf server && cp -a releases/<time> server
docker compose up -d --force-recreate
curl -fsS http://127.0.0.1:8092/healthz  # {"ok":true}
```

Database changes are additive (new tables and columns), so an older release runs on a newer database. One exception:
v4 (Nov 2026) also merges tags that differ only in non-English letter case ("Émoji"/"émoji") into one. Rolling back
past v4 is still safe: the older release keeps working, and tags it adds are repaired the next time the newer release starts.
Rolling back past v8 (Nov 2026, web articles and YouTube videos): the older release's worker marks every link still
waiting to be read 'n/a'. When the newer release starts again it puts those links back in the queue by itself; to be
sure, run `node src/cli.js read-links` and `node src/cli.js backfill-youtube` once you are on v8 again.
If data itself went wrong, restore the pre-deploy snapshot (next section).

nginx: the live file `/etc/nginx/sites-available/vault.example.com` also holds Certbot's HTTPS lines, so never copy
`nginx-vault.conf` over it. Hardening (hidden nginx version, a calm "restarting" page) is added in place with
`sudo sh ~/tweet-vault/apply-nginx-hardening.sh` (`--preview` without sudo shows the change first). It keeps a copy in
`/etc/nginx/vault-config-backups/`, tests with `nginx -t`, and restores the copy if the test fails.
If HTTPS ever goes missing: `sudo certbot --nginx -d vault.example.com --redirect`.

## Backups

`backup-vault.sh` copies the database with `VACUUM INTO`, checks the copy (`PRAGMA integrity_check` plus a count of
items, which is a small restore test every night), keeps 14 days on the server and 60 days on Google Drive.
After the database it copies the kept images (`data/media`, one file per picture named by its SHA-256) to
`gdrive:tweet-vault-backups/media` with `rclone copy`, which only adds files and never deletes on
Drive. Half-finished downloads (`.tmp-*`) are left out. About 0.3 MB per picture.

Schedule it once (`crontab -e`):

```
40 2 * * * /home/user/tweet-vault/backup-vault.sh >> /home/user/tweet-vault/data/backup.log 2>&1
```

Check it ran: `tail ~/tweet-vault/data/backup.log`.

## Restoring

```sh
cd ~/tweet-vault
./restore-vault.sh                                  # lists backups
./restore-vault.sh data/backups/vault-2026-11-06.db # checks it, asks, keeps the current DB, restores, health-checks
```

To restore from Google Drive first: `~/bin/rclone copy gdrive:tweet-vault-backups/vault-<date>.db data/backups/`.

Then put the images back (the database only knows their names; without the files the page shows no thumbnails
and Claude gets no pictures, but nothing breaks). This only adds missing files, so it is safe to run again:

```sh
~/bin/rclone copy gdrive:tweet-vault-backups/media data/media
```

Images saved after that backup but deleted since are cleaned up by housekeeping (files no row points at).
Posts saved before images were kept, or restored without them: `docker exec tweet-vault node /app/src/cli.js
backfill-media` queues their pictures again, and the server downloads them in the background. It also finds
saved pictures whose file is missing from `data/media` (a restore without the images, or a lost file) and queues
them to be downloaded again; pictures X no longer has end up failed.

The restore needs the same `.env`. Test a restore on a copy every few months; the nightly check covers corruption,
not a lost `.env`.

### Lost `.env`

Without `VAULT_SECRET` the two-step secret in the database can't be opened. Data is fine. To get back in:

1. Create a new `.env` (`./set-vault-password.sh` writes `VAULT_SECRET` and the password hash).
2. Reset two-step sign-in: `docker exec -it tweet-vault node /app/src/cli.js mfa-reset`.
3. Sign in, set up the authenticator again, and pair phones again.

## Turn on the MCP endpoint (Claude reads the vault)

The app answers `POST /mcp` as soon as it is deployed: the existing `location /` already proxies it, and the app
itself checks the key, the origin, the 64 KB size limit and 60 requests a minute per key. The nginx snippet only adds
an edge rate limit and body limit for that path, so it can wait.

1. Deploy as usual, then on the Security page open **Connect Claude**, create a key and paste the command it shows
   (`claude mcp add --transport http vault https://vault.example.com/mcp --header "Authorization: Bearer tv_…"`).
   Check with `claude mcp list`. The key is a read-only device: remove it under **Paired phones and keys**.
2. Later, to add the edge limits: the live site file `/etc/nginx/sites-available/vault.example.com` is managed by
   Certbot, so edit it by hand, do not replace it. Copy it first
   (`sudo cp -p /etc/nginx/sites-available/vault.example.com /etc/nginx/vault-config-backups/vault.example.com.$(date +%Y%m%d-%H%M%S)`),
   then add the two pieces from `deploy/nginx-vault-mcp.conf` (the `limit_req_zone` line at the top, the
   `location = /mcp` block inside the 443 server block), run `sudo nginx -t` and `sudo systemctl reload nginx`.
   If `nginx -t` fails, put the copy back.
3. Quick check from the PC: `curl -s -o NUL -w "%{http_code}" -X POST https://vault.example.com/mcp` gives `401`
   (no key). Every tool and prompt call shows in **Recent activity** as "Claude read the vault" with its name only.

## Connect claude.ai (custom connector, OAuth)

claude.ai (web, the desktop app and the phone app) connects with OAuth instead of a key. The app serves everything
itself: the discovery documents under `/.well-known/oauth-*`, registration, a consent page behind your password
and two-step code, and tokens. The existing `location /` already proxies all of it, so it works as soon as it is
deployed; the nginx blocks in `deploy/nginx-vault-mcp.conf` (`location /oauth/` and `location ^~ /.well-known/oauth-`,
plus the `vault_oauth` limit_req_zone line) only add edge limits, added by hand the same way as the `/mcp` block.

1. `VAULT_ORIGINS` must start with `https://vault.example.com`: its first entry is the OAuth issuer and the
   resource (`https://vault.example.com/mcp`), and claude.ai checks both exactly.
2. In Claude, open Customize, then Connectors, then Add custom connector. URL `https://vault.example.com/mcp`, leave the client ID
   and secret empty, then Connect. The vault's consent page opens (sign in first if asked). Check that it says
   "claude.ai", then Allow.
3. It shows on the Security page under Connect Claude, Connected apps. Remove it there to cut it off at once.
   Access tokens last 1 hour, refresh tokens 30 days and rotate on every use; a reused refresh token or a reused
   code removes the connection by itself ("Connected app removed ..." in Recent activity), and so does a refresh
   token that ran out (30 days unused). Removing an app also deletes its registration when nothing else uses it.
   If Claude Code later says the app is not registered: run `/mcp`, clear the vault server's saved sign-in, and
   connect again; in claude.ai, remove the connector and add it again.
4. Quick checks from the PC: `curl -s https://vault.example.com/.well-known/oauth-protected-resource` shows
   `"resource":"https://vault.example.com/mcp"`, and `curl -si -X POST https://vault.example.com/mcp` shows a
   `WWW-Authenticate` header with `resource_metadata=`.

Only two kinds of redirect address can ever be registered: `https://claude.ai/api/mcp/auth_callback` and
`http://localhost` or `http://127.0.0.1` with `/callback` on any port (Claude Code's own OAuth sign-in). For a
localhost app the consent page warns that any program on that computer can claim to be Claude Code.

## Publish an Android app update

The Vault app (TweetVaultApp) checks `GET /api/app/latest` on launch and once a day, shows "Update to …", downloads
`GET /api/app/apk`, checks the size and SHA-256, and installs it with Android's installer.

1. In `TweetVaultApp\app\build.gradle.kts`, raise `versionCode` (it must be higher than the published one) and set
   `versionName`. Commit.
2. On the PC: `powershell -File deploy\deploy.ps1 -AppOnly` (the server is left alone), or `-App` to deploy the
   server first and then publish the app. Add `-Notes "What changed"`; without it the last commit subject in the
   app repository is used. The script:
   - reads `versionCode` and `versionName`, and refuses a `versionCode` that is not higher than the one in the
     server's `data/app/latest.json`;
   - runs `gradlew.bat assembleRelease` (with `JAVA_HOME` set to Android Studio's `jbr` when it isn't set), and
     takes the one APK in `app\build\outputs\apk\release`;
   - computes its SHA-256 and size, uploads it as `data/app/<sha256>.apk.tmp` plus the record, then runs
     `remote.sh app <sha256>`, which checks the hash with `sha256sum`, moves the APK into place, writes
     `latest.json` atomically, and removes older APKs except the previous one.
   A failed build or check changes nothing on the server.
3. Before installing on the phone: **Samsung Auto Blocker must be off** (Settings, Security and privacy, Auto
   Blocker), and Vault must be allowed to "Install unknown apps" once.
4. **Signing:** Android only installs an update signed with the same key as the installed app. Until
   `TweetVaultApp\scripts\new-release-key.ps1` has been run, release builds use this PC's debug key. After
   switching to the release key, uninstall and reinstall the app by cable once (then pair the phone again);
   from then on updates come over the air. Back up the release key: without it no further update installs.

What lives where, on the server: `~/tweet-vault/data/app/` (`/data/app` in the container) holds `latest.json`
(`version_code`, `version_name`, `size`, `sha256`, `notes`, `file`, `uploaded_at`) and `<sha256>.apk`. The server
reads `latest.json` on every request and serves no release (204 / 404, logged once) if anything in it doesn't check
out: the APK must be named exactly `<sha256>.apk` in that folder, its real size must match, at most 100 MB.

- **Stop offering an update:** `rm ~/tweet-vault/data/app/latest.json` (the phone then hears "no release").
- **Go back to the previous build:** Android won't install a lower `versionCode` over a higher one. Publish the
  old code again with a higher `versionCode` instead.
- **Who can download:** the phone's capture token, or a signed-in browser. Read-only keys (Claude, MCP) get 403.
  At most 10 APK downloads per device per hour (429 after that); each download shows in Recent activity as
  "App update downloaded" with the device name and version.
- **Check from the PC:** `curl -s -o NUL -w "%{http_code}" https://vault.example.com/api/app/latest` gives `401` (no token).

## YouTube transcripts from the PC

A shared YouTube link is saved with its title, channel, length and chapters. The server also tries the transcript,
but YouTube often answers a data-centre address with "Sign in to confirm you're not a bot". Those videos show
"No transcript yet" and wait for the PC:

1. On the PC (yt-dlp on PATH): `powershell -File deploy\fetch-transcripts.ps1`. It asks the server for up to 20
   videos without a transcript (`cli.js youtube-pending`), fetches English subtitles with the local yt-dlp (no video
   download), and sends each `.vtt` to `cli.js set-transcript <item id>` over SSH. `-DryRun` only lists what it would do.
2. By hand, for one video: `ssh user@your-server "docker exec -i tweet-vault node --disable-warning=ExperimentalWarning /app/src/cli.js set-transcript <item id> --lang en" < captions.vtt`
   (WebVTT or YouTube json3, 10 MB at most).
3. Optional key: create a YouTube Data API v3 key in Google Cloud Console (restrict it to that API), add
   `YOUTUBE_API_KEY=...` to `~/tweet-vault/.env` and restart. The key is never logged.

## Something is wrong

- Server errors appear in the vault under **Security → Recent activity** as "Server error", and in `docker logs tweet-vault`.
- `curl -fsS http://127.0.0.1:8092/healthz` on the server; `docker ps` for the container state.
- Locked out by "Too many attempts": wait 15 minutes. A browser you marked "keep me signed in" is not affected by
  lockouts caused by other people.
- Lost phone: sign in with a recovery code, then Security → set up on a new phone. Every other session and trusted
  browser is signed out automatically when the new authenticator is confirmed.
