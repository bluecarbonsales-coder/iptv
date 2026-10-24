#!/bin/bash
# Runs ON nafisainternational.com: creates the Cloudflare records and issues the TLS cert.
set -u
CF_TOKEN="${CF_TOKEN:?set CF_TOKEN}"
ZONE="df3a6547b923ae163c17ba2f398cf981"
DOM="iptv.nafisainternational.com"
EMAIL="admin@mail.nafisainternational.com"
AUTH=(-H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json")

echo "##### 1. DNS records (DNS-only, direct to origin) #####"
for rec in "{\"type\":\"A\",\"name\":\"iptv\",\"content\":\"45.142.166.65\",\"ttl\":1,\"proxied\":false,\"comment\":\"iptv-web\"}" \
           "{\"type\":\"AAAA\",\"name\":\"iptv\",\"content\":\"2403:71c0:2000:1955::b\",\"ttl\":1,\"proxied\":false,\"comment\":\"iptv-web\"}"; do
  curl -s --max-time 25 -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/dns_records" "${AUTH[@]}" -d "$rec" \
    | python3 -c "import sys,json;d=json.load(sys.stdin);r=d.get('result') or {};print(' ',('OK  '+r.get('type','')+' '+str(r.get('name'))+' -> '+str(r.get('content'))) if d.get('success') else ('FAIL '+str(d.get('errors'))))"
done

echo
echo "##### 2. TLS certificate (DNS-01, so it works regardless of proxy state) #####"
CRED=/home/harry/.secrets/cf.ini
mkdir -p /home/harry/.secrets
printf 'dns_cloudflare_api_token = %s\n' "$CF_TOKEN" > "$CRED"
chmod 600 "$CRED"

docker run --rm \
  -v /home/harry/letsencrypt:/etc/letsencrypt \
  -v /home/harry/letsencrypt-lib:/var/lib/letsencrypt \
  -v "$CRED":/cf.ini:ro \
  certbot/dns-cloudflare certonly \
  --dns-cloudflare --dns-cloudflare-credentials /cf.ini \
  --dns-cloudflare-propagation-seconds 45 \
  -d "$DOM" --email "$EMAIL" --agree-tos --no-eff-email --non-interactive \
  --cert-name "$DOM" 2>&1 | tail -18

echo
echo "##### 3. certificate on disk? #####"
sudo -n cat /home/harry/letsencrypt/live/$DOM/fullchain.pem 2>/dev/null | openssl x509 -noout -subject -dates -ext subjectAltName 2>&1 | head -5
