#!/bin/sh
# One-time: publish Tweet Vault at https://vault.example.com (run with sudo, after the DNS record works).
set -e
if ! getent hosts vault.example.com >/dev/null; then
  echo "vault.example.com does not resolve yet. Add the DNS A record first, wait a few minutes, then rerun."
  exit 1
fi
cp /home/user/tweet-vault/nginx-vault.conf /etc/nginx/sites-available/vault.example.com
ln -sf /etc/nginx/sites-available/vault.example.com /etc/nginx/sites-enabled/vault.example.com
nginx -t
systemctl reload nginx
certbot --nginx -d vault.example.com --redirect --non-interactive --keep-until-expiring
echo "Done: https://vault.example.com"
