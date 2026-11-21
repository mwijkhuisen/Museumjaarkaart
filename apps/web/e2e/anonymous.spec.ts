import { expect, test } from './fixtures.ts';
import { normalMuseum } from './helpers.ts';

// Criterion 5 (A§15.1, invariant 8): `ssr` never sees a session, so the bytes do not depend on the
// request's credentials, and a page sets no cookie. Through Caddy, which deletes Cookie and Authorization.
test('a page is the same for an anonymous and a credentialed request', async ({ request }) => {
  const museum = await normalMuseum(request);
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const credentials = { Cookie: `__Host-mjk_sid=${sid}; other=1`, Authorization: 'Bearer x' };
  for (const path of ['/', '/musea', `/musea/${museum.slug}`, '/does-not-exist']) {
    const plain = await request.get(path);
    const withCreds = await request.get(path, { headers: credentials });
    expect(withCreds.status(), path).toBe(plain.status());
    expect((await withCreds.body()).equals(await plain.body()), `${path}: same bytes`).toBe(true);
    expect(plain.headers()['set-cookie'], path).toBeUndefined();
    expect(withCreds.headers()['set-cookie'], path).toBeUndefined();
  }
});
