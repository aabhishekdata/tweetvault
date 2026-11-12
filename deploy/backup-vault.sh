#!/bin/sh
# Nightly Tweet Vault backup: consistent SQLite copy, checked, 14 days kept locally, 60 days on Google Drive.
# Any failure is printed (for data/backup.log) and, when ALERT_WEBHOOK_URL is set in .env, pushed to that URL.
cd "$(dirname "$0")"
mkdir -p data/backups
F="backups/vault-$(date +%F).db"

alert() {
  echo "$(date '+%F %T') $1"
  HOOK=$(sed -n 's/^ALERT_WEBHOOK_URL=//p' .env 2>/dev/null | tail -1)
  case "$HOOK" in https://*) curl -fsS -m 10 -d "Tweet Vault backup: $1" "$HOOK" >/dev/null 2>&1 || true ;; esac
}

rm -f "data/$F"
docker exec tweet-vault node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/vault.db');
db.exec(\"VACUUM INTO '/data/$F'\");
" || { alert "backup failed: could not copy the database"; exit 1; }

# Check the copy really opens and holds the data (a restore test on every backup).
CHECK=$(docker exec tweet-vault node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/$F', { readOnly: true });
const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
const n = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
console.log(ok === 'ok' ? 'ok ' + n : 'bad ' + ok);
" 2>&1) || CHECK="bad $CHECK"
case "$CHECK" in
  ok*) echo "$(date '+%F %T') backup $F checked: ${CHECK#ok } items" ;;
  *) alert "backup $F failed its check: $CHECK"; exit 1 ;;
esac
find data/backups -name 'vault-*.db' -mtime +14 -delete

RCLONE="$HOME/bin/rclone"
DEST="gdrive:tweet-vault-backups"
if "$RCLONE" listremotes 2>/dev/null | grep -q '^gdrive:$'; then
  if "$RCLONE" copy data/backups "$DEST" && "$RCLONE" delete "$DEST" --min-age 60d --include 'vault-*.db'; then
    echo "$(date '+%F %T') vault backup uploaded to Google Drive"
  else
    alert "backup kept on the server, but the Google Drive upload failed"
  fi
  # Kept images (data/media, one file per picture, named by its SHA-256 so a file never changes). "copy"
  # only adds new files and never deletes on Drive, so a picture removed here stays in the backup.
  # Half-finished downloads (.tmp-*) are left out: on Drive they would stay for good.
  if [ -d data/media ]; then
    if "$RCLONE" copy data/media "$DEST/media" --exclude '.tmp-*'; then
      echo "$(date '+%F %T') images uploaded to Google Drive ($(find data/media -maxdepth 1 -type f ! -name '.tmp-*' | wc -l) files on the server)"
    else
      alert "the database backup is on Google Drive, but the image upload failed"
    fi
  fi
  # Voice notes' audio (data/voice/<id>.ogg|webm|m4a). A file never changes once its upload is finished, so
  # "copy" is safe the same way. Uploads still in progress (<id>.part) are left out.
  if [ -d data/voice ]; then
    if "$RCLONE" copy data/voice "$DEST/voice" --exclude '*.part' --exclude '.tmp-*'; then
      echo "$(date '+%F %T') voice notes uploaded to Google Drive ($(find data/voice -maxdepth 1 -type f ! -name '*.part' | wc -l) files on the server)"
    else
      alert "the database backup is on Google Drive, but the voice note upload failed"
    fi
  fi
else
  echo "$(date '+%F %T') gdrive remote not configured; vault backup kept on the server only"
fi
