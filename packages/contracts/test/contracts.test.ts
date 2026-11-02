import { describe, expect, it } from 'vitest';
import {
  EmptyQuery,
  ErrorBody,
  Healthz,
  IsoDate,
  IsoDateTime,
  LatParam,
  Limit,
  LonParam,
  MkList,
  MuseumDetail,
  MuseumList,
  MuseumListItem,
  MuseumListQuery,
  NearList,
  NearQuery,
  PROVINCE_CODES,
  Provinces,
  Q,
  SlugParam,
  Suggest,
  SuggestQuery,
} from '../src/index.ts';

const item = {
  id: '3f0c2a7e-8f5b-4c53-9a43-2d6f0a1b7c11',
  slug: 'rijksmuseum',
  name: 'Rijksmuseum',
  name_en: null,
  place: 'Amsterdam',
  municipality_code: 'GM0363',
  municipality_name: 'Amsterdam',
  province_code: 'NL-NH',
  lat: 52.36,
  lon: 4.885,
  categories: ['art'],
  museumkaart_status: 'participating',
  registered: true,
  closed_on: null,
  temp_closed: false,
};
const detail = {
  ...item,
  description_nl: null,
  description_en: null,
  street: 'Museumstraat',
  house_number: '1',
  postcode: '1071 XX',
  website: 'https://www.rijksmuseum.nl',
  museumnl_url: 'https://www.museum.nl/nl/rijksmuseum',
  mk_since: '2020-01-01',
  mk_until: null,
  mk_last_verified_at: '2026-10-01T10:00:00Z',
  admission_adult_cents: 2200,
  price_verified_at: null,
  photo_policy: 'allowed',
  temp_closed_until: null,
  mk_list: { published_on: '2026-11-01', n: 512, member: true },
};
const near = { ...item, distance_m: 120 };
const provinces = PROVINCE_CODES.map((code) => ({ code, name_nl: 'x', name_en: 'x', museum_count: 1 }));

const samples: [string, { safeParse: (v: unknown) => { success: boolean } }, unknown][] = [
  ['Healthz', Healthz, { ok: true }],
  ['MuseumListItem', MuseumListItem, item],
  ['MuseumList', MuseumList, { items: [item], next_cursor: 'abc_-1', total: 1 }],
  ['MuseumDetail', MuseumDetail, detail],
  ['Suggest', Suggest, { items: [{ slug: 'a', name: 'A', place: null, municipality_name: null }] }],
  ['NearList', NearList, { items: [near] }],
  ['Provinces', Provinces, { items: provinces }],
  ['MkList', MkList, { list: { published_on: '2026-11-01', n: 3 } }],
  ['ErrorBody', ErrorBody, { error: 'not_found', fields: ['q'] }],
];

describe('answers', () => {
  it.each(samples)('%s accepts a valid sample and refuses an unknown key', (_n, schema, sample) => {
    expect(schema.safeParse(sample).success).toBe(true);
    expect(schema.safeParse({ ...(sample as object), extra: 1 }).success).toBe(false);
  });

  it('MuseumDetail refuses each forbidden name', () => {
    for (const k of ['hidden', 'pinned_fields', 'rce_id', 'wikidata_qid', 'commons_file', 'created_at', 'updated_at']) {
      expect(MuseumDetail.safeParse({ ...detail, [k]: 'x' }).success, k).toBe(false);
    }
  });

  it('refuses nested unknown keys, bad enums and out-of-range values', () => {
    expect(MuseumList.safeParse({ items: [{ ...item, x: 1 }], next_cursor: null, total: 0 }).success).toBe(false);
    expect(MuseumListItem.safeParse({ ...item, province_code: 'NL-XX' }).success).toBe(false);
    expect(MuseumListItem.safeParse({ ...item, lat: 40 }).success).toBe(false);
    expect(MuseumDetail.safeParse({ ...detail, admission_adult_cents: 20001 }).success).toBe(false);
    expect(MuseumDetail.safeParse({ ...detail, website: 'http://x.nl' }).success).toBe(false);
    expect(MuseumDetail.safeParse({ ...detail, museumnl_url: 'https://evil.nl/x' }).success).toBe(false);
    expect(MuseumDetail.safeParse({ ...detail, postcode: '1234AB' }).success).toBe(false);
    expect(MuseumDetail.safeParse({ ...detail, mk_last_verified_at: '2026-10-01T10:00:00+02:00' }).success).toBe(false);
    expect(Provinces.safeParse({ items: provinces.slice(1) }).success).toBe(false);
    expect(NearList.safeParse({ items: [{ ...near, lat: null }] }).success).toBe(false);
    const tooMany = Array(11).fill({ slug: 'a', name: 'A', place: null, municipality_name: null });
    expect(Suggest.safeParse({ items: tooMany }).success).toBe(false);
    expect(ErrorBody.safeParse({ error: 'nope' }).success).toBe(false);
    expect(ErrorBody.safeParse({ error: 'invalid', fields: Array(51).fill('a') }).success).toBe(false);
  });
});

describe('dates', () => {
  it('IsoDate and IsoDateTime', () => {
    expect(IsoDate.safeParse('2026-11-02').success).toBe(true);
    expect(IsoDate.safeParse('2026-13-01').success).toBe(false);
    expect(IsoDate.safeParse('2026-02-30').success).toBe(false);
    expect(IsoDateTime.safeParse('2026-11-02T10:00:00Z').success).toBe(true);
    expect(IsoDateTime.safeParse('2026-11-02T10:00:00+01:00').success).toBe(false);
    expect(IsoDateTime.safeParse('2026-11-02').success).toBe(false);
  });
});

