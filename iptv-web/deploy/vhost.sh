#!/bin/bash
# Runs ON nafisainternational.com: install the openresty vhost for iptv.nafisainternational.com.
set -u
DOM="iptv.nafisainternational.com"
SITE="/opt/web/sites/$DOM"
LE="/home/harry/letsencrypt/live/$DOM"

echo "##### 1. site skeleton (root-owned dirs via /tmp + sudo cp -r) #####"
rm -rf "/tmp/sitebuild/$DOM"
mkdir -p "/tmp/sitebuild/$DOM/ssl" "/tmp/sitebuild/$DOM/log" "/tmp/sitebuild/$DOM/proxy" "/tmp/sitebuild/$DOM/index"
chmod 755 "/tmp/sitebuild/$DOM" "/tmp/sitebuild/$DOM/ssl" "/tmp/sitebuild/$DOM/log" "/tmp/sitebuild/$DOM/proxy" "/tmp/sitebuild/$DOM/index"
if [ ! -d "$SITE" ]; then
  sudo -n cp -r "/tmp/sitebuild/$DOM" /opt/web/sites/
fi
sudo -n mkdir -p "$SITE/ssl" 2>/dev/null || true
ls -ld "$SITE" "$SITE"/* 2>/dev/null

echo
echo "##### 2. certificate -> site ssl dir #####"
if [ ! -f "$SITE/ssl/fullchain.pem" ]; then
  sudo -n cp -L "$LE/fullchain.pem" "$SITE/ssl/fullchain.pem"
  sudo -n cp -L "$LE/privkey.pem" "$SITE/ssl/privkey.pem"
fi
sudo -n cat "$SITE/ssl/fullchain.pem" 2>/dev/null | openssl x509 -noout -subject -dates | head -3

echo
echo "##### 3. vhost #####"
cat > "/tmp/$DOM.conf" <<CONF
server {
    listen 80;
    listen [::]:80;
    server_name $DOM;

    access_log $SITE/log/access.log main;
    error_log  $SITE/log/error.log;

    location ^~ /.well-known/acme-challenge { allow all; root /usr/share/nginx/html; }

    location ^~ / {
        if (\$scheme = http) { return 301 https://\$host\$request_uri; }
        proxy_pass http://127.0.0.1:3920;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$http_connection;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        client_max_body_size 20m;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name $DOM;

    access_log $SITE/log/access.log main;
    error_log  $SITE/log/error.log;

    ssl_certificate     $SITE/ssl/fullchain.pem;
    ssl_certificate_key $SITE/ssl/privkey.pem;
    ssl_protocols TLSv1.3 TLSv1.2;
    ssl_ciphers ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 10m;
    add_header Strict-Transport-Security "max-age=31536000";

    location ~ ^/(\.user.ini|\.htaccess|\.git|\.env|\.svn|\.project|LICENSE|README.md) { return 404; }
    location ^~ /.well-known/acme-challenge { allow all; root /usr/share/nginx/html; }

    location ^~ / {
        proxy_pass http://127.0.0.1:3920;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-Host \$host;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$http_connection;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        # video segments must stream, not queue up in nginx buffers
        proxy_buffering off;
        proxy_request_buffering off;
        client_max_body_size 20m;
    }
}
CONF

cp "/tmp/$DOM.conf" "/opt/web/conf.d/$DOM.conf"
ls -la "/opt/web/conf.d/$DOM.conf"

echo
echo "##### 4. reload openresty #####"
sudo -n systemctl reload openresty && echo "reload issued"
sleep 2
systemctl is-active openresty
echo "--- error log tail ---"
sudo -n cat "$SITE/log/error.log" 2>/dev/null | tail -5

echo
echo "##### 5. local check through openresty #####"
curl -sk -m 15 -o /dev/null -w "https://127.0.0.1/ (Host: $DOM)  -> %{http_code}\n" -H "Host: $DOM" https://127.0.0.1/
curl -sk -m 15 -H "Host: $DOM" https://127.0.0.1/healthz
echo
curl -sk -m 15 -o /dev/null -w "http -> %{http_code} redirect=%{redirect_url}\n" -H "Host: $DOM" http://127.0.0.1/
curl -sk -m 15 -H "Host: $DOM" https://127.0.0.1/js/i18n.js -o /dev/null -w "static /js/i18n.js -> %{http_code} %{content_type}\n"
