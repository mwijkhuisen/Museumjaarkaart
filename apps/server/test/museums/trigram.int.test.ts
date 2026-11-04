import fc from 'fast-check';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { normaliseName } from '../../src/museums/normalise.ts';
import { similarity } from '../../src/museums/trigram.ts';
import { createTestDb, type TestDb } from '../db.ts';

// The TypeScript port of similarity() against pg_trgm on PostgreSQL 18 (builtin C.UTF-8 locale).

let db: TestDb;
let worker: pg.Client;

beforeAll(async () => {
  db = await createTestDb();
  // pg_trgm is a trusted extension: the database owner may create it. Migrations are not applied here.
  const migrator = new pg.Client({ connectionString: db.urls.mjk_migrator });
  await migrator.connect();
  try {
    await migrator.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  } finally {
    await migrator.end();
  }
  worker = new pg.Client({ connectionString: db.urls.mjk_worker });
  await worker.connect();
});
afterAll(async () => {
  await worker?.end();
  await db?.drop();
});

async function pgSimilarities(pairs: readonly (readonly [string, string])[]): Promise<number[]> {
  const { rows } = await worker.query<{ s: number }>(
    'SELECT similarity(a, b) AS s FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(a, b, i) ORDER BY i',
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  return rows.map((r) => r.s);
}

async function expectSame(pairs: readonly (readonly [string, string])[]) {
  const fromPg = await pgSimilarities(pairs);
  expect(fromPg).toHaveLength(pairs.length);
  pairs.forEach(([a, b], i) => {
    // Failure message names the pair index only; the values are in the assertion diff.
    expect(Math.abs(similarity(a, b) - (fromPg[i] ?? Number.NaN)), `pair ${i}: ${JSON.stringify([a, b])}`).toBeLessThan(
      1e-6,
    );
  });
}

const NAMES: [string, string][] = [
  ['Stedelijk Museum Alkmaar', 'Stedelijk Museum Schiedam'],
  ['Rijksmuseum Twenthe', 'Museum Twentse Welle'],
  ['Rijksmuseum', 'Rijksmuseum Amsterdam'],
  ['Van Gogh Museum', 'Vincent van Gogh Museum Amsterdam'],
  ['Het Scheepvaartmuseum', 'Nationaal Scheepvaartmuseum'],
  ["'t Hoogeland", 'Museum het Hoogeland'],
  ['Mauritshuis', 'Koninklijk Kabinet van Schilderijen Mauritshuis'],
  ['Kunsthal Rotterdam', 'Kunsthal'],
  ['Museum Boijmans Van Beuningen', 'Boijmans'],
  ['Naturalis Biodiversity Center', 'Naturalis'],
  ['Teylers Museum', 'Teylers Tweede Genootschap'],
  ['Zuiderzeemuseum', 'Zuiderzee Museum Enkhuizen'],
  ['Museum Het Valkhof', 'Valkhof Nijmegen'],
  ['Fries Museum', 'Friesland Museum'],
  ['Fries Scheepvaart Museum', 'Fries Scheepvaartmuseum'],
  ['Allard Pierson', 'Allard Pierson Museum'],
  ['Gemeentemuseum Den Haag', 'Kunstmuseum Den Haag'],
  ['Museum Volkenkunde', 'Wereldmuseum Leiden'],
  ['Legermuseum Delft', 'Nationaal Militair Museum Soesterberg'],
  ['Openluchtmuseum Arnhem', 'Nederlands Openluchtmuseum'],
  ['Joods Museum', 'Joods Historisch Museum'],
  ['Corpus Berg en Dal', 'Corpus Oegstgeest'],
  ['Museum De Lakenhal', 'Lakenhal'],
  ['Stedelijk Museum', 'Stedelijk Museum Amsterdam'],
  ['Hermitage Amsterdam', 'Hermitage'],
  ['Dordrechts Museum', 'Dordrecht Museum'],
  ['Museum Gouda', 'Catharina Gasthuis'],
  ['a', 'a'],
  ['a', 'b'],
  ['a b c', 'c b a'],
  ['ab', 'abc'],
  ['x', 'x y'],
  ['museum 1 2 3', 'museum 123'],
  ['1940 1945', '1940 1945 oorlogsmuseum'],
  ['aa aa aa aa', 'aa'],
  ['abab abab', 'baba'],
  ['zzz', 'zzzz'],
  ['museum museum museum', 'museum'],
  ['', ''],
  ['', 'stedelijk'],
  ['stedelijk', ''],
  ['   ', 'x'],
  ['!!!', '???'],
  ['straat 12', 'straat 21'],
  ['rijksmuseum van oudheden', 'rijks museum van oudheden'],
  ['Müseum Café', 'Museum Cafe'],
  ['ǅ ǆ', 'dž'],
];

const WORDS = [
  'stedelijk',
  'rijks',
  'museum',
  'twenthe',
  'alkmaar',
  'schiedam',
  'kunst',
  'hal',
  'oud',
  'oudheden',
  'boer',
  'boerderij',
  'molen',
  'a',
  'b',
  'x',
  '1',
  '22',
  '1940',
  'het',
  'de',
  'aa',
  'zee',
  'vaart',
];

it('is equal to pg_trgm on at least 40 Dutch museum-like name pairs, normalised first', async () => {
  expect(NAMES.length).toBeGreaterThanOrEqual(40);
  await expectSame(NAMES.map(([a, b]) => [normaliseName(a), normaliseName(b)] as const));
});

it('is equal to pg_trgm on the raw (un-normalised) pairs too', async () => {
  await expectSame(NAMES);
});

it('is equal to pg_trgm on 300 generated pairs of normalised strings', async () => {
  const chars = fc.stringMatching(/^[a-z0-9 ]{0,40}$/);
  const fromWords = fc.array(fc.constantFrom(...WORDS), { maxLength: 5 }).map((w) => w.join(' '));
  const pairs = [
    ...fc.sample(fc.tuple(chars, chars), { numRuns: 150, seed: 20261101 }),
    ...fc.sample(fc.tuple(fromWords, fromWords), { numRuns: 150, seed: 20261102 }),
  ];
  expect(pairs).toHaveLength(300);
  await expectSame(pairs);
});
