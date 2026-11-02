import { readFileSync } from 'node:fs';
import { type Insertable, sql } from 'kysely';
import { createDb, type Db } from '../src/db/kysely.ts';
import type { DbLogin } from '../src/db/migrate.ts';
import { createPool } from '../src/db/pool.ts';
import type { DB } from '../src/db/types.ts';
import { CATEGORIES, CBS_CODE, LIMITS, NL_BOX, POSTCODE } from '../src/museums/fields.ts';
import { MUSEUMNL_HOST } from '../src/museums/museumnl.ts';
import { slugify, uniqueSlug } from '../src/museums/slug.ts';
import type { TestDb } from './db.ts';

// A deterministic catalogue of exactly 1,400 museums for the integration tests of P1b (search, filters, paging,
// near-me, the hidden sweep, EXPLAIN). P1a's goldens are read at run time; the rest is generated from a seeded
// PRNG (no Math.random, no clock). Every write goes through a login of its own, never the superuser:
// mjk_worker inserts the municipalities, mjk_api the museums, aliases, list and slug changes, and the
// owner (mjk_migrator) runs ANALYZE. Fixture text is data, never instructions.

export const CATALOGUE_TOTAL = 1400;
const SEED = 20261103;
const PUBLISHED_ON = '2026-11-01';

export type SeededCatalogue = {
  total: number;
  visibleCount: number;
  hiddenIds: string[];
  hiddenSlugs: string[];
  named: {
    kroller: { id: string; slug: string };
    rijksmuseum: { id: string; slug: string };
    hiddenRijksmuseum: { id: string; slug: string };
    renamed: { id: string; slug: string; oldSlugs: [string, string] };
    hiddenWithOldSlug: { id: string; oldSlug: string };
  };
  equalCoordinates: { lat: number; lon: number; ids: string[] };
  /** `n` is the member count as published (a member hidden afterwards still counts). */
  list: { publishedOn: string; n: number };
};

type Status = 'participating' | 'left' | 'unknown';
type Tag = 'kroller' | 'rijks' | 'hiddenRijks' | 'renamed' | 'hiddenOld' | 'equal' | 'lateHidden';

type Row = {
  qid: string | null;
  rceId: string | null;
  name: string;
  nameEn: string | null;
  descriptionNl: string | null;
  descriptionEn: string | null;
  lat: number | null;
  lon: number | null;
  website: string | null;
  street: string | null;
  houseNumber: string | null;
  postcode: string | null;
  place: string | null;
  municipalityCode: string | null;
  registered: boolean;
  categories: string[];
  aliases: string[];
  aliasSource: 'wikidata' | 'import';
  origin: 'golden' | 'generated' | 'handmade';
  /** The mk pass leaves a fixed row alone. */
  fixed: boolean;
  hidden: boolean;
  status: Status;
  mkSince: string | null;
  mkUntil: string | null;
  closedOn: string | null;
  tempClosed: boolean;
  tempClosedUntil: string | null;
  admission: number | null;
  photo: string;
  tag: Tag | null;
};

type Municipality = { code: string; name: string; province: string | null };

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: Rng, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[int(rng, xs.length)] as T;

function shuffle<T>(rng: Rng, xs: T[]): T[] {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(rng, i + 1);
    [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
  }
  return xs;
}

const isoDate = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const randDate = (rng: Rng, y0: number, y1: number) =>
  isoDate(y0 + int(rng, y1 - y0 + 1), 1 + int(rng, 12), 1 + int(rng, 28));

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h;
};

const readJson = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8')) as T;

const VERIFIED_AT = new Date('2026-10-15T12:00:00Z');
const PROVINCES = [
  'NL-DR',
  'NL-FL',
  'NL-FR',
  'NL-GE',
  'NL-GR',
  'NL-LI',
  'NL-NB',
  'NL-NH',
  'NL-OV',
  'NL-UT',
  'NL-ZE',
  'NL-ZH',
];
const PHOTO = ['allowed', 'no_flash', 'forbidden', 'unknown'] as const;

