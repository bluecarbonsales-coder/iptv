#!/bin/bash
# Runs ON nafisainternational.com.
# The links.* (Linkwarden) cert was issued with the certbot container's webroot
# authenticator pointing at /var/www/html, which no longer exists now that openresty
# is native — so its renewal already fails. Move it to the same DNS-01 path the new
# cert uses, then prove it with a dry run.
set -u
DOM="links.nafisainternational.com"
CONF="/home/harry/letsencrypt/renewal/$DOM.conf"

echo "##### 1. rewrite the renewal config to dns-cloudflare #####"
sudo -n cat "$CONF" > /tmp/links.conf
cp /tmp/links.conf /tmp/links.conf.bak

python3 - "$DOM" <<'PY'
import re, sys
dom = sys.argv[1]
p = '/tmp/links.conf'
txt = open(p).read()
head, _, params = txt.partition('[renewalparams]')
# stop at the first section after renewalparams (webroot_map) — dns-01 has no map
params = re.split(r'\n\[\[', params)[0]
keep = []
for line in params.strip().splitlines():
    if line.startswith(('authenticator', 'webroot_path', 'dns_cloudflare')):
        continue
    keep.append(line)
new = [l for l in keep if l.strip()]
out = head + '[renewalparams]\n' + '\n'.join(new) + '\n'
out += 'authenticator = dns-cloudflare\n'
out += 'dns_cloudflare_credentials = /cf.ini\n'
out += 'dns_cloudflare_propagation_seconds = 45\n'
out += '[acme_renewal_info]\nari_retry_after = 2026-10-22T00:41:14\n'
open('/tmp/links.new.conf', 'w').write(out)
print(out)
PY

sudo -n tee "$CONF" < /tmp/links.new.conf >/dev/null
sudo -n cat "$CONF" | head -20

echo
echo "##### 2. dry run for BOTH certs #####"
docker run --rm \
  -v /home/harry/letsencrypt:/etc/letsencrypt \
  -v /home/harry/letsencrypt-lib:/var/lib/letsencrypt \
  -v /home/harry/.secrets/cf.ini:/cf.ini:ro \
  certbot/dns-cloudflare renew --dry-run --non-interactive 2>&1 | tail -12

echo
echo "##### 3. real renewal pass (no-op unless due) #####"
/usr/local/bin/certbot-web-renew.sh; echo "rc=$?"
tail -6 /var/log/certbot-web-renew.log

echo
echo "##### 4. both sites still serving? #####"
for d in links.nafisainternational.com iptv.nafisainternational.com; do
  curl -sk -m 15 --resolve $d:443:127.0.0.1 -o /dev/null -w "$d -> %{http_code}\n" https://$d/
done
