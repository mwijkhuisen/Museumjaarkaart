// CI only: Lettermint's stand-in (the `mailsink` service). The edge answers https://api.lettermint.co/v1/send
// and proxies it here, so the worker's real mailer (apps/server/src/mail/lettermint.ts) runs unchanged. It keeps
// { to, subject, text } in memory; the specs read the sign-in codes back with GET /messages?to=<address> (newest
// first; no `to`: all of them, which stack.sh uses to look for a code in the logs). Never logs a body or an address.
// Plain Node, no dependency.
import { createServer } from 'node:http';

const messages = [];
const MAX_BODY = 1_000_000;

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://sink');
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  if (req.method === 'GET' && url.pathname === '/messages') {
    const to = url.searchParams.get('to')?.toLowerCase();
    return reply(200, messages.filter((m) => to === undefined || m.to === to).reverse());
  }
  if (req.method !== 'POST' || url.pathname !== '/v1/send') return reply(404, { error: 'not_found' });
  if (!req.headers['x-lettermint-token']) {
    req.resume();
    return reply(401, { error: 'unauthorized' });
  }
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > MAX_BODY) req.destroy();
  });
  req.on('end', () => {
    try {
      const { to, subject, text } = JSON.parse(raw);
      for (const address of to) messages.push({ to: String(address).toLowerCase(), subject, text });
    } catch {
      return reply(422, { error: 'invalid' });
    }
    reply(202, { message_id: crypto.randomUUID(), status: 'pending' });
  });
}).listen(8025, '0.0.0.0');