// ---- parsing the goldens ----------------------------------------------------------------------------------

type Golden = Record<string, unknown>;

/** A text value that fits a CHECK: a string of 1..max characters without NUL, else null. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.includes('\0')) return null;
  const n = Array.from(v).length;
  return n >= 1 && n <= max ? v : null;
}

function website(v: unknown): string | null {
  const s = text(v, LIMITS.url);
  if (s === null || !/^https:\/\/\S+$/.test(s)) return null;
  const host = (URL.canParse(s) ? new URL(s).hostname : '').toLowerCase();
  // Never the link-out host (MUSEUMNL_HOST) as a website, nor a map or search host.
  if (host === '' || host === MUSEUMNL_HOST || /openstreetmap|google/.test(host)) return null;
  return s;
}

function coords(lat: unknown, lon: unknown): [number, number] | [null, null] {
  if (typeof lat !== 'number' || typeof lon !== 'number') return [null, null];
  const ok = lat >= NL_BOX.latMin && lat <= NL_BOX.latMax && lon >= NL_BOX.lonMin && lon <= NL_BOX.lonMax;
  return ok ? [lat, lon] : [null, null];
}

function categoryFor(name: string): string {
  const n = name.toLowerCase();
  if (/\b(kunst|art\b|galerie|schilder|beeld|foto|glas|keramiek)/.test(n)) return 'art';
  if (/natuur|natural|fossiel|vogel|insect|botan|arboretum|hortus|dierentuin/.test(n)) return 'natural_history';
  if (/tech|science|nijverheid|molen|spoor|fiets|vlieg|luchtvaart|radio|computer|gemaal|evoluon/.test(n))
    return 'science_technology';
  if (/volken|etno|wereld|afrika|indi[eë]/.test(n)) return 'ethnology';
  if (
    /geschiedenis|oorlog|kasteel|stads|streek|oudheid|histor|scheepvaart|maritiem|militair|openlucht|rijks|stedelijk|fort\b|verzet/.test(
      n,
    )
  )
    return 'history';
  return CATEGORIES[hash(n) % CATEGORIES.length] as string;
}

function blank(name: string): Row {
  return {
    qid: null,
    rceId: null,
    name,
    nameEn: null,
    descriptionNl: null,
    descriptionEn: null,
    lat: null,
    lon: null,
    website: null,
    street: null,
    houseNumber: null,
    postcode: null,
    place: null,
    municipalityCode: null,
    registered: false,
    categories: [],
    aliases: [],
    aliasSource: 'import',
    origin: 'golden',
    fixed: false,
    hidden: false,
    status: 'unknown',
    mkSince: null,
    mkUntil: null,
    closedOn: null,
    tempClosed: false,
    tempClosedUntil: null,
    admission: null,
    photo: 'unknown',
    tag: null,
  };
}

function cleanAliases(v: unknown, keep: (a: string) => boolean = () => true): string[] {
  if (!Array.isArray(v)) return [];
  const out = new Set<string>();
  for (const a of v) {
    const t = text(a, LIMITS.alias);
    if (t !== null && keep(t)) out.add(t);
  }
  return [...out];
}

function wikidataRow(g: Golden, munis: Map<string, Municipality>): Row | null {
  const name = text(g.name, LIMITS.label);
  const qid = typeof g.qid === 'string' && /^Q[1-9][0-9]*$/.test(g.qid) ? g.qid : null;
  if (name === null || qid === null || g.dissolvedOn) return null;
  const r = blank(name);
  r.qid = qid;
  r.nameEn = text(g.nameEn, LIMITS.label);
  r.descriptionNl = text(g.descriptionNl, LIMITS.description);
  r.descriptionEn = text(g.descriptionEn, LIMITS.description);
  [r.lat, r.lon] = coords(g.lat, g.lon);
  r.website = website(g.website);
  r.street = text(g.street, LIMITS.street);
  r.houseNumber = text(g.houseNumber, LIMITS.houseNumber);
  r.postcode = typeof g.postcode === 'string' && POSTCODE.test(g.postcode) ? g.postcode : null;
  const code = typeof g.municipalityCode === 'string' && CBS_CODE.test(g.municipalityCode) ? g.municipalityCode : null;
  const munName = text(g.municipalityName, LIMITS.municipalityName);
  if (code !== null && munName !== null) {
    const prov = typeof g.provinceCode === 'string' && PROVINCES.includes(g.provinceCode) ? g.provinceCode : null;
    if (!munis.has(code)) munis.set(code, { code, name: munName, province: prov });
    r.municipalityCode = code;
  }
  r.place = text(g.place, LIMITS.place) ?? munName;
  r.registered = g.registered === true;
  r.categories = [categoryFor(name)];
  r.aliases = cleanAliases(g.aliases);
  r.aliasSource = 'wikidata';
  return r;
}

// ---- the catalogue ----------------------------------------------------------------------------------------

type Handmade = {
  rijksmuseum: Record<string, unknown> & { aliases: string[]; categories: string[] };
  hiddenLookalikes: Array<Record<string, unknown> & { aliases: string[]; categories: string[] }>;
  renames: { hostile: string[]; accents: string[]; stedelijk: string; stedelijkCount: number };
};
type Names = {
  themes: Array<{ t: string; c: string }>;
  forms: string[];
  streets: string[];
  aliasForms: string[];
};

const GOLDEN = '../test/fixtures/museums/';
const goldenRows = (rel: string): Golden[] =>
  (JSON.parse(readFileSync(new URL(`${GOLDEN}${rel}`, import.meta.url), 'utf8')) as { rows: Golden[] }).rows;

function postcode(rng: Rng): string {
  const L = () => String.fromCharCode(65 + int(rng, 26));
  return `${1 + int(rng, 9)}${String(int(rng, 1000)).padStart(3, '0')} ${L()}${L()}`;
}

function buildRows(rng: Rng): { rows: Row[]; munis: Map<string, Municipality> } {
  const munis = new Map<string, Municipality>();
  const hand = readJson<Handmade>('./fixtures/catalogue/handmade.json');
  const names = readJson<Names>('./fixtures/catalogue/names.json');
  const fixtureMunis = readJson<Array<{ code: string; name: string; province: string; lat: number; lon: number }>>(
    './fixtures/catalogue/municipalities.json',
  );

  // 1. Wikidata goldens (first QID wins).
  const wd: Row[] = [];
  const qids = new Set<string>();
  for (const file of ['wikidata/normal', 'wikidata/edge', 'wikidata/synthetic', 'wikidata/hostile']) {
    for (const g of goldenRows(`${file}.golden.json`)) {
      const r = wikidataRow(g, munis);
      if (r === null || r.qid === null || qids.has(r.qid)) continue;
      qids.add(r.qid);
      wd.push(r);
    }
  }
  for (const m of fixtureMunis)
    if (!munis.has(m.code)) munis.set(m.code, { code: m.code, name: m.name, province: m.province });

  // Kröller-Müller: only the aliases with a non-ASCII character, so "kroller muller" needs unaccent.
  const kroller = wd.find((r) => r.qid === 'Q1051928');
  if (kroller === undefined) throw new Error('seed-catalogue: golden Q1051928 missing');
  kroller.aliases = kroller.aliases.filter((a) => /[^\p{ASCII}]/u.test(a));
  Object.assign(kroller, { tag: 'kroller', fixed: true, status: 'participating', mkSince: '2010-04-01' });

  const rows: Row[] = [...wd];
  const taken = new Set(wd.map((r) => r.name.toLowerCase()));

  // 2. RCE normal: municipality by name (a known one, else an invented GM95xx code with no province).
  const byName = new Map<string, Municipality>();
  for (const m of munis.values()) byName.set(m.name.toLowerCase(), m);
  let invented = 9501;
  const rceIds = new Set<string>();
  for (const g of goldenRows('rce/normal.golden.json')) {
    const name = text(g.name, LIMITS.label);
    const rceId = typeof g.rceId === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(g.rceId) ? g.rceId : null;
    if (name === null || rceId === null || rceIds.has(rceId)) continue;
    const isRijks = name === 'Rijksmuseum Amsterdam';
    if (taken.has(name.toLowerCase()) && !isRijks) continue;
    rceIds.add(rceId);
    taken.add(name.toLowerCase());
    const r = blank(name);
    r.rceId = rceId;
    [r.lat, r.lon] = coords(g.lat, g.lon);
    r.street = text(g.street, LIMITS.street);
    r.houseNumber = text(g.houseNumber, LIMITS.houseNumber);
    r.postcode = typeof g.postcode === 'string' && POSTCODE.test(g.postcode) ? g.postcode : null;
    r.place = text(g.place, LIMITS.place);
    const munName = text(g.municipalityName, LIMITS.municipalityName);
    if (munName !== null) {
      let m = byName.get(munName.toLowerCase());
      if (m === undefined && invented <= 9999) {
        m = { code: `GM${invented++}`, name: munName, province: null };
        munis.set(m.code, m);
        byName.set(munName.toLowerCase(), m);
      }
      r.municipalityCode = m?.code ?? null;
    }
    r.categories = [categoryFor(name)];
    if (isRijks) {
      Object.assign(r, {
        hidden: true,
        fixed: true,
        status: 'participating',
        mkSince: '2012-01-01',
        tag: 'hiddenRijks',
      });
      r.aliases = ['Rijks Amsterdam'];
    }
    rows.push(r);
  }
  if (!rows.some((r) => r.tag === 'hiddenRijks')) throw new Error('seed-catalogue: RCE Rijksmuseum Amsterdam missing');

  // 3. Hand-made: the Rijksmuseum and the hidden lookalikes.
  const h = hand.rijksmuseum;
  const rijks = blank(h.name as string);
  Object.assign(rijks, {
    nameEn: h.nameEn,
    descriptionNl: h.descriptionNl,
    descriptionEn: h.descriptionEn,
    street: h.street,
    houseNumber: h.houseNumber,
    postcode: h.postcode,
    place: h.place,
    municipalityCode: h.municipalityCode,
    lat: h.lat,
    lon: h.lon,
    website: h.website,
    registered: h.registered,
    categories: h.categories,
    aliases: h.aliases,
    origin: 'handmade',
    fixed: true,
    status: 'participating',
    mkSince: '2000-01-01',
    tag: 'rijks',
  });
  rows.push(rijks);
  for (const l of hand.hiddenLookalikes) {
    const r = blank(l.name as string);
    Object.assign(r, {
      nameEn: l.nameEn,
      place: l.place,
      municipalityCode: l.municipalityCode,
      lat: l.lat,
      lon: l.lon,
      categories: l.categories,
      aliases: l.aliases,
      street: pick(rng, names.streets),
      houseNumber: String(1 + int(rng, 90)),
      postcode: postcode(rng),
      origin: 'handmade',
      fixed: true,
      hidden: true,
      status: 'participating',
      mkSince: randDate(rng, 2010, 2020),
    });
    rows.push(r);
  }
  for (const r of rows) {
    if (r.municipalityCode !== null && !munis.has(r.municipalityCode)) r.municipalityCode = null;
    // A name that tokenizes to nothing (a bare HTML tag) must still be searchable by its place.
    if (r.place === null) r.place = pick(rng, fixtureMunis).name;
  }

  // 4. Generated rows fill up to the total, round-robin over the provinces.
  const missing = CATALOGUE_TOTAL - rows.length;
  if (missing < 200) throw new Error(`seed-catalogue: only ${missing} rows left to generate`);
  const byProv = new Map<string, typeof fixtureMunis>();
  for (const m of fixtureMunis) byProv.set(m.province, [...(byProv.get(m.province) ?? []), m]);
  const used = new Set(rows.map((r) => r.name.toLowerCase()));
  for (let i = 0; i < missing; i++) {
    const prov = PROVINCES[i % PROVINCES.length] as string;
    const m = pick(rng, byProv.get(prov) ?? []);
    const theme = pick(rng, names.themes);
    let name = '';
    for (let attempt = 0; attempt < 12; attempt++) {
      const form = pick(rng, names.forms);
      name = form.replaceAll('{T}', pick(rng, names.themes).t).replaceAll('{P}', m.name);
      if (attempt === 0) name = form.replaceAll('{T}', theme.t).replaceAll('{P}', m.name);
      if (!used.has(name.toLowerCase())) break;
      if (attempt === 11) name = `${name} (${1 + int(rng, 99)})`;
    }
    used.add(name.toLowerCase());
    const r = blank(name);
    r.origin = 'generated';
    r.place = m.name;
    r.municipalityCode = m.code;
    r.lat = Math.round((m.lat + (rng() - 0.5) * 0.12) * 1e6) / 1e6;
    r.lon = Math.round((m.lon + (rng() - 0.5) * 0.16) * 1e6) / 1e6;
    r.street = pick(rng, names.streets);
    r.houseNumber = String(1 + int(rng, 150));
    r.postcode = postcode(rng);
    r.website = `https://www.${slugify(name, 60)}-${i}.example/`;
    r.registered = rng() < 0.4;
    r.categories = [theme.c];
    if (rng() < 0.25) {
      const second = pick(rng, CATEGORIES) as string;
      if (second !== theme.c) r.categories.push(second);
    }
    if (rng() < 0.5) r.descriptionNl = `museum in ${m.name}`;
    if (rng() < 0.35) r.nameEn = name;
    if (rng() < 0.4) {
      const n = 1 + int(rng, 2);
      for (let k = 0; k < n; k++) {
        const a = pick(rng, names.aliasForms)
          .replaceAll('{N}', name)
          .replaceAll('{P}', m.name)
          .replaceAll('{T}', theme.t);
        if (Array.from(a).length <= LIMITS.alias && a !== name && !r.aliases.includes(a)) r.aliases.push(a);
      }
    }
    rows.push(r);
  }
  return { rows, munis };
}

/** Applies every required case to disjoint slices of the generated rows. */
function applyCases(rng: Rng, rows: Row[]): void {
  const hand = readJson<Handmade>('./fixtures/catalogue/handmade.json');
  const generated = rows.filter((r) => r.origin === 'generated');
  const order = shuffle(rng, [...generated]);
  let cur = 0;
  const take = (n: number) => {
    const part = order.slice(cur, cur + n);
    cur += n;
    return part;
  };

  for (const r of take(45)) [r.lat, r.lon] = [null, null];

  const hiddenRand = take(24);
  for (const r of hiddenRand) {
    Object.assign(r, { hidden: true, fixed: true, status: 'participating', mkSince: randDate(rng, 2008, 2022) });
    if (r.aliases.length === 0) r.aliases.push(`Oud ${r.name}`);
  }
  (hiddenRand[0] as Row).tag = 'hiddenOld';
  // A member that is hidden after the list is published (visible until then).
  const lateRow = take(1)[0] as Row;
  Object.assign(lateRow, {
    fixed: true,
    status: 'participating',
    mkSince: randDate(rng, 2008, 2022),
    tag: 'lateHidden',
  });
  if (lateRow.aliases.length === 0) lateRow.aliases.push(`Oud ${lateRow.name}`);

  take(12).forEach((r, i) => {
    r.closedOn = isoDate(2018 + (i % 8), 1 + ((i * 5) % 12), 1 + ((i * 7) % 28));
  });
  (take(1)[0] as Row).closedOn = '2027-03-31';
  const until = ['2026-12-15', '2027-01-10', '2027-02-01'];
  take(6).forEach((r, i) => {
    r.tempClosed = true;
    r.tempClosedUntil = until[i] ?? null;
  });

  for (const r of take(3)) Object.assign(r, { lat: 52.1, lon: 5.1, tag: 'equal' });
  const mirrored: Array<[number, number]> = [
    [52.01, 5.02],
    [51.99, 4.98],
    [52.515, 6.005],
    [52.485, 5.995],
  ];
  take(4).forEach((r, i) => {
    [r.lat, r.lon] = mirrored[i] as [number, number];
  });

  for (const r of take(hand.renames.stedelijkCount)) Object.assign(r, { name: hand.renames.stedelijk, nameEn: null });
  for (const names of [hand.renames.accents, hand.renames.hostile]) {
    for (const [i, r] of take(names.length).entries()) Object.assign(r, { name: names[i], nameEn: null });
  }
  Object.assign(take(1)[0] as Row, { name: 'Museum Veranderlijk', nameEn: null, tag: 'renamed' });

  // Museumkaart for everything else; hidden rows are always participating.
  for (const r of rows) {
    if (!r.fixed) {
      const x = rng();
      if (x < 0.3) {
        r.status = 'participating';
        r.mkSince = randDate(rng, 2008, 2025);
      } else if (x < 0.36) {
        r.status = 'left';
        r.mkSince = randDate(rng, 2005, 2012);
        r.mkUntil = randDate(rng, 2013, 2025);
      }
    }
    if (rng() < 0.6) r.admission = 500 + 50 * int(rng, 40);
    r.photo = pick(rng, PHOTO);
  }
}

