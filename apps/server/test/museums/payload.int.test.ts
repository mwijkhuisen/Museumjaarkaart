import fc from 'fast-check';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb, type Db } from '../../src/db/kysely.ts';
import { createPool } from '../../src/db/pool.ts';
import { applyPlan, loadState } from '../../src/museums/apply.ts';
import { plan } from '../../src/museums/diff.ts';
import { LIMITS } from '../../src/museums/fields.ts';
import { MUSEUMNL_HOST } from '../../src/museums/museumnl.ts';
import { parseRce, RCE_PROPS } from '../../src/museums/sources/rce.ts';
import { FIELD_SEP, parseWikidata, RECORD_SEP } from '../../src/museums/sources/wikidata.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// Fix of review finding 2: every row the parsers return fits the database. Worst-case values for each
// column (at the caps in code points, astral characters, percent-encoding that grows a URL, the edges
// of the NL box, the longest keys) go through parseWikidata and parseRce, then through the seed and a
// sync as mjk_worker, in a transaction that is rolled back. A CHECK, a jsonb or an encoding error fails.

const ENTITY = 'http://www.wikidata.org/entity/';
const FILEPATH = 'http://commons.wikimedia.org/wiki/Special:FilePath/';
const ASTRAL = '\u{1F3DB}'; // two UTF-16 units, one character for char_length
const NAME = `Rijksmuseum Amsterdam ${ASTRAL.repeat(LIMITS.label - 22)}`;

let test: TestDb;
let db: Db;

beforeAll(async () => {
  test = await createMigratedDb();
  const pool = createPool('mjk_worker', { DATABASE_URL: test.urls.mjk_worker }, { max: 2 });
  if (typeof pool === 'string') throw new Error(pool);
  db = createDb(pool);
});
afterAll(async () => {
  await db?.destroy();
  await test?.drop();
});

type Item = Record<string, string>;
const binding = (qid: string, vars: Item) => ({
  item: { type: 'uri', value: `${ENTITY}${qid}` },
  ...Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, { type: 'literal', value: v }])),
});
const sparql = (items: [string, Item][]) => ({
  head: { vars: ['item'] },
  results: { bindings: items.map(([qid, vars]) => binding(qid, vars)) },
});
const feature = (id: unknown, properties: Record<string, unknown>, x: number | null, y: number | null) => ({
  type: 'Feature',
  id,
  geometry: x === null || y === null ? null : { type: 'Point', coordinates: [x, y] },
  properties,
});
const wfs = (features: unknown[]) => ({ type: 'FeatureCollection', features });

class Rollback extends Error {}

/**
 * Seeds from one pair of answers and syncs a second pair on top, as mjk_worker, then rolls back.
 * Returns how many museums the seed created and how many rows the sync wrote, so a test can see that
 * the values really reached the tables.
 */
