import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { categoriesOf } from '../../src/museums/categories.ts';
import { DEFAULT_PLAN_CONFIG } from '../../src/museums/diff.ts';
import { type Fetchers, type FetchResult, runSync, type SyncConfig } from '../../src/museums/sync.ts';
import { type Harness, openHarness } from '../admin/harness.ts';
import { has, parts, week2 } from '../fixtures/museums/week2.ts';

// The match and change queues (plan §2.4, §2.6): a real queue from the seed plus one week of news,
// worked through the admin CLI as mjk_api, and the sync run again to prove it keeps the decisions.

const FIXTURES = fileURLToPath(new URL('../fixtures/museums/', import.meta.url));
const read = (source: 'wikidata' | 'rce', name: string): unknown =>
  JSON.parse(readFileSync(`${FIXTURES}${source}/${name}.json`, 'utf8'));

type SparqlAnswer = Parameters<typeof week2>[0];
type Binding = SparqlAnswer['results']['bindings'][number];
const normalWikidata = read('wikidata', 'normal') as SparqlAnswer;
const normalRce = read('rce', 'normal') as { features: unknown[] };

const ok = (body: unknown): FetchResult => ({ ok: true, body, ms: 7 });
const serve = (wikidata: unknown, rce: unknown): Fetchers => ({
  wikidata: async () => ok(wikidata),
  rce: async () => ok(rce),
});
const CFG: SyncConfig = {
  floors: { wikidata: 10, rce: 10 },
  minShare: 0.9,
  maxInvalidShare: 0.02,
  plan: DEFAULT_PLAN_CONFIG,
};

const ENTITY = 'http://www.wikidata.org/entity/';
const literal = (value: string) => ({ type: 'literal', value });
const qidOf = (b: Binding) => (b.item?.value ?? '').slice(ENTITY.length);

// The news of the week, plus two things week2 does not have: an item that shares a name with a museum
// we hold (for a unique slug, and with aliases), and a changed class (a categories change waits).
const { answer: base, picks } = week2(normalWikidata);
const usedQids = new Set(Object.values(picks));
const live = (b: Binding) => !has(b, 'dissolved');
const sameName = base.results.bindings.find((b) => (b.labelNl?.value ?? '') !== '' && live(b)) as Binding;
// One whose categories really change when its classes become "art museum" (Q207694 maps to art).
const categoriesNow = (b: Binding) => categoriesOf(parts(b, 'classes').map((uri) => uri.slice(ENTITY.length)));
const reclassified = base.results.bindings.find(
  (b) => b !== sameName && !usedQids.has(qidOf(b)) && live(b) && categoriesNow(b).join() !== 'art',
) as Binding;
const DUP_QID = 'Q99000997';
// Real data has no RCE row with two candidates in a 60-item sample, so the file adds one: two museums
// at one postcode with close names, and an RCE row that names both (rule 2 finds two: ambiguous).
const twin = (qid: string, name: string, lon: number) => ({
  item: { type: 'uri', value: `${ENTITY}${qid}` },
  labelNl: { type: 'literal', 'xml:lang': 'nl', value: name },
  postcodes: literal('1011 ZZ'),
  coords: literal(`Point(${lon} 52.90000)`),
  classes: literal(`${ENTITY}Q33506`),
});
const TWINS = [twin('Q99000995', 'Tweelingmuseum Noord', 6.0), twin('Q99000996', 'Tweelingmuseum Zuid', 6.1)];
const TWIN_RCE = 'overzichtmusea.990001';
const servedRce = {
  ...normalRce,
  features: [
    ...normalRce.features,
    {
      type: 'Feature',
      id: TWIN_RCE,
      geometry: { type: 'Point', coordinates: [6.5, 52.5] },
      properties: {
        Museum: 'Tweelingmuseum',
        Adres: 'Tweelingstraat',
        Huisnummer: '1',
        Pc6: '1011ZZ',
        Woonplaats: 'Ergens',
        Gemeente: 'Ergens',
      },
    },
  ],
};
const seedWikidata: SparqlAnswer = {
  ...normalWikidata,
  results: { bindings: [...normalWikidata.results.bindings, ...TWINS] },
};
const answer: SparqlAnswer = {
  head: base.head,
  results: {
    bindings: [
      ...TWINS,
      ...base.results.bindings.map((b) => (b === reclassified ? { ...b, classes: literal(`${ENTITY}Q207694`) } : b)),
      {
        item: { type: 'uri', value: `${ENTITY}${DUP_QID}` },
        labelNl: sameName.labelNl as Binding[string],
        aliases: literal('Oude Naam\u001FTweede Naam'),
        coords: literal('Point(5.50000 51.00000)'),
        classes: literal(`${ENTITY}Q33506`),
      },
    ],
  },
};

