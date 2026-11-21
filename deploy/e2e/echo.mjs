// CI only (deploy/e2e/caddy-cases.yaml): stands in for `api` or `ssr` behind the real Caddyfile and answers
// every request with what reached it: the upstream's name, the TCP peer, the method, the URL and the
// headers. `?status=<n>` picks the status, so a case can see Caddy's handling of an upstream 404.
// ECHO_NAME and ECHO_PORT come from the compose override. Nothing here is logged.
import { createServer } from 'node:http';

const name = process.env.ECHO_NAME ?? 'echo';
const port = Number(process.env.ECHO_PORT ?? '8080');

const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const url = new URL(req.url ?? '/', 'http://echo');
    const status = Number(url.searchParams.get('status') ?? '200');
    const body = JSON.stringify({
      echo: name,
      peer: req.socket.remoteAddress,
      method: req.method,
      url: req.url,
      headers: req.headers,
    });
    res.writeHead(Number.isInteger(status) && status >= 200 && status <= 599 ? status : 200, {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
    });
    res.end(body);
  });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.listen(port, '0.0.0.0');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
