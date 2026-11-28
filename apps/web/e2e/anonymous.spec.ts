import { expect, test } from './fixtures.ts';
import { normalMuseum } from './helpers.ts';

// Criterion 5 (A§15.1, invariant 8): `ssr` never sees a session, so the bytes do not depend on the
// request's credentials, and a page sets no cookie. Through Caddy, which deletes Cookie and Authorization.
test('a page is the same for an anonymous and a credentialed request', async ({ request }) => {
  const museum = await normalMuseum(request);
  const sid = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const credentials = { Cookie: `__Host-mjk_sid=${sid}; other=1`, Authorization: 'Bearer x' };
  for (const path of ['/', '/musea', `/musea/${museum.slug}`, '/does-not-exist']) {
    // Other specs write reviews meanwhile, and each write moves the rank order of /musea (stats_recompute): the
    // credentialed request is compared only with an anonymous answer that did not change around it.
    let compared = false;
    for (let attempt = 0; attempt < 5 && !compared; attempt++) {
      const plain = await request.get(path);
      const withCreds = await request.get(path, { headers: credentials });
      const after = await request.get(path);
      expect(plain.headers()['set-cookie'], path).toBeUndefined();
      expect(withCreds.headers()['set-cookie'], path).toBeUndefined();
      if (!(await plain.body()).equals(await after.body())) continue;
      expect(withCreds.status(), path).toBe(plain.status());
      expect((await withCreds.body()).equals(await plain.body()), `${path}: same bytes`).toBe(true);
      compared = true;
    }
    expect(compared, `${path}: an anonymous answer that held still for one credentialed request`).toBe(true);
  }
});