// ---- writing ----------------------------------------------------------------------------------------------

async function as<T>(login: DbLogin, url: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const pool = createPool(login, { DATABASE_URL: url }, { max: 2 });
  if (typeof pool === 'string') throw new Error(`seed-catalogue: ${pool}`);
  const db = createDb(pool);
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
}

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

function toInsert(r: Row, slug: string): Insertable<DB['museum']> {
  return {
    slug,
    wikidata_qid: r.qid,
    rce_id: r.rceId,
    name: r.name,
    name_en: r.nameEn,
    description_nl: r.descriptionNl,
    description_en: r.descriptionEn,
    lat: r.lat,
    lon: r.lon,
    website: r.website,
    street: r.street,
    house_number: r.houseNumber,
    postcode: r.postcode,
    place: r.place,
    municipality_code: r.municipalityCode,
    registered: r.registered,
    museumnl_url: null,
    categories: r.categories,
    closed_on: r.closedOn,
    museumkaart_status: r.status,
    mk_since: r.mkSince,
    mk_until: r.mkUntil,
    mk_last_verified_at: r.status === 'unknown' ? null : VERIFIED_AT,
    admission_adult_cents: r.admission,
    price_verified_at: r.admission === null ? null : VERIFIED_AT,
    photo_policy: r.photo,
    temp_closed: r.tempClosed,
    temp_closed_until: r.tempClosedUntil,
    hidden: r.hidden,
  };
}

