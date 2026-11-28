import type { Server } from 'node:http';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { http, passthrough } from 'msw';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server as msw } from '../../../../test/msw.setup.ts';
import { drain, listen } from '../../src/api/server.ts';
import { SESSION_COOKIE } from '../../src/auth/session.ts';
import { SITE } from '../api/me-app.ts';
import { jpeg, openUploads, sha256Hex, type UploadsFixture } from './fixtures.ts';

// The chunk route over a real socket (P3b, the Hono gotcha in CLAUDE.md): `app.request()` bypasses
// @hono/node-server, whose request object is not an undici Request (`overrideGlobalObjects: false`), so the
// streamed body (`c.req.raw.body`) needs its own proof: a whole chunk is written, and a client that breaks off
// mid-body leaves the chunk unreceived and the upload's lock free for the re-send.

let f: UploadsFixture;
let server: Server;
let port = 0;

beforeAll(async () => {
  f = await openUploads();
  server = await listen(f.t.app, 0, '127.0.0.1');
  port = (server.address() as AddressInfo).port;
}, 180_000);
afterAll(async () => {
  if (server !== undefined) await drain(server, 1_000);
  await f?.close();
});
beforeEach(() => {
  msw.use(http.all(/^http:\/\/127\.0\.0\.1:\d+\//, () => passthrough()));
});

/** PUT a chunk over its own connection; with `abortAfter`, send that many bytes, then destroy the socket. */
function putChunk(token: string, path: string, body: Buffer, abortAfter?: number): Promise<number | 'aborted'> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: `/api/v1${path}`,
        agent: false,
        headers: {
          host: SITE.domain,
          'sec-fetch-site': 'same-origin',
          cookie: `${SESSION_COOKIE}=${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(body.length),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', (err) => (abortAfter === undefined ? reject(err) : resolve('aborted')));
    if (abortAfter === undefined) {
      req.end(body);
      return;
    }
    req.write(body.subarray(0, abortAfter), () => setTimeout(() => req.destroy(), 50));
  });
}

describe('PUT /uploads/:id/chunks/:n over a socket', () => {
  it('a client that breaks off mid-body leaves the chunk unreceived; the re-send is written', async () => {
    const u = await f.p.newMember();
    const token = await f.t.signIn(u.id);
    const bytes = await jpeg(200_000);
    const made = (await (
      await f.create(token, { museumId: (await f.p.visible(0)).id, size: bytes.length })
    ).json()) as {
      id: string;
    };
    const path = `/uploads/${made.id}/chunks/0`;
    expect(await putChunk(token, path, bytes, 50_000)).toBe('aborted');
    // The server notices the reset asynchronously; the chunk must never count as received.
    for (let i = 0; i < 20; i++) {
      const rows = await f.p.owner.query('SELECT 1 FROM media_chunk WHERE media_id = $1', [made.id]);
      expect(rows.rowCount).toBe(0);
      await sleep(25);
    }
    let status: number | 'aborted' = 409;
    for (let i = 0; i < 40 && status === 409; i++) {
      status = await putChunk(token, path, bytes);
      if (status === 409) await sleep(50);
    }
    expect(status).toBe(204);
    expect((await f.complete(token, made.id, sha256Hex(bytes))).status).toBe(202);
  });
});