describe('Q', () => {
  const ok = (s: string) => Q.safeParse(s).success;
  it('counts code points after trimming', () => {
    expect(ok('a'.repeat(100))).toBe(true);
    expect(ok('a'.repeat(101))).toBe(false);
    expect(ok('😀'.repeat(100))).toBe(true);
    expect(ok('😀'.repeat(101))).toBe(false);
    expect(ok(`  ${'a'.repeat(100)}  `)).toBe(true);
  });
  it('trims and refuses empty, blank, control and ill-formed', () => {
    expect(Q.parse('  rijks  ')).toBe('rijks');
    expect(ok('')).toBe(false);
    expect(ok('   ')).toBe(false);
    expect(ok('a\u0000b')).toBe(false);
    expect(ok('a\nb')).toBe(false);
    expect(ok('a\ud800b')).toBe(false);
    expect(ok('a'.repeat(1001))).toBe(false);
    expect(ok(`${' '.repeat(950)}abc${' '.repeat(100)}`)).toBe(false);
  });
});

describe('coordinates', () => {
  const lat = (s: string) => LatParam.safeParse(s);
  const lon = (s: string) => LonParam.safeParse(s);
  it('accepts up to 3 decimals inside the box, edges inclusive', () => {
    expect(lat('52.123')).toMatchObject({ success: true, data: 52.123 });
    expect(lat('52')).toMatchObject({ success: true, data: 52 });
    expect(lat('50.7').success).toBe(true);
    expect(lat('53.7').success).toBe(true);
    expect(lat('50.699').success).toBe(false);
    expect(lat('53.701').success).toBe(false);
    expect(lon('3.2').success).toBe(true);
    expect(lon('7.3').success).toBe(true);
    expect(lon('3.199').success).toBe(false);
    expect(lon('7.301').success).toBe(false);
    expect(lon('4.885').success).toBe(true);
  });
  it('refuses 4 decimals and odd number forms', () => {
    for (const s of [
      '52.1234',
      '5e1',
      '5.2e1',
      'NaN',
      'Infinity',
      '-Infinity',
      '+52',
      '52.',
      '.5',
      '',
      ' 52',
      '0x34',
    ]) {
      expect(lat(s).success, s).toBe(false);
    }
    for (const s of ['4.8851', '4e0', 'NaN', 'Infinity', '+4', '4.', '.5', '']) {
      expect(lon(s).success, s).toBe(false);
    }
  });
});

describe('Limit', () => {
  it('parses 1..50 and defaults to 20', () => {
    expect(Limit.parse('1')).toBe(1);
    expect(Limit.parse('50')).toBe(50);
    expect(Limit.parse(undefined)).toBe(20);
    for (const s of ['0', '51', '05', '1.0', '', '-1', '100', 'a', '+5', '5 ']) {
      expect(Limit.safeParse(s).success, s).toBe(false);
    }
  });
});

describe('queries', () => {
  it('MuseumListQuery defaults and parses', () => {
    expect(MuseumListQuery.parse({})).toEqual({ sort: 'rank', limit: 20 });
    expect(
      MuseumListQuery.parse({
        q: ' rijks ',
        province: 'NL-NH',
        municipality: 'GM0363',
        category: 'art',
        mk: 'participating',
        sort: 'name',
        limit: '5',
        cursor: 'abc',
      }),
    ).toEqual({
      q: 'rijks',
      province: 'NL-NH',
      municipality: 'GM0363',
      category: 'art',
      mk: 'participating',
      sort: 'name',
      limit: 5,
      cursor: 'abc',
    });
  });
  it('refuses bad values and unknown parameters', () => {
    for (const bad of [
      { mk: 'left' },
      { mk: '' },
      { province: 'NL-XX' },
      { province: 'nl-nh' },
      { municipality: 'GM123' },
      { category: 'x' },
      { sort: 'rating' },
      { limit: '0' },
      { cursor: 'a b' },
      { cursor: '' },
      { cursor: 'a'.repeat(4097) },
      { extra: '1' },
    ]) {
      expect(MuseumListQuery.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('accepts a cursor of up to 4096 characters (the worst 250-character key encodes to about 2,100)', () => {
    expect(MuseumListQuery.safeParse({ cursor: 'a'.repeat(4096) }).success).toBe(true);
    expect(MuseumListQuery.safeParse({ cursor: 'a'.repeat(4097) }).success).toBe(false);
  });
  it('SuggestQuery, NearQuery, EmptyQuery', () => {
    expect(SuggestQuery.safeParse({}).success).toBe(false);
    expect(SuggestQuery.parse({ q: 'ab' })).toEqual({ q: 'ab' });
    expect(SuggestQuery.safeParse({ q: 'ab', limit: '5' }).success).toBe(false);
    expect(NearQuery.parse({ lat: '52.1', lon: '4.5' })).toEqual({ lat: 52.1, lon: 4.5, limit: 20 });
    expect(NearQuery.safeParse({ lat: '52.1' }).success).toBe(false);
    expect(NearQuery.safeParse({ lat: '52.1234', lon: '4.5' }).success).toBe(false);
    expect(NearQuery.safeParse({ lat: '52.1', lon: '4.5', x: '1' }).success).toBe(false);
    expect(EmptyQuery.safeParse({}).success).toBe(true);
    expect(EmptyQuery.safeParse({ a: '1' }).success).toBe(false);
  });
});

describe('SlugParam', () => {
  it.each([
    ['a', true],
    ['rijks-museum-2', true],
    ['-a', false],
    ['a-', false],
    ['a--b', false],
    ['Abc', false],
    ['a_b', false],
    ['', false],
    ['a'.repeat(120), true],
    ['a'.repeat(121), false],
  ])('%s -> %s', (s, valid) => {
    expect(SlugParam.safeParse(s).success).toBe(valid);
  });
});