export async function seedCatalogue(db: TestDb, opts: { analyze?: boolean } = {}): Promise<SeededCatalogue> {
  const rng = mulberry32(SEED);
  const { rows, munis } = buildRows(rng);
  applyCases(rng, rows);
  if (rows.length !== CATALOGUE_TOTAL) throw new Error(`seed-catalogue: ${rows.length} rows, not ${CATALOGUE_TOTAL}`);
  shuffle(rng, rows);

  const taken = new Set<string>();
  const slugs = new Map<Row, string>();
  const early = new Map<Row, string[]>();
  for (const r of rows) {
    const slug = uniqueSlug(r.name, r.place, taken);
    taken.add(slug);
    slugs.set(r, slug);
    if (r.tag === 'renamed') early.set(r, [`${slug}-eerste`, `${slug}-tweede`]);
    if (r.tag === 'hiddenOld') early.set(r, [`${slug}-oud`]);
  }
  for (const olds of early.values()) for (const s of olds) taken.add(s);

  await as('mjk_worker', db.urls.mjk_worker, (w) =>
    w.transaction().execute(async (trx) => {
      const list = [...munis.values()].map((m) => ({ cbs_code: m.code, name: m.name, province_code: m.province }));
      for (const part of chunks(list, 200)) await trx.insertInto('municipality').values(part).execute();
    }),
  );

  const result = await as('mjk_api', db.urls.mjk_api, (api) =>
    api.transaction().execute(async (trx) => {
      const idBySlug = new Map<string, string>();
      for (const part of chunks(rows, 250)) {
        const out = await trx
          .insertInto('museum')
          .values(
            part.map((r) => {
              const olds = early.get(r);
              return toInsert(r, olds?.[0] ?? (slugs.get(r) as string));
            }),
          )
          .returning(['id', 'slug'])
          .execute();
        for (const o of out) idBySlug.set(o.slug, o.id);
      }
      const idOf = (r: Row) => {
        const olds = early.get(r);
        const first = olds?.[0];
        return idBySlug.get(first !== undefined ? first : (slugs.get(r) as string)) as string;
      };

      const aliases: Insertable<DB['museum_alias']>[] = [];
      for (const r of rows)
        for (const alias of r.aliases) aliases.push({ museum_id: idOf(r), alias, source: r.aliasSource });
      for (const part of chunks(aliases, 500)) await trx.insertInto('museum_alias').values(part).execute();

      // Slug changes: the keep trigger writes the redirects.
      const slugChange = async (id: string, to: string) => {
        await trx.updateTable('museum').set({ slug: to }).where('id', '=', id).execute();
      };
      for (const [r, olds] of early) {
        if (r.tag === 'renamed') await slugChange(idOf(r), olds[1] as string);
        await slugChange(idOf(r), slugs.get(r) as string);
      }

      // The list as published: the visible participating museums.
      const members = rows.filter((r) => !r.hidden && r.status === 'participating');
      const version = await trx
        .insertInto('mk_list_version')
        .values({ published_on: PUBLISHED_ON })
        .returning('id')
        .executeTakeFirstOrThrow();
      for (const part of chunks(members, 500))
        await trx
          .insertInto('mk_list_member')
          .values(part.map((r) => ({ list_version_id: version.id, museum_id: idOf(r) })))
          .execute();

      // Afterwards one member is hidden; N stays as published.
      const late = members.find((r) => r.tag === 'lateHidden');
      if (late === undefined) throw new Error('seed-catalogue: no member to hide');
      late.hidden = true;
      await trx.updateTable('museum').set({ hidden: true }).where('id', '=', idOf(late)).execute();

      return { idOf, members: members.length };
    }),
  );

  if (opts.analyze !== false) {
    await as('mjk_migrator', db.urls.mjk_migrator, async (owner) => {
      await sql`ANALYZE`.execute(owner);
    });
  }

  const final = (r: Row) => ({ id: result.idOf(r), slug: slugs.get(r) as string });
  const one = (tag: Tag) => {
    const r = rows.find((x) => x.tag === tag);
    if (r === undefined) throw new Error(`seed-catalogue: no row tagged ${tag}`);
    return r;
  };
  const hidden = rows.filter((r) => r.hidden);
  const renamed = one('renamed');
  const hiddenOld = one('hiddenOld');
  const equal = rows.filter((r) => r.tag === 'equal');
  const oldSlugs = early.get(renamed) as string[];
  return {
    total: rows.length,
    visibleCount: rows.length - hidden.length,
    hiddenIds: hidden.map((r) => result.idOf(r)),
    hiddenSlugs: hidden.map((r) => slugs.get(r) as string),
    named: {
      kroller: final(one('kroller')),
      rijksmuseum: final(one('rijks')),
      hiddenRijksmuseum: final(one('hiddenRijks')),
      renamed: { ...final(renamed), oldSlugs: [oldSlugs[0] as string, oldSlugs[1] as string] },
      hiddenWithOldSlug: { id: result.idOf(hiddenOld), oldSlug: (early.get(hiddenOld) as string[])[0] as string },
    },
    equalCoordinates: { lat: 52.1, lon: 5.1, ids: equal.map((r) => result.idOf(r)) },
    list: { publishedOn: PUBLISHED_ON, n: result.members },
  };
}