let h: Harness;
/** Five RCE rows that match nothing after the seed (set in beforeAll). */
let QUEUED: [string, string, string, string, string] = ['', '', '', '', ''];
let worker: Db;
let owner: pg.Client;

const rows = async <T extends pg.QueryResultRow>(text: string, values: unknown[] = []) =>
  (await h.api.query<T>(text, values)).rows;
const sync = async () => {
  const r = await runSync(worker, serve(answer, servedRce), silentLogger, { mode: 'sync' }, CFG);
  expect(r.outcome).toBe('applied');
  return r;
};
const museumBy = async (qid: string) =>
  (
    await rows<{ id: string; slug: string; name: string }>(
      'SELECT id, slug, name FROM museum WHERE wikidata_qid = $1',
      [qid],
    )
  )[0];
const sourceRow = async (source: string, id: string) =>
  (
    await rows<{
      match_state: string;
      match_rule: string | null;
      match_reason: string | null;
      museum: string | null;
      v: string;
    }>(
      `SELECT match_state, match_rule, match_reason, matched_museum_id AS museum, xmin::text AS v
         FROM museum_source_row WHERE source = $1 AND external_id = $2`,
      [source, id],
    )
  )[0];
const pendingId = async (museumId: string, field: string) =>
  (
    await rows<{ id: string }>(
      "SELECT id FROM museum_change WHERE museum_id = $1 AND field = $2 AND state = 'pending'",
      [museumId, field],
    )
  )[0]?.id as string;
const changeRows = (museumId: string, field: string) =>
  rows<{ old: unknown; new: unknown; origin: string; state: string }>(
    'SELECT old, new, origin, state FROM museum_change WHERE museum_id = $1 AND field = $2 ORDER BY id',
    [museumId, field],
  );

beforeAll(async () => {
  h = await openHarness();
  const pool = createPool('mjk_worker', { DATABASE_URL: h.db.urls.mjk_worker }, { max: 3 });
  if (typeof pool === 'string') throw new Error(pool);
  worker = createDb(pool);
  owner = new pg.Client({ connectionString: h.db.urls.admin });
  await owner.connect();
  expect((await runSync(worker, serve(seedWikidata, servedRce), silentLogger, { mode: 'seed' }, CFG)).outcome).toBe(
    'applied',
  );
  await sync();
  // RCE rows that match nothing, for the resolve tests: looked up, since real ids carry no design.
  QUEUED = (
    await rows<{ external_id: string }>(
      `SELECT external_id FROM museum_source_row
        WHERE source = 'rce' AND match_state = 'new' AND match_reason = 'no_candidate' ORDER BY external_id LIMIT 5`,
    )
  ).map((x) => x.external_id) as typeof QUEUED;
  expect(QUEUED).toHaveLength(5);
});
afterAll(async () => {
  await owner?.end();
  await worker?.destroy();
  await h?.close();
});

describe('match list', () => {
  it('lists the queued rows in order, with reason, name, place and candidates', async () => {
    const r = await h.admin('match', 'list');
    expect(r.code).toBe(0);
    const ids = r.out.filter((l) => /^(wikidata|rce):/.test(l)).map((l) => l.split('  ')[0]);
    expect(ids).toEqual([...ids].sort());
    expect(ids).toContain(`wikidata:${picks.added}`);
    expect(ids).toContain(`wikidata:${DUP_QID}`);
    expect(ids).toContain(`rce:${QUEUED[0]}`);
    const line = r.out.find((l) => l.startsWith(`rce:${TWIN_RCE}  `));
    expect(line).toMatch(/ambiguous/);
    expect(line).toMatch(/candidates: \S+,\S+/);
    expect(r.out.at(-1)).toBe(`${ids.length} queued`);
  });

  it('--reason and --source filter', async () => {
    const conflict = await h.admin('match', 'list', '--reason', 'qid_conflict');
    expect(conflict.out).toHaveLength(2);
    expect(conflict.out[0]).toMatch(new RegExp(`^wikidata:${picks.mergedInto}  qid_conflict`));
    const rce = await h.admin('match', 'list', '--source', 'rce', '--reason', 'no_candidate');
    expect(rce.out.slice(0, -1).every((l) => l.startsWith('rce:'))).toBe(true);
    expect((await h.admin('match', 'list', '--reason', 'nonsense')).code).toBe(64);
  });
});

