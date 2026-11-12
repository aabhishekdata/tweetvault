#!/bin/sh
# Server-side steps for deploy.ps1 and set-anthropic-key.ps1 (copied to ~/tweet-vault and run by name, so no
# script text is piped through PowerShell). Usage:
#   sh remote.sh prep <stamp>       keep the current release and a database snapshot (last 3 of each)
#   sh remote.sh install <stamp>    install dependencies, restart, health check; roll back to <stamp> if unhealthy
#   sh remote.sh setkey             merge .env.incoming (ANTHROPIC_API_KEY, TRANSLATE_DAILY_LIMIT) into .env, restart, check
#   sh remote.sh app <sha256>       publish the Android app uploaded by deploy.ps1 -App: data/app/<sha256>.apk.tmp and
#                                   data/app/latest.json.incoming are checked, moved into place, older APKs removed
set -e
cd ~/tweet-vault
STAMP="$2"

healthy() {
  i=0
  while [ $i -lt 20 ]; do
    if curl -fsS http://127.0.0.1:8092/healthz >/dev/null 2>&1; then return 0; fi
    i=$((i + 1)); sleep 1
  done
  return 1
}

run_as_me() {
  VAULT_UID=$(id -u); VAULT_GID=$(id -g); export VAULT_UID VAULT_GID
}

