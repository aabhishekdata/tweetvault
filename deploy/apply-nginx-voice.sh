#!/bin/sh
# Adds the voice-note upload limits (nginx-vault.conf: the vault_voice zone and "location ^~ /api/voice") to
# the LIVE vault config, without replacing the file (Certbot's HTTPS lines stay as they are).
#   sudo sh /home/user/tweet-vault/apply-nginx-voice.sh
#   sh /home/user/tweet-vault/apply-nginx-voice.sh --preview     (no sudo: shows the result, changes nothing)
# Safe: keeps a dated copy of the live file, tests with nginx -t, and puts the copy back if the test fails.
# Without it, uploads still work on the default 256k / 15 s limits only if a piece is under 256 KB, which the
# apps' 512 KB pieces are not, so run this once before using voice notes.
set -e
LIVE=/etc/nginx/sites-available/vault.example.com
BACKUPS=/etc/nginx/vault-config-backups

[ -f "$LIVE" ] || { echo "No live config at $LIVE"; exit 1; }

merged() {
  # 1) the zone after the existing vault_api zone; 2) the location before every "location /api/ {"
  #    (the HTTP block only redirects after Certbot, so a copy there is harmless)
  awk '
    /^limit_req_zone .*zone=vault_api:/ && !zone { print; print "limit_req_zone $binary_remote_addr zone=vault_voice:10m rate=240r/m;"; zone = 1; next }
    /^[[:space:]]*location \/api\/ \{/ {
      print "    # voice note uploads (server/src/voice.js): 512 KB pieces, so a bigger body and a longer timeout here only"
      print "    location ^~ /api/voice {"
      print "        client_max_body_size 1m;"
      print "        client_body_timeout 60s;"
      print "        limit_req zone=vault_voice burst=120 nodelay;"
      print "        proxy_pass http://127.0.0.1:8092;"
      print "        proxy_set_header Host $host;"
      print "        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"
      print "        proxy_set_header X-Forwarded-Proto $scheme;"
      print "    }"
      loc = 1
    }
    { print }
    END { if (!zone || !loc) exit 3 }
  ' "$LIVE"
}

# The first version used "location ^~ /api/voice/" (trailing slash). Nginx then answers the bare /api/voice
# (start a note, list notes) with a 301 to /api/voice/, which the app doesn't have: "Not found". Upgrade it.
OLD_LOC='location ^~ /api/voice/ {'
if grep -qF "$OLD_LOC" "$LIVE"; then
  merged() { sed 's#location ^~ /api/voice/ {#location ^~ /api/voice {#' "$LIVE"; }
elif grep -q 'zone=vault_voice' "$LIVE"; then
  echo "Already applied; nothing to do."; exit 0
fi

if [ "$1" = "--preview" ]; then
  TMP=$(mktemp)
  merged > "$TMP" || { echo "Could not find the vault_api zone or the /api/ location in $LIVE. Nothing changed."; rm -f "$TMP"; exit 1; }
  diff -u "$LIVE" "$TMP" || true
  rm -f "$TMP"
  exit 0
fi

[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo sh $0"; exit 1; }
TMP=$(mktemp)
merged > "$TMP" || { echo "Could not find the vault_api zone or the /api/ location in $LIVE. Nothing changed."; rm -f "$TMP"; exit 1; }
mkdir -p "$BACKUPS"
COPY="$BACKUPS/vault.example.com.$(date +%Y%m%d-%H%M%S)"
cp -p "$LIVE" "$COPY"
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
