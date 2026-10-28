'use strict';
// Address-family preference for outbound requests.
//
// The container has no IPv6 route (Docker's default bridge is IPv4-only) while the host does,
// and for dual-stack origins Node's happy-eyeballs does not fall back reliably: it reports
// `fetch failed` / ETIMEDOUT in ~300 ms for hosts whose AAAA is unreachable, even though the
// same request over IPv4 succeeds. That killed the radio directory (radio-browser.info is
// dual-stack) and any stream origin in the same shape.
//
// With no usable IPv6 interface, pinning the DNS result order to IPv4 and turning the
// "try every address" selection off makes the first (IPv4) address the one that is used.
// On a host that does have IPv6, nothing is changed: happy-eyeballs keeps working there.
const dns = require('dns');
const net = require('net');
const os = require('os');

function hasGlobalIPv6() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list || []) {
      if (!iface || iface.internal) continue;
      if (iface.family !== 'IPv6' && iface.family !== 6) continue;
      if (/^fe80:/i.test(iface.address)) continue; // link-local only
      if (/^::1$/.test(iface.address)) continue;
      return true;
    }
  }
  return false;
}

function applyNetworkPreferences(options = {}) {
  const ipv6 = options.hasIPv6 === undefined ? hasGlobalIPv6() : Boolean(options.hasIPv6);
  if (ipv6) return { changed: false, hasIPv6: true, reason: 'host has a global IPv6 address' };
  try {
    dns.setDefaultResultOrder('ipv4first');
    net.setDefaultAutoSelectFamily(false);
    return { changed: true, hasIPv6: false, reason: 'no global IPv6 interface: preferring IPv4' };
  } catch (error) {
    return { changed: false, hasIPv6: false, reason: String((error && error.message) || error) };
  }
}

module.exports = { applyNetworkPreferences, hasGlobalIPv6 };
