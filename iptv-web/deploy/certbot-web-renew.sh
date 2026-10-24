#!/bin/bash
# Renew the Let's Encrypt certs kept in /home/harry/letsencrypt (issued with the
# dns-cloudflare plugin by the certbot/dns-cloudflare container) and copy the
# refreshed files into every openresty site that mirrors them.
set -u
LOG=/var/log/certbot-web-renew.log
if ! touch "$LOG" 2>/dev/null; then LOG=/tmp/certbot-web-renew.log; fi
DOMAINS="links.nafisainternational.com iptv.nafisainternational.com"

{
  echo "=== $(date -Is) begin ==="
  docker run --rm \
    -v /home/harry/letsencrypt:/etc/letsencrypt \
    -v /home/harry/letsencrypt-lib:/var/lib/letsencrypt \
    -v /home/harry/.secrets/cf.ini:/cf.ini:ro \
    certbot/dns-cloudflare renew --quiet --non-interactive
  rc=$?
  echo "certbot exit=$rc"

  changed=0
  for d in $DOMAINS; do
    src="/home/harry/letsencrypt/live/$d"
    dst="/opt/web/sites/$d/ssl"
    [ -f "$src/fullchain.pem" ] || continue
    [ -d "$dst" ] || continue
    if ! cmp -s "$src/fullchain.pem" "$dst/fullchain.pem" 2>/dev/null; then
      cp -L "$src/fullchain.pem" "$dst/fullchain.pem"
      cp -L "$src/privkey.pem" "$dst/privkey.pem"
      echo "deployed renewed cert for $d"
      changed=1
    else
      echo "no change for $d"
    fi
  done

  if [ "$changed" = "1" ]; then
    systemctl reload openresty && echo "openresty reloaded"
  fi
  echo "=== $(date -Is) done exit=$rc ==="
} >>"$LOG" 2>&1

exit $?