describe('match resolve', () => {
  let target: { id: string; slug: string };

  it('an RCE row onto a museum sets its rce_id; a second RCE row onto it is refused', async () => {
    target = (
      await rows<{ id: string; slug: string }>('SELECT id, slug FROM museum WHERE rce_id IS NULL ORDER BY slug LIMIT 1')
    )[0] as {
      id: string;
      slug: string;
    };
    const r = await h.admin('match', 'resolve', `rce:${QUEUED[0]}`, '--museum', target.slug);
    expect(r.code).toBe(0);
    expect(await rows('SELECT rce_id FROM museum WHERE id = $1', [target.id])).toEqual([{ rce_id: QUEUED[0] }]);
    expect(await sourceRow('rce', QUEUED[0])).toMatchObject({
      match_state: 'matched',
      match_rule: 'admin',
      match_reason: null,
      museum: target.id,
    });
    expect(await changeRows(target.id, 'rce_id')).toEqual([
      { old: null, new: QUEUED[0], origin: 'admin', state: 'applied' },
    ]);

    const again = await h.admin('match', 'resolve', `rce:${QUEUED[1]}`, '--museum', target.slug);
    expect(again.code).toBe(65);
    expect(again.err[0]).toBe('admin: rce_conflict');
    expect(await sourceRow('rce', QUEUED[1])).toMatchObject({ match_state: 'new' });
  });

  it('a row that is not queued is 65, an unknown row is 66', async () => {
    const done = await h.admin('match', 'resolve', `rce:${QUEUED[0]}`, '--ignore');
    expect([done.code, done.err[0]]).toEqual([65, 'admin: not_queued']);
    expect((await h.admin('match', 'resolve', 'rce:nope', '--ignore')).code).toBe(66);
    expect((await h.admin('match', 'resolve', 'wikidata:Q1', '--ignore')).code).toBe(66);
    expect((await h.admin('match', 'resolve', `rce:${QUEUED[1]}`, '--museum', 'no-such-museum')).code).toBe(66);
  });

  it('--ignore keeps the reason and records nothing; the next sync keeps the decision', async () => {
    const changes = Number((await rows<{ n: string }>('SELECT count(*) AS n FROM museum_change'))[0]?.n);
    const r = await h.admin('match', 'resolve', `rce:${QUEUED[2]}`, '--ignore');
    expect(r.code).toBe(0);
    expect(await sourceRow('rce', QUEUED[2])).toMatchObject({
      match_state: 'ignored',
      match_reason: 'no_candidate',
    });
    expect(Number((await rows<{ n: string }>('SELECT count(*) AS n FROM museum_change'))[0]?.n)).toBe(changes);
    const before = await sourceRow('rce', QUEUED[2]);
    const s = await sync();
    expect(await sourceRow('rce', QUEUED[2])).toEqual(before);
    expect((await h.admin('match', 'list')).out.some((l) => l.startsWith(`rce:${QUEUED[2]}  `))).toBe(false);
    expect(s.summary.counts?.ignored).toBeGreaterThanOrEqual(1);
  });

  it('--new from an RCE row creates a museum without a QID; a Wikidata row then links to it and sets the QID', async () => {
    const r = await h.admin('match', 'resolve', `rce:${QUEUED[3]}`, '--new');
    expect(r.code).toBe(0);
    const slug = r.out[0]?.split(' ').at(-1) as string;
    const created = (
      await rows<{ id: string; rce_id: string; wikidata_qid: string | null }>(
        'SELECT id, rce_id, wikidata_qid FROM museum WHERE slug = $1',
        [slug],
      )
    )[0] as { id: string; rce_id: string; wikidata_qid: string | null };
    expect(created).toMatchObject({ rce_id: QUEUED[3], wikidata_qid: null });
    expect(await changeRows(created.id, 'new_museum')).toEqual([
      { old: null, new: { source: 'rce', external_id: QUEUED[3] }, origin: 'admin', state: 'applied' },
    ]);
    expect(await sourceRow('rce', QUEUED[3])).toMatchObject({ match_state: 'matched', museum: created.id });

    const link = await h.admin('match', 'resolve', `wikidata:${picks.added}`, '--museum', slug);
    expect(link.code).toBe(0);
    expect(await rows('SELECT wikidata_qid FROM museum WHERE id = $1', [created.id])).toEqual([
      { wikidata_qid: picks.added },
    ]);
    expect(await changeRows(created.id, 'qid_link')).toEqual([
      { old: null, new: picks.added, origin: 'admin', state: 'applied' },
    ]);
  });

  it('a qid_conflict needs --replace-qid, which records old and new', async () => {
    const merged = (await museumBy(picks.mergedFrom)) as { id: string; slug: string };
    const refuse = await h.admin('match', 'resolve', `wikidata:${picks.mergedInto}`, '--museum', merged.slug);
    expect([refuse.code, refuse.err[0]]).toEqual([65, 'admin: qid_conflict']);
    expect(await museumBy(picks.mergedFrom)).toBeDefined();
    const go = await h.admin(
      'match',
      'resolve',
      `wikidata:${picks.mergedInto}`,
      '--museum',
      merged.slug,
      '--replace-qid',
    );
    expect(go.code).toBe(0);
    expect(await museumBy(picks.mergedInto)).toMatchObject({ id: merged.id });
    expect(await changeRows(merged.id, 'qid_link')).toEqual([
      { old: picks.mergedFrom, new: picks.mergedInto, origin: 'admin', state: 'applied' },
    ]);
  });

  it('--new from a Wikidata row gets a unique slug and its aliases, and the unique keys hold', async () => {
    const existing = (
      await rows<{ slug: string }>('SELECT slug FROM museum WHERE name = $1', [sameName.labelNl?.value])
    )[0]?.slug;
    expect(existing).toBeDefined();
    const r = await h.admin('match', 'resolve', `wikidata:${DUP_QID}`, '--new');
    expect(r.code).toBe(0);
    const m = (await museumBy(DUP_QID)) as { id: string; slug: string };
    expect(m.slug).not.toBe(existing);
    expect(m.slug.startsWith(existing as string)).toBe(true);
    expect(
      await rows<{ alias: string; source: string }>(
        'SELECT alias, source FROM museum_alias WHERE museum_id = $1 ORDER BY alias',
        [m.id],
      ),
    ).toEqual([
      { alias: 'Oude Naam', source: 'wikidata' },
      { alias: 'Tweede Naam', source: 'wikidata' },
    ]);
    expect(await changeRows(m.id, 'new_museum')).toHaveLength(1);
  });

  it('a payload that fails its schema is 65 bad_payload and writes nothing', async () => {
    await owner.query(
      'UPDATE museum_source_row SET payload = payload || \'{"postcode": "nonsense"}\' WHERE external_id = $1',
      [QUEUED[4]],
    );
    const before = await sourceRow('rce', QUEUED[4]);
    const r = await h.admin('match', 'resolve', `rce:${QUEUED[4]}`, '--new');
    expect([r.code, r.err[0]]).toEqual([65, 'admin: bad_payload']);
    expect(await sourceRow('rce', QUEUED[4])).toEqual(before);
  });
});

