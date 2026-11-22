import { HttpResponse, http } from 'msw';
import { server } from '../../../../test/msw.setup.ts';

// A path-style S3 bucket in memory behind msw, for the tiles tests: PUT, GET, HEAD and DELETE of whole objects.
// `log` is the order of the calls (`PUT tiles/current.json`), `objects` what the bucket holds.

export type Stored = { body: Uint8Array; contentType: string; cacheControl: string };

export function fakeBucket(origin = 'https://r2.test', bucket = 'mjk-media') {
  const objects = new Map<string, Stored>();
  const log: string[] = [];
  server.use(
    http.all(`${origin}/${bucket}/*`, async ({ request }) => {
      const key = decodeURIComponent(new URL(request.url).pathname.slice(bucket.length + 2));
      log.push(`${request.method} ${key}`);
      const have = objects.get(key);
      switch (request.method) {
        case 'PUT': {
          objects.set(key, {
            body: new Uint8Array(await request.arrayBuffer()),
            contentType: request.headers.get('content-type') ?? '',
            cacheControl: request.headers.get('cache-control') ?? '',
          });
          return new HttpResponse(null, { headers: { etag: '"x"' } });
        }
        case 'GET':
          return have === undefined
            ? new HttpResponse('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
            : new HttpResponse(have.body);
        case 'HEAD':
          return have === undefined
            ? new HttpResponse(null, { status: 404 })
            : new HttpResponse(null, { headers: { 'content-length': String(have.body.byteLength), etag: '"x"' } });
        case 'DELETE':
          objects.delete(key);
          return new HttpResponse(null, { status: 204 });
        default:
          return new HttpResponse(null, { status: 405 });
      }
    }),
  );
  return {
    objects,
    log,
    put: (key: string, text: string) =>
      objects.set(key, { body: new TextEncoder().encode(text), contentType: '', cacheControl: '' }),
    current: () => {
      const c = objects.get('tiles/current.json');
      return c === undefined ? undefined : JSON.parse(new TextDecoder().decode(c.body));
    },
  };
}
