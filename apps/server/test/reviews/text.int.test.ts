import { isReviewText, OwnReview, PublicReview } from '@mjk/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openPassportDb, type PassportDb } from '../passport/fixtures.ts';
import { memberWithVisit, openMuseum, reviewsApp } from './app.ts';

// P3a WP3 (the Text section of the plan): one rule for a review body, two places that enforce it, and the
// proof that they agree. The zod side is `isReviewText` (packages/contracts), the database side the CHECK on
// review.body. Also: the text goes through the api and out again byte for byte, and one that breaks the rule is
// a 422 naming `body`.

let p: PassportDb;
let t: ReturnType<typeof reviewsApp>;
beforeAll(async () => {
  p = await openPassportDb();
  t = reviewsApp(p);
}, 120_000);
afterAll(async () => {
  await p?.close();
});

const CHECK_VIOLATION = '23514';

/** Whether the database CHECK accepts `body`, by an INSERT as mjk_api that is always rolled back. */
async function checkAccepts(bodies: string[]): Promise<boolean[]> {
  const museum = await openMuseum(p, 500);
  const u = await p.newMember();
  const visitId = await p.addVisit(u.id, museum.id);
  const client = await p.pools.api.connect();
  try {
    await client.query('BEGIN');
    const out: boolean[] = [];
    for (const body of bodies) {
      await client.query('SAVEPOINT s');
      try {
        await client.query(
          'INSERT INTO review (user_id, museum_id, visit_id, rating, body) VALUES ($1, $2, $3, 3, $4)',
          [u.id, museum.id, visitId, body],
        );
        out.push(true);
      } catch (err) {
        const code = (err as { code?: string }).code;
        // U+0000 never reaches the CHECK: PostgreSQL text cannot hold it (22021, refused at the protocol).
        if (code !== CHECK_VIOLATION && !body.includes('\u0000')) throw err;
        out.push(false);
      }
      await client.query('ROLLBACK TO SAVEPOINT s');
    }
    await client.query('ROLLBACK');
    return out;
  } finally {
    client.release();
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const EMOJI = [
  '\u{1F600}',
  '\u{1F44D}\u{1F3FD}',
  '\u{1F1F3}\u{1F1F1}',
  '\u{2764}\u{FE0F}',
  '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}',
  '\u{1F9D1}\u{200D}\u{1F3A8}',
  '\u{1F3DB}\u{FE0F}',
  '\u{E0001}',
  '\u{10FFFF}',
  '\u{FEFF}',
  '\u{FFFD}',
];

describe('zod (isReviewText) and the database CHECK agree', () => {
  it('on every code point in U+0000–U+00A0 and U+2000–U+206F, and on a set of emoji', async () => {
    const cps = [...range(0, 0xa0), ...range(0x2000, 0x206f)].map((cp) => String.fromCodePoint(cp));
    const samples = [...cps, ...EMOJI, '\u{2028}', '\u{2029}', '\u{202A}', '\u{202E}', '\u{2066}', '\u{2069}'];
    const texts = samples.map((s) => `a${s}b`);
    const db = await checkAccepts(texts);
    const wrong = texts.filter((s, i) => isReviewText(s) !== db[i]).map((s) => s.codePointAt(1)?.toString(16));
    expect(wrong, 'code points where zod and the CHECK disagree').toEqual([]);
    // The rule is not vacuous: the controls, the separators and the bidi controls are refused, the rest accepted.
    expect(isReviewText('a\u0000b')).toBe(false);
    expect(db[0]).toBe(false); // U+0000: refused by both
    for (const cp of [0x01, 0x09, 0x0b, 0x0d, 0x1f, 0x7f, 0x85, 0x9f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069])
      expect(isReviewText(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(false);
    for (const cp of [0x0a, 0x20, 0xa0, 0x2000, 0x200d, 0x200f, 0x2060, 0x206f])
      expect(isReviewText(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(true);
    for (const e of EMOJI) expect(isReviewText(`a${e}b`), e).toBe(true);
  });

  it('on the length: 5,000 astral code points pass, 5,001 fail, at both', async () => {
    const [ok, over] = await checkAccepts(['😀'.repeat(5000), '😀'.repeat(5001)]);
    expect(ok).toBe(true);
    expect(over).toBe(false);
    expect(isReviewText('😀'.repeat(5000))).toBe(true);
    expect(isReviewText('😀'.repeat(5001))).toBe(false);
    expect(isReviewText('')).toBe(false);
  });
});

describe('at the api', () => {
  const post = (u: { token: string }, museumId: string, visitId: string, body: unknown) =>
    t.call('/reviews', { token: u.token, body: { museum_id: museumId, visit_id: visitId, rating: 3, body } });

  it('5,000 astral code points are a 201 and read back whole; 5,001 are a 422 naming body, on POST and PATCH', async () => {
    const m = await openMuseum(p, 510);
    const u = await memberWithVisit(p, t, m.id);
    const over = await post(u, m.id, u.visitId, '😀'.repeat(5001));
    expect([over.status, await over.json()]).toEqual([422, { error: 'invalid', fields: ['body'] }]);
    expect((await p.admin.query('SELECT 1 FROM review WHERE user_id = $1', [u.id])).rowCount).toBe(0);

    const ok = await post(u, m.id, u.visitId, '😀'.repeat(5000));
    expect(ok.status).toBe(201);
    const own = OwnReview.parse(await ok.json());
    expect(own.body).toBe('😀'.repeat(5000));
    const read = PublicReview.parse(await (await t.call(`/reviews/${own.id}`)).json());
    expect(read.body).toBe('😀'.repeat(5000));

    const patched = await t.call(`/reviews/${own.id}`, {
      method: 'PATCH',
      token: u.token,
      body: { body: '😀'.repeat(5001) },
    });
    expect([patched.status, await patched.json()]).toEqual([422, { error: 'invalid', fields: ['body'] }]);
    expect((await p.admin.query('SELECT char_length(body) AS n FROM review WHERE id = $1', [own.id])).rows[0]?.n).toBe(
      5000,
    );
  });

  it('a control or bidi character is a 422 naming body; a tab and CRLF are normalised, not refused', async () => {
    const m = await openMuseum(p, 511);
    const u = await memberWithVisit(p, t, m.id);
    for (const bad of ['a\u{1}b', 'a\u{7F}b', 'a\u{85}b', 'a\u{202E}b', 'a\u{2066}b', 'a\u{200E}b\u{202A}c']) {
      const r = await post(u, m.id, u.visitId, bad);
      expect([r.status, await r.json()], JSON.stringify(bad)).toEqual([422, { error: 'invalid', fields: ['body'] }]);
    }
    // U+0000 cannot be sent as JSON text that survives: the escape is a 422 too, and nothing reaches SQL.
    const nul = await t.call('/reviews', {
      token: u.token,
      raw: `{"museum_id":"${m.id}","visit_id":"${u.visitId}","rating":3,"body":"a\\u0000b"}`,
    });
    expect([nul.status, await nul.json()]).toEqual([422, { error: 'invalid', fields: ['body'] }]);
    expect((await p.admin.query('SELECT 1 FROM review WHERE user_id = $1', [u.id])).rowCount).toBe(0);
    const ok = await post(u, m.id, u.visitId, 'a\tb\r\nc\u{2028}d');
    expect(OwnReview.parse(await ok.json()).body).toBe('a b\nc\nd');
  });

  it('hostile strings round-trip byte for byte through POST and GET (as api and as ssr)', async () => {
    const m = await openMuseum(p, 512);
    const hostile = [
      '</script>',
      '<b>x</b>',
      '[x](y)',
      'één\nregel twee',
      '😀 &amp; <img src=x onerror=alert(1)>',
      '"quote" \\ back',
    ];
    const ids: string[] = [];
    for (const text of hostile) {
      const u = await memberWithVisit(p, t, m.id);
      const r = await post(u, m.id, u.visitId, text);
      expect(r.status, text).toBe(201);
      const own = OwnReview.parse(await r.json());
      expect(own.body, text).toBe(text);
      ids.push(own.id);
    }
    const list = await t.call(`/museums/${m.slug}/reviews?limit=50`);
    const items = (await list.json()) as { items: { id: string; body: string }[] };
    for (const [i, text] of hostile.entries()) {
      for (const get of [t.call, (path: string) => t.ssrGet(path)]) {
        const one = PublicReview.parse(await (await get(`/reviews/${ids[i]}`)).json());
        expect(Buffer.from(one.body ?? '').equals(Buffer.from(text)), text).toBe(true);
      }
      expect(items.items.find((x) => x.id === ids[i])?.body).toBe(text);
      // The stored text is the text: no escaping on the way in.
      expect((await p.admin.query('SELECT body FROM review WHERE id = $1', [ids[i]])).rows[0]?.body).toBe(text);
    }
  });
});
