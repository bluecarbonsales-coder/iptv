'use strict';
// Tiny dependency-free router with :params and wildcard-free exact/prefix matching.
class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    this.routes.push({ method, parts, handler, prefix: pattern.endsWith('*') });
    return this;
  }

  get(p, h, opts) {
    return this.add('GET', p, h, opts);
  }

  head(p, h) {
    this.add('GET', p, h);
    return this.add('HEAD', p, h);
  }

  post(p, h) {
    return this.add('POST', p, h);
  }

  patch(p, h) {
    return this.add('PATCH', p, h);
  }

  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  use(handler) {
    this.routes.push({ method: '*', parts: null, handler, prefix: true });
    return this;
  }

  match(method, pathname) {
    const urlParts = pathname.split('/').filter(Boolean);
    for (const r of this.routes) {
      if (r.parts === null) return { handler: r.handler, params: {} };
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      if (r.parts.length !== urlParts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(urlParts[i]);
        else if (p !== urlParts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: r.handler, params };
    }
    return null;
  }

  async handle(req, res, next) {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      pathname = req.url.split('?')[0];
    }
    const m = this.match(req.method, pathname);
    if (!m) return next ? next() : false;
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    await m.handler(req, res, m.params, query);
    return true;
  }
}

module.exports = { Router };
