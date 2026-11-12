#!/bin/sh
# Adds nginx-vault-extras.conf (hide the nginx version, friendly "restarting" page) to the LIVE vault config,
# inside the HTTPS server block, without replacing the file (Certbot's HTTPS lines stay as they are).
#   sudo sh /home/user/tweet-vault/apply-nginx-hardening.sh
#   sh /home/user/tweet-vault/apply-nginx-hardening.sh --preview     (no sudo: shows the result, changes nothing)
# Safe: keeps a dated copy of the live file, tests with nginx -t, and puts the copy back if the test fails.
set -e
LIVE=/etc/nginx/sites-available/vault.example.com
SNIP=/home/user/tweet-vault/nginx-vault-extras.conf
BACKUPS=/etc/nginx/vault-config-backups

[ -f "$LIVE" ] || { echo "No live config at $LIVE"; exit 1; }
[ -f "$SNIP" ] || { echo "Missing $SNIP (deploy first)"; exit 1; }

merged() {
  # insert the snippet right after the first "server_name vault.example.com;" (the HTTPS block)
  awk -v snip="$SNIP" '
    done == 0 && /^[[:space:]]*server_name vault\.example\.com;/ {
      print
      while ((getline line < snip) > 0) print "    " line
      done = 1
      next
    }
    { print }
    END { if (done == 0) exit 3 }
  ' "$LIVE"
}

if grep -q '@down' "$LIVE"; then echo "Already applied; nothing to do."; exit 0; fi

if [ "$1" = "--preview" ]; then
  TMP=$(mktemp)
  merged > "$TMP"
  diff -u "$LIVE" "$TMP" || true
  rm -f "$TMP"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo sh $0"; exit 1; }
mkdir -p "$BACKUPS"
COPY="$BACKUPS/vault.example.com.$(date +%Y%m%d-%H%M%S)"
cp -p "$LIVE" "$COPY"
TMP=$(mktemp)
merged > "$TMP"
cat "$TMP" > "$LIVE"
rm -f "$TMP"
if nginx -t; then
  systemctl reload nginx
  echo "Applied and reloaded. The previous config is kept at $COPY"
else
  cp -p "$COPY" "$LIVE"
  echo "nginx -t failed, so the previous config was put back. Nothing changed."
  exit 1
fi
