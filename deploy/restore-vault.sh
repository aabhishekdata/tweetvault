#!/bin/sh
# Restore Tweet Vault from a backup made by backup-vault.sh.
#   ./restore-vault.sh                         list the backups on the server
#   ./restore-vault.sh data/backups/vault-2026-11-06.db
# The current database is kept as data/vault.db.before-restore-<time> first, so a restore can itself be undone.
# Needs the same .env (VAULT_SECRET and VAULT_PASSWORD_HASH): the two-step secret in the database is sealed
# with VAULT_SECRET. If .env was lost, see RUNBOOK.md ("Lost .env").
set -e
cd "$(dirname "$0")"
if [ -z "$1" ]; then
  echo "Backups on this server:"; ls -1t data/backups/vault-*.db 2>/dev/null || echo "  (none)"
  echo "Usage: $0 data/backups/vault-YYYY-MM-DD.db"; exit 1
fi
SRC="$1"
[ -f "$SRC" ] || { echo "No such file: $SRC"; exit 1; }
grep -q '^VAULT_SECRET=' .env || { echo ".env has no VAULT_SECRET; restore it first (RUNBOOK.md)"; exit 1; }

# check the backup before touching anything (works without the container)
docker run --rm -v "$PWD/$(dirname "$SRC"):/b:ro" node:22-alpine node --disable-warning=ExperimentalWarning -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/b/$(basename "$SRC")', { readOnly: true });
const ok = db.prepare('PRAGMA integrity_check').get().integrity_check;
if (ok !== 'ok') { console.error('Backup is damaged: ' + ok); process.exit(1); }
console.log('Backup is fine: ' + db.prepare('SELECT COUNT(*) AS n FROM items').get().n + ' items.');
"

printf "Replace the live vault with %s? Type yes: " "$SRC"; read -r A; [ "$A" = "yes" ] || { echo "Nothing changed."; exit 1; }
export VAULT_UID=$(id -u) VAULT_GID=$(id -g)
docker compose stop vault
T=$(date +%Y%m%d-%H%M%S)
[ -f data/vault.db ] && cp -p data/vault.db "data/vault.db.before-restore-$T"
rm -f data/vault.db-wal data/vault.db-shm
cp "$SRC" data/vault.db
chmod 600 data/vault.db
docker compose up -d vault
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8092/healthz >/dev/null 2>&1; then
    echo "Restored from $SRC and healthy. The old database is data/vault.db.before-restore-$T"; exit 0
  fi
  sleep 1
done
echo "Started but not healthy yet. Last logs:"; docker logs --tail 30 tweet-vault; exit 1