case "$1" in
  prep)
    [ -n "$STAMP" ] || { echo "prep needs a stamp"; exit 1; }
    mkdir -p server data releases
    chmod 700 data
    if [ -d server/src ]; then
      cp -a server "releases/$STAMP"
      ls -1dt releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf
      echo "Saved the current release as releases/$STAMP"
    fi
    # a database snapshot before anything changes (skipped on a first deploy, when nothing runs yet)
    if docker ps --format '{{.Names}}' | grep -q '^tweet-vault$'; then
      mkdir -p data/backups
      docker exec tweet-vault node --disable-warning=ExperimentalWarning -e "
        const { DatabaseSync } = require('node:sqlite');
        new DatabaseSync('/data/vault.db').exec(\"VACUUM INTO '/data/backups/pre-deploy-$STAMP.db'\");"
      ls -1t data/backups/pre-deploy-*.db 2>/dev/null | tail -n +4 | xargs -r rm -f
      echo "Saved a database snapshot as data/backups/pre-deploy-$STAMP.db"
    fi
    ;;

  install)
    chmod 700 install-public-vault.sh set-vault-password.sh backup-vault.sh restore-vault.sh remote.sh
    # scp from Windows leaves the copied folders world-writable (707)
    find server/src server/static -type d -exec chmod 755 {} +
    find server/src server/static -type f -exec chmod 644 {} +
    if [ ! -f .env ]; then
      umask 077
      echo "VAULT_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" > .env
      echo "Created .env with a new VAULT_SECRET (no password yet: run ./set-vault-password.sh)"
    fi
    chmod 600 .env
    # compose reads these from .env too, so a manual 'docker compose up' runs as the right user
    grep -q '^VAULT_UID=' .env || echo "VAULT_UID=$(id -u)" >> .env
    grep -q '^VAULT_GID=' .env || echo "VAULT_GID=$(id -g)" >> .env
    run_as_me
    docker run --rm -u "$VAULT_UID:$VAULT_GID" -e HOME=/tmp -v "$PWD/server:/app" -w /app node:22-alpine \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error
    docker compose up -d --force-recreate 2>&1
    if healthy; then echo "Healthy on 127.0.0.1:8092"; exit 0; fi
    echo "Not healthy. Last logs:"; docker logs --tail 30 tweet-vault || true
    if [ -n "$STAMP" ] && [ -d "releases/$STAMP" ]; then
      echo "Rolling back to the previous release..."
      rm -rf server && cp -a "releases/$STAMP" server
      docker compose up -d --force-recreate 2>&1
      if healthy; then echo "Rolled back; the previous version is running."; exit 2; fi
      echo "The rollback did not come up healthy either. See RUNBOOK.md."; exit 3
    fi
    exit 1
    ;;

  setkey)
    trap 'rm -f .env.incoming' EXIT
    [ -s .env.incoming ] || { echo "Nothing arrived; nothing changed."; exit 1; }
    [ -f .env ] || { echo "No .env here yet. Deploy the vault first (deploy.ps1)."; exit 1; }
    if [ ! -d server/node_modules/@anthropic-ai/sdk ]; then
      echo "This server still runs a version without translation. Deploy first (powershell -File deploy\\deploy.ps1), then run this again."
      exit 1
    fi
    umask 077
    cp -p .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
    ls -1t .env.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -f
    grep -v -e '^ANTHROPIC_API_KEY=' -e '^TRANSLATE_DAILY_LIMIT=' .env > .env.new || true
    cat .env.incoming >> .env.new
    chmod 600 .env.new && mv .env.new .env
    echo "Saved to ~/tweet-vault/.env (private, mode 600). The previous .env is kept as .env.bak-*."
    run_as_me
    docker compose up -d --force-recreate >/dev/null 2>&1
    healthy || { echo "The vault did not come back healthy. Last logs:"; docker logs --tail 30 tweet-vault; exit 1; }
    echo "Vault restarted and healthy."
    # free check: look up one model with the key (no tokens are used); prints only ok/failed, never the key
    docker exec tweet-vault node --input-type=module -e "
      import Anthropic from '@anthropic-ai/sdk';
      try {
        const m = await new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 }).models.retrieve('claude-haiku-5-5');
        console.log('Key works. Translations will use ' + m.id + '.');
      } catch (e) {
        console.log('The key was saved, but the check failed (' + (e.status || e.name) + '). Check the key and its workspace in the Claude Console, then run this again.');
        process.exit(1);
      }"
    ;;

  setgroq)
    # set-groq-key.ps1 sent GROQ_API_KEY (and optional VOICE_* limits) in .env.incoming
    trap 'rm -f .env.incoming' EXIT
    [ -s .env.incoming ] || { echo "Nothing arrived; nothing changed."; exit 1; }
    [ -f .env ] || { echo "No .env here yet. Deploy the vault first (deploy.ps1)."; exit 1; }
    umask 077
    cp -p .env ".env.bak-$(date +%Y%m%d-%H%M%S)"
    ls -1t .env.bak-* 2>/dev/null | tail -n +4 | xargs -r rm -f
    grep -v -e '^GROQ_API_KEY=' -e '^VOICE_DAILY_MINUTES=' -e '^VOICE_DAILY_LIMIT=' .env > .env.new || true
    cat .env.incoming >> .env.new
    chmod 600 .env.new && mv .env.new .env
    echo "Saved to ~/tweet-vault/.env (private, mode 600). The previous .env is kept as .env.bak-*."
    run_as_me
    docker compose up -d --force-recreate >/dev/null 2>&1
    healthy || { echo "The vault did not come back healthy. Last logs:"; docker logs --tail 30 tweet-vault; exit 1; }
    echo "Vault restarted and healthy."
    # free check: list Groq's models with the key; prints only ok/failed, never the key
    docker exec tweet-vault node --input-type=module -e "
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + process.env.GROQ_API_KEY }, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (r && r.ok) { const j = await r.json(); const ok = (j.data || []).some((m) => m.id === 'whisper-large-v3-turbo');
        console.log(ok ? 'Key works. Voice notes will be transcribed with whisper-large-v3-turbo.' : 'Key works, but whisper-large-v3-turbo is not listed for it.'); }
      else { console.log('The key was saved, but the check failed (' + (r ? r.status : 'no answer') + '). Check the key in the Groq console, then run this again.'); process.exit(1); }"
    ;;

  app)
    # deploy.ps1 -App uploaded data/app/<sha>.apk.tmp and data/app/latest.json.incoming. The server reads
    # data/app/latest.json on every request (server/src/appupdate.js), so the APK goes into place first and
    # latest.json is switched last, in one rename: the phone never sees a record without its file.
    SHA="$2"
    echo "$SHA" | grep -Eq '^[0-9a-f]{64}$' || { echo "app needs the APK's SHA-256 (64 lower-case hex)"; exit 1; }
    mkdir -p data/app
    cd data/app
    trap 'rm -f "$SHA.apk.tmp" latest.json.incoming latest.json.tmp' EXIT
    [ -f "$SHA.apk.tmp" ] || { echo "The APK did not arrive (data/app/$SHA.apk.tmp). Nothing changed."; exit 1; }
    [ -s latest.json.incoming ] || { echo "The release record did not arrive. Nothing changed."; exit 1; }
    ACTUAL=$(sha256sum "$SHA.apk.tmp" | cut -d' ' -f1)
    if [ "$ACTUAL" != "$SHA" ]; then
      echo "The uploaded APK's SHA-256 is $ACTUAL, expected $SHA (a broken upload). Nothing changed."; exit 1
    fi
    # checks the record with the same rules as the server, refuses an older or equal versionCode, adds
    # uploaded_at and writes latest.json.tmp; prints the previous release's sha256 (empty if none)
    PREV=$(python3 - "$SHA" <<'PY'
import json, os, re, sys
from datetime import datetime, timezone
sha = sys.argv[1]
def die(msg):
    print(msg, file=sys.stderr); sys.exit(1)
try:
    with open('latest.json.incoming', encoding='utf-8-sig') as f:
        r = json.load(f)
except Exception as e:
    die('The release record is not valid JSON: %s' % e)
if not isinstance(r, dict) or set(r) - {'version_code', 'version_name', 'size', 'sha256', 'notes', 'file'}:
    die('The release record has unexpected fields.')
vc, vn, size, notes = r.get('version_code'), r.get('version_name'), r.get('size'), r.get('notes')
if type(vc) is not int or not 1 <= vc <= 2000000000: die('Bad version_code.')
if not isinstance(vn, str) or not re.fullmatch(r'[0-9A-Za-z.+\-_ ]{1,40}', vn) or vn.strip() != vn: die('Bad version_name.')
if type(size) is not int or not 1 <= size <= 100 * 1024 * 1024: die('Bad size (1 byte to 100 MB).')
if size != os.path.getsize(sha + '.apk.tmp'): die('size does not match the uploaded APK.')
if r.get('sha256') != sha or r.get('file') != sha + '.apk': die('sha256 or file does not match the uploaded APK.')
# UTF-16 units, as the server counts them (JavaScript string length)
if notes is not None and (not isinstance(notes, str) or len(notes.encode('utf-16-le')) // 2 > 2000): die('Bad notes.')
prev = ''
if os.path.exists('latest.json'):
    try:
        with open('latest.json', encoding='utf-8-sig') as f:
            old = json.load(f)
        old_vc = old.get('version_code')
        if type(old_vc) is int and vc <= old_vc:
            die('versionCode %d is not newer than the published %d. Nothing changed.' % (vc, old_vc))
        if isinstance(old.get('sha256'), str) and re.fullmatch(r'[0-9a-f]{64}', old['sha256']):
            prev = old['sha256']
    except SystemExit:
        raise
    except Exception:
        # never skip the versionCode check: an unreadable record is for the owner to look at
        die('The published latest.json could not be read, so the version check cannot run. Look at ~/tweet-vault/data/app/latest.json and remove it by hand if it is broken.')
out = {'version_code': vc, 'version_name': vn, 'size': size, 'sha256': sha, 'notes': notes or None,
       'file': sha + '.apk', 'uploaded_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}
with open('latest.json.tmp', 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=2)
    f.write('\n')
    f.flush()
    os.fsync(f.fileno())
print(prev)
PY
)
    # the container runs as this same user (VAULT_UID); files readable, the folder private like data/
    chmod 700 .
    chmod 644 "$SHA.apk.tmp" latest.json.tmp
    mv -f "$SHA.apk.tmp" "$SHA.apk"
    mv -f latest.json.tmp latest.json
    rm -f latest.json.incoming
    # keep this release and the one before it; older APKs and stray uploads go
    for f in *.apk *.apk.tmp; do
      [ -e "$f" ] || continue
      case "$f" in
        "$SHA.apk") ;;
        *) if [ -n "$PREV" ] && [ "$f" = "$PREV.apk" ]; then :; else rm -f "$f"; echo "Removed old $f"; fi ;;
      esac
    done
    echo "Published: $(grep -E '"version_(name|code)"' latest.json | tr -d ' \n')"
    ;;

  *)
    echo "usage: sh remote.sh prep|install <stamp> | setkey | app <sha256>"; exit 1 ;;
esac
