#!/bin/bash
# Runs ON nafisainternational.com. Installs:
#   /usr/local/bin/certbot-web-renew.sh + certbot-web-renew.{service,timer}  (daily cert renewal + deploy)
#   iptv-refresh.{service,timer}                                             (daily iptv-org catalogue refresh)
set -u
HERE=$(mktemp -d)

echo "##### 1. renewal script #####"
cat > "$HERE/certbot-web-renew.sh" <<'EOS'
__RENEW__
EOS
chmod 755 "$HERE/certbot-web-renew.sh"
sudo -n cp "$HERE/certbot-web-renew.sh" /usr/local/bin/certbot-web-renew.sh
ls -la /usr/local/bin/certbot-web-renew.sh
mkdir -p /home/harry/.secrets && chmod 700 /home/harry/.secrets

echo
echo "##### 2. renewal units #####"
cat > "$HERE/certbot-web-renew.service" <<'EOS'
[Unit]
Description=Renew Let's Encrypt certs for openresty sites (dns-cloudflare)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/certbot-web-renew.sh
EOS

cat > "$HERE/certbot-web-renew.timer" <<'EOS'
[Unit]
Description=Daily certificate renewal check (03:20 + jitter)

[Timer]
OnCalendar=*-*-* 03:20:00
RandomizedDelaySec=3600
Persistent=true
Unit=certbot-web-renew.service

[Install]
WantedBy=timers.target
EOS

cat > "$HERE/iptv-refresh.service" <<'EOS'
[Unit]
Description=Refresh the IPTV Web catalogue from the iptv-org API
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
TimeoutStartSec=900
ExecStart=/usr/bin/curl -sS -m 880 -X POST http://127.0.0.1:3920/api/refresh
EOS

cat > "$HERE/iptv-refresh.timer" <<'EOS'
[Unit]
Description=Daily IPTV catalogue refresh (04:10 + jitter)

[Timer]
OnCalendar=*-*-* 04:10:00
RandomizedDelaySec=1800
Persistent=true
Unit=iptv-refresh.service

[Install]
WantedBy=timers.target
EOS

for u in certbot-web-renew.service certbot-web-renew.timer iptv-refresh.service iptv-refresh.timer; do
  sudo -n cp "$HERE/$u" /etc/systemd/system/$u
done
sudo -n systemctl daemon-reload
sudo -n systemctl enable --now certbot-web-renew.timer iptv-refresh.timer 2>&1 | tail -4

echo
echo "##### 3. timers installed #####"
systemctl list-timers certbot-web-renew.timer iptv-refresh.timer --no-pager 2>&1 | head -6

echo
echo "##### 4. prove the refresh service actually works #####"
sudo -n systemctl start iptv-refresh.service
sleep 3
systemctl status iptv-refresh.service --no-pager 2>&1 | head -4
echo "--- unit output ---"
journalctl -u iptv-refresh.service -n 4 --no-pager 2>&1 | tail -4

echo
echo "##### 5. prove the renewal path (dry run) #####"
docker run --rm \
  -v /home/harry/letsencrypt:/etc/letsencrypt \
  -v /home/harry/letsencrypt-lib:/var/lib/letsencrypt \
  -v /home/harry/.secrets/cf.ini:/cf.ini:ro \
  certbot/dns-cloudflare renew --dry-run --non-interactive 2>&1 | tail -12