async function seedThenSync(
  first: { wikidata: unknown; rce: unknown },
  second: { wikidata: unknown; rce: unknown },
): Promise<{ created: number; changes: number; rceMatched: number }> {
  const out = { created: 0, changes: 0, rceMatched: 0 };
  const sources = (a: { wikidata: unknown; rce: unknown }) => {
    const w = parseWikidata(a.wikidata);
    const r = parseRce(a.rce);
    if (!w.ok || !r.ok) throw new Error('the worst-case answers must parse');
    return { wikidata: w.rows, rce: r.rows };
  };
  try {
    await db.transaction().execute(async (tx) => {
      const seedRun = await tx.insertInto('museum_sync_run').values({ mode: 'seed' }).returning('id').execute();
      const seeded = plan(await loadState(tx), sources(first), 'seed');
      await applyPlan(tx, seeded, seedRun[0]?.id as string);
      out.created = seeded.counts.created;
      out.rceMatched = Object.values(seeded.counts.matched).reduce((a, b) => a + b, 0);
      const syncRun = await tx.insertInto('museum_sync_run').values({ mode: 'sync' }).returning('id').execute();
      const synced = plan(await loadState(tx), sources(second), 'sync');
      await applyPlan(tx, synced, syncRun[0]?.id as string);
      out.changes = synced.changes.length;
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

// --- the hand-written worst case -----------------------------------------------------------------

const LONG_QID = `Q${'9'.repeat(63)}`; // 64 characters: museum_source_row.external_id's cap
const LONG_RCE_ID = `overzichtmusea.${'9'.repeat(49)}`; // 64 characters
const urlTo = (prefix: string, length: number) => `${prefix}${'a'.repeat(length - prefix.length)}`;

function worstWikidata(variant: 0 | 1): unknown {
  const c = variant === 0 ? ASTRAL : 'Ω';
  const aliases = Array.from({ length: 60 }, (_, i) => `${String(i).padStart(3, '0')}${c.repeat(LIMITS.alias - 3)}`);
  const full: Item = {
    labelNl: NAME,
    labelEn: c.repeat(LIMITS.label),
    descNl: c.repeat(LIMITS.description),
    descEn: c.repeat(LIMITS.description + 1), // one over: dropped with a note, the row stays
    aliases: aliases.join(RECORD_SEP),
    // The box edges, and a second point; a move under 250 m in the second week applies.
    coords: variant === 0 ? 'Point(7.3 53.7)' : 'Point(7.299 53.7)',
    // http, upgraded to https: exactly 2,048 characters as stored.
    websites: urlTo(variant === 0 ? 'http://a.example/' : 'http://b.example/', LIMITS.url - 1),
    addresses: `${c.repeat(LIMITS.street)} ${'1'.repeat(19)}A, 1071 DJ ${c.repeat(LIMITS.place)}`,
    postcodes: '1071dj',
    municipalities: `0363${FIELD_SEP}${c.repeat(LIMITS.municipalityName)}${FIELD_SEP}NL-NH`,
    museumnl: urlTo(`https://${MUSEUMNL_HOST}/${variant}/`, LIMITS.url),
    images: `${FILEPATH}${encodeURIComponent(c.repeat(LIMITS.commonsFile))}`,
    classes: [`${ENTITY}Q33506`, `${ENTITY}Q207694`, `${ENTITY}Q${'9'.repeat(80)}`].join(RECORD_SEP),
    registered: 'true',
  };
  // A percent-encoding that grows a link past its column: 722 characters in, 4,222 as the href.
  const grows: Item = {
    labelNl: `Groeit ${c}`,
    museumnl: `https://${MUSEUMNL_HOST}/${'é'.repeat(700)}`,
    websites: `https://c.example/${'é'.repeat(700)}`,
    coords: 'Point(3.2 50.7)',
  };
  const sparse: Item = { labelEn: c, registered: 'false' };
  const items: [string, Item][] = [
    [LONG_QID, full],
    ['Q2', grows],
    ['Q3', sparse],
    // Only in the second week: a closure and a second item at the far corner.
    ...(variant === 1
      ? ([
          ['Q4', { labelNl: 'Dicht', dissolved: '9999-12-31T00:00:00Z', coords: 'Point(3.2 53.7)' }],
          ['Q3', { dissolved: '0001-01-01T00:00:00Z' }],
        ] as [string, Item][])
      : []),
  ];
  return sparql(items);
}

function worstRce(variant: 0 | 1): unknown {
  const c = variant === 0 ? ASTRAL : 'Ω';
  return wfs([
    feature(
      LONG_RCE_ID,
      {
        [RCE_PROPS.name]: NAME,
        [RCE_PROPS.street]: c.repeat(LIMITS.street),
        [RCE_PROPS.houseNumber]: '1'.repeat(17),
        [RCE_PROPS.houseNumberAddition]: 'HS',
        [RCE_PROPS.postcode]: '1071DJ',
        [RCE_PROPS.place]: c.repeat(LIMITS.place),
        [RCE_PROPS.municipality]: c.repeat(LIMITS.municipalityName),
      },
      7.3,
      53.7,
    ),
    feature('overzichtmusea.2', { [RCE_PROPS.name]: `${c}`.repeat(LIMITS.label) }, 50.7, 3.2), // swapped axes
    feature('overzichtmusea.3', { [RCE_PROPS.name]: 'X', [RCE_PROPS.houseNumber]: 123456789 }, null, null),
  ]);
}

it('the hand-written worst case of every column parses and goes in as mjk_worker without a CHECK failure', async () => {
  const r = await seedThenSync(
    { wikidata: worstWikidata(0), rce: worstRce(0) },
    { wikidata: worstWikidata(1), rce: worstRce(1) },
  );
  // The seed creates the three live items and links the long RCE row by postcode and name; the second
  // week changes every safe field of it (applied) and the name, the image and the closures (pending).
  expect(r.created).toBe(3);
  expect(r.rceMatched).toBeGreaterThanOrEqual(1);
  expect(r.changes).toBeGreaterThan(5);
});

// --- the property --------------------------------------------------------------------------------

const ODD = [
  ASTRAL,
  '\u0000',
  '\uD800',
  '\uDC00',
  'é',
  '‮',
  ' ',
  '\n',
  ' ',
  '#',
  '/',
  '%',
  '|',
  'é',
  'ß',
  '1',
  'A',
  FIELD_SEP,
  RECORD_SEP,
];
const unit = fc.oneof(fc.constantFrom(...ODD), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }));
/** A string of about `cap` characters, below, at or over it. */
const near = (cap: number) =>
  fc
    .tuple(fc.integer({ min: Math.max(0, cap - 3), max: cap + 3 }), unit, fc.string({ unit, maxLength: 6 }))
    .map(([n, fill, tail]) => `${fill.repeat(Math.max(0, n - [...tail].length))}${tail}`);
const anyLength = (cap: number) => fc.oneof(near(cap), fc.string({ unit, maxLength: 12 }));

const wikidataItem = fc.record(
  {
    labelNl: anyLength(LIMITS.label),
    labelEn: anyLength(LIMITS.label),
    descNl: anyLength(LIMITS.description),
    descEn: anyLength(LIMITS.description),
    aliases: fc.array(anyLength(LIMITS.alias), { maxLength: 4 }).map((a) => a.join(RECORD_SEP)),
    coords: fc
      .tuple(fc.double({ min: 3.1, max: 7.4, noNaN: true }), fc.double({ min: 50.6, max: 53.8, noNaN: true }))
      .map(([x, y]) => `Point(${x} ${y})`),
    websites: fc
      .tuple(fc.constantFrom('http://', 'https://'), anyLength(LIMITS.url - 20))
      .map(([s, p]) => `${s}x.example/${p}`),
    addresses: fc
      .tuple(anyLength(LIMITS.street), anyLength(LIMITS.houseNumber), anyLength(LIMITS.place))
      .map(([s, n, p]) => `${s} ${n}, 1071 DJ ${p}`),
    postcodes: fc.constantFrom('1071dj', '1071 DJ', '0123 AB', 'x'),
    municipalities: fc
      .tuple(fc.stringMatching(/^[0-9]{4}$/), anyLength(LIMITS.municipalityName), fc.constantFrom('NL-NH', 'NL-XX'))
      .map(([d, n, p]) => `${d}${FIELD_SEP}${n}${FIELD_SEP}${p}`),
    museumnl: anyLength(LIMITS.url - 22).map((p) => `https://${MUSEUMNL_HOST}/${p}`),
    images: anyLength(LIMITS.commonsFile).map((n) => `${FILEPATH}${n.isWellFormed() ? encodeURIComponent(n) : n}`),
    classes: fc.constantFrom(`${ENTITY}Q33506`, `${ENTITY}Q207694`, ''),
    dissolved: fc.constantFrom('', '0000-01-01T00:00:00Z', '0001-01-01T00:00:00Z', '9999-12-31T00:00:00Z'),
    registered: fc.constantFrom('true', 'false', ''),
  },
  { requiredKeys: [] },
);
const qid = fc.oneof(
  fc.integer({ min: 1, max: 30 }).map((n) => `Q${n}`),
  fc.integer({ min: 60, max: 70 }).map((n) => `Q${'7'.repeat(n - 1)}`),
);
const rceFeature = fc.record({
  id: fc.oneof(
    fc.integer({ min: 1, max: 30 }).map((n) => `overzichtmusea.${n}`),
    anyLength(LIMITS.rceId),
    fc.nat(),
  ),
  name: anyLength(LIMITS.label),
  street: anyLength(LIMITS.street),
  number: fc.oneof(anyLength(LIMITS.houseNumber), fc.nat()),
  addition: fc.oneof(fc.constant(undefined), anyLength(4)),
  postcode: fc.constantFrom('1071DJ', '1071 dj', 'xx'),
  place: anyLength(LIMITS.place),
  municipality: anyLength(LIMITS.municipalityName),
  x: fc.double({ min: 3.1, max: 7.4, noNaN: true }),
  y: fc.double({ min: 50.6, max: 53.8, noNaN: true }),
});
const answers = fc.record({
  wikidata: fc.array(fc.tuple(qid, wikidataItem), { maxLength: 4 }).map(sparql),
  rce: fc.array(rceFeature, { maxLength: 4 }).map((fs) =>
    wfs(
      fs.map((f) =>
        feature(
          f.id,
          {
            [RCE_PROPS.name]: f.name,
            [RCE_PROPS.street]: f.street,
            [RCE_PROPS.houseNumber]: f.number,
            [RCE_PROPS.houseNumberAddition]: f.addition,
            [RCE_PROPS.postcode]: f.postcode,
            [RCE_PROPS.place]: f.place,
            [RCE_PROPS.municipality]: f.municipality,
          },
          f.x,
          f.y,
        ),
      ),
    ),
  ),
});

it('arbitrary values near every cap: whatever the parsers keep goes in as mjk_worker, seed and sync', async () => {
  await fc.assert(
    fc.asyncProperty(answers, answers, async (first, second) => {
      await seedThenSync(first, second);
    }),
    { numRuns: 60 },
  );
}, 120_000);
