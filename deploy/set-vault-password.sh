#!/bin/sh
# Set (or change) the Tweet Vault password. Stores only a salted PBKDF2 hash in .env, then restarts the vault.
cd "$(dirname "$0")"
H=$(python3 - <<'PY'
import getpass, hashlib, os, sys
p = getpass.getpass("New Tweet Vault password (12+ characters): ")
if len(p) < 12: sys.exit("Too short, nothing changed.")
if getpass.getpass("Repeat it: ") != p: sys.exit("Didn't match, nothing changed.")
s = os.urandom(16).hex()
print(f"pbkdf2_sha256:600000:{s}:{hashlib.pbkdf2_hmac('sha256', p.encode(), bytes.fromhex(s), 600000).hex()}")
PY
) || exit 1
touch .env && chmod 600 .env
if ! grep -q '^VAULT_SECRET=' .env; then
  echo "VAULT_SECRET=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')" >> .env
fi
sed -i '/^VAULT_PASSWORD_HASH=/d' .env
echo "VAULT_PASSWORD_HASH=$H" >> .env
# run as this user (the data folder is private to it), and say so if the restart goes wrong
export VAULT_UID=$(id -u) VAULT_GID=$(id -g)
docker compose up -d --force-recreate vault || { echo "Saved, but the restart failed (see above)."; exit 1; }
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:8092/healthz >/dev/null 2>&1; then
    echo "Saved. Tweet Vault restarted with the new password; every device must sign in again."; exit 0
  fi
  sleep 1
done
echo "Saved, but the vault is not healthy yet. Last logs:"; docker logs --tail 30 tweet-vault; exit 1