describe('change queue', () => {
  it('lists the pending changes, filtered by field and museum', async () => {
    const all = await h.admin('change', 'list');
    expect(all.code).toBe(0);
    const fields = new Set(all.out.slice(0, -1).map((l) => l.split('  ')[2]));
    for (const f of ['name', 'coordinates', 'commons_file', 'closed_on', 'presence', 'categories'])
      expect(fields.has(f)).toBe(true);
    const names = await h.admin('change', 'list', '--field', 'name');
    expect(names.out).toHaveLength(2);
    expect(names.out[0]).toMatch(/\{?"?.*->/);
    const renamed = (await museumBy(picks.renamed)) as { slug: string };
    expect((await h.admin('change', 'list', '--museum', renamed.slug)).out).toHaveLength(2);
  });

  it('apply writes a name, a coordinates move and categories; the next sync finds them unchanged', async () => {
    const renamed = (await museumBy(picks.renamed)) as { id: string; name: string };
    const moved = (await museumBy(picks.moved300)) as { id: string };
    const recl = (await museumBy(qidOf(reclassified))) as { id: string };
    const wantName = (
      await rows<{ new: string }>('SELECT new FROM museum_change WHERE id = $1', [await pendingId(renamed.id, 'name')])
    )[0]?.new;
    const wantPoint = (
      await rows<{ new: { lat: number; lon: number } }>('SELECT new FROM museum_change WHERE id = $1', [
        await pendingId(moved.id, 'coordinates'),
      ])
    )[0]?.new;

    for (const [m, f] of [
      [renamed, 'name'],
      [moved, 'coordinates'],
      [recl, 'categories'],
    ] as const) {
      const r = await h.admin('change', 'apply', await pendingId(m.id, f));
      expect(r.code).toBe(0);
    }
    expect(await rows('SELECT name FROM museum WHERE id = $1', [renamed.id])).toEqual([{ name: wantName }]);
    expect(await rows('SELECT lat, lon FROM museum WHERE id = $1', [moved.id])).toEqual([wantPoint]);
    expect(await rows('SELECT categories FROM museum WHERE id = $1', [recl.id])).toEqual([{ categories: ['art'] }]);
    for (const [m, f] of [
      [renamed, 'name'],
      [moved, 'coordinates'],
      [recl, 'categories'],
    ] as const) {
      const done = await changeRows(m.id, f);
      expect(done.at(-1)).toMatchObject({ state: 'applied' });
    }
    expect(
      await rows(
        `SELECT count(*)::int AS n FROM museum_change
          WHERE state = 'applied' AND decided_at IS NOT NULL AND decided_by IS NULL
            AND museum_id = ANY($1::uuid[]) AND field IN ('name', 'coordinates', 'categories')`,
        [[renamed.id, moved.id, recl.id]],
      ),
    ).toEqual([{ n: 3 }]);

    await sync();
    // Other museums may get news (the one linked to a Wikidata row has a new name to consider); these three do not.
    expect(
      await rows(
        `SELECT count(*)::int AS n FROM museum_change
          WHERE state = 'pending' AND museum_id = ANY($1::uuid[]) AND field IN ('name', 'coordinates', 'categories')`,
        [[renamed.id, moved.id, recl.id]],
      ),
    ).toEqual([{ n: 0 }]);
  });

  it('reject closes a change and leaves the museum alone; a closed change cannot be applied again', async () => {
    const img = (await museumBy(picks.newImage)) as { id: string };
    const id = await pendingId(img.id, 'commons_file');
    const r = await h.admin('change', 'reject', id);
    expect(r.code).toBe(0);
    expect(await rows('SELECT commons_file FROM museum WHERE id = $1', [img.id])).not.toEqual([
      { commons_file: 'Nieuwe gevel 2026.jpg' },
    ]);
    expect((await changeRows(img.id, 'commons_file')).at(-1)).toMatchObject({ state: 'rejected' });
    const again = await h.admin('change', 'apply', id);
    expect([again.code, again.err[0]]).toEqual([65, 'admin: not_pending']);
    expect((await h.admin('change', 'reject', id)).code).toBe(65);
    // The rejection stands: the next sync, with the same news, queues nothing for it.
    const r2 = await sync();
    expect(r2.summary.counts?.declined).toBeGreaterThanOrEqual(1);
    expect((await changeRows(img.id, 'commons_file')).filter((c) => c.state === 'pending')).toEqual([]);
  });

  it('a closure change applies as closed_on', async () => {
    const closed = (await museumBy(picks.dissolved)) as { id: string };
    expect((await h.admin('change', 'apply', await pendingId(closed.id, 'closed_on'))).code).toBe(0);
    expect(await rows('SELECT closed_on::text FROM museum WHERE id = $1', [closed.id])).toEqual([
      { closed_on: '2026-10-01' },
    ]);
  });

  it('an unknown or malformed id is 66', async () => {
    expect((await h.admin('change', 'apply', '019a0000-0000-7000-8000-000000000000')).code).toBe(66);
    expect((await h.admin('change', 'reject', '019a0000-0000-7000-8000-000000000000')).code).toBe(66);
    expect((await h.admin('change', 'apply', 'not-a-uuid')).code).toBe(66);
  });

  it('a value that fails its field schema is 65 and leaves the change pending', async () => {
    const m = (await museumBy(picks.moved100)) as { id: string };
    const { rows: ins } = await owner.query<{ id: string }>(
      `INSERT INTO museum_change (museum_id, field, old, new, origin, source, state)
       VALUES ($1, 'postcode', 'null', '"nonsense"', 'sync', 'wikidata', 'pending') RETURNING id`,
      [m.id],
    );
    const r = await h.admin('change', 'apply', ins[0]?.id as string);
    expect([r.code, r.err[0]]).toEqual([65, 'admin: bad_value']);
    expect((await changeRows(m.id, 'postcode')).at(-1)).toMatchObject({ state: 'pending' });
  });

  it('a presence change needs --keep, --hide or --close D (64 without), and a flag is for presence only', async () => {
    const gone = (await museumBy(picks.gone)) as { id: string };
    const merged = (
      await rows<{ id: string }>(
        "SELECT museum_id AS id FROM museum_change WHERE field = 'presence' AND state = 'pending' AND museum_id <> $1",
        [gone.id],
      )
    )[0] as { id: string };
    const goneChange = await pendingId(gone.id, 'presence');
    const mergedChange = await pendingId(merged.id, 'presence');
    expect((await h.admin('change', 'apply', goneChange)).code).toBe(64);
    expect((await h.admin('change', 'apply', goneChange, '--keep', '--hide')).code).toBe(64);
    expect((await changeRows(gone.id, 'presence')).at(-1)).toMatchObject({ state: 'pending' });

    expect((await h.admin('change', 'apply', goneChange, '--keep')).code).toBe(0);
    expect((await changeRows(gone.id, 'presence')).at(-1)).toMatchObject({ state: 'rejected' });
    expect(await rows('SELECT hidden, closed_on FROM museum WHERE id = $1', [gone.id])).toEqual([
      { hidden: false, closed_on: null },
    ]);

    expect((await h.admin('change', 'apply', mergedChange, '--hide')).code).toBe(0);
    expect(await rows('SELECT hidden FROM museum WHERE id = $1', [merged.id])).toEqual([{ hidden: true }]);
    expect((await changeRows(merged.id, 'presence')).at(-1)).toMatchObject({ state: 'applied' });
    expect(await changeRows(merged.id, 'hidden')).toEqual([
      { old: false, new: true, origin: 'admin', state: 'applied' },
    ]);

    const other = (await museumBy(picks.newWebsite)) as { id: string };
    const { rows: ins } = await owner.query<{ id: string }>(
      `INSERT INTO museum_change (museum_id, field, old, new, origin, source, state)
       VALUES ($1, 'presence', '{"present": true}', '{"present": false}', 'sync', 'rce', 'pending') RETURNING id`,
      [other.id],
    );
    const id = ins[0]?.id as string;
    expect((await h.admin('change', 'apply', id, '--close', '2026-02-30')).code).toBe(64);
    expect((await h.admin('change', 'apply', id, '--close', '2026-10-15')).code).toBe(0);
    expect(await rows('SELECT closed_on::text FROM museum WHERE id = $1', [other.id])).toEqual([
      { closed_on: '2026-10-15' },
    ]);

    const name = (await museumBy(picks.moved100)) as { id: string };
    expect((await h.admin('change', 'apply', await pendingId(name.id, 'postcode'), '--hide')).code).toBe(64);
  });
});

it('mjk_worker cannot UPDATE museum_change.decided_by', async () => {
  const w = new pg.Client({ connectionString: h.db.urls.mjk_worker });
  await w.connect();
  try {
    await expect(w.query('UPDATE museum_change SET decided_by = gen_random_uuid()')).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await w.end();
  }
});
