// P0 smoke page: proves the Playwright set-up, Paraglide and the strict CSP in Chromium and WebKit.
// P1c replaces it with the real SSR stack.
import { createServer } from 'node:http';
import { m } from '../src/paraglide/messages.js';

type Locale = 'nl' | 'en';

const host = process.env.E2E_HOST ?? '127.0.0.1';
const port = Number(process.env.E2E_PORT ?? '4173');

// A§15.6 without the `media.<domain>` hosts (img-src, media-src, connect-src): that host does not exist yet.
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "font-src 'self'",
  "manifest-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const baseHeaders = {
  'Content-Security-Policy': csp,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cache-Control': 'no-store',
};

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

// Messages are chosen by name, never by a computed key.
const page = (locale: Locale): string => {
  const title = escapeHtml(m.smoke_title({}, { locale }));
  const heading = escapeHtml(m.smoke_heading({}, { locale }));
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><script src="/smoke.js" defer></script></head><body><main><h1>${heading}</h1></main></body></html>`;
};

const server = createServer((req, res) => {
  const send = (status: number, type: string, body: string, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...baseHeaders, 'Content-Type': type, ...extra });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(405, 'text/plain; charset=utf-8', 'method not allowed', { Allow: 'GET, HEAD' });
    return;
  }
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path === '/') send(200, 'text/html; charset=utf-8', page('nl'));
  else if (path === '/en/') send(200, 'text/html; charset=utf-8', page('en'));
  else if (path === '/smoke.js')
    send(200, 'text/javascript; charset=utf-8', "document.documentElement.dataset.ready = '1';");
  else if (path === '/healthz') send(200, 'text/plain; charset=utf-8', 'ok');
  else send(404, 'text/plain; charset=utf-8', 'not found');
});

server.listen(port, host, () => {
  console.log(`smoke server listening on http://${host}:${port}`);
});
