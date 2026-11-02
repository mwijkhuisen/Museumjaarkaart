import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { LIMITS, NL_BOX, POSTCODE } from '../../../src/museums/fields.ts';
import { parseFixtureMeta } from '../../../src/museums/sources/fixture-meta.ts';
import { parseRce, RCE_PROPS, RCE_TYPE_NAME, RCE_WFS_URL, rceUrl } from '../../../src/museums/sources/rce.ts';
import type { ParseResult, RceRow } from '../../../src/museums/sources/types.ts';
import { allStrings, CASES, CH, FORBIDDEN_CHARS, fixturePath, goldenText, readFixture, readMeta } from './golden.ts';

type Rows = Extract<ParseResult<RceRow>, { ok: true }>;

function ok(result: ParseResult<RceRow>): Rows {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

const parseCase = (name: (typeof CASES)[number]): Rows => ok(parseRce(readFixture('rce', name)));

function must(condition: boolean, what: string): void {
  if (!condition) throw new Error(`invariant broken: ${what}`);
}
const chars = (s: string): number => [...s].length;

function assertResult(result: ParseResult<RceRow>): void {
  if (!result.ok) {
    must(result.code === 'schema', 'schema code');
    return;
  }
  let previous: string | undefined;
  for (const row of result.rows) {
    must(row.rceId !== '' && chars(row.rceId) <= LIMITS.rceId, 'rce id');
    must(previous === undefined || previous < row.rceId, 'sorted and unique');
    previous = row.rceId;
    must(row.name !== '' && chars(row.name) <= LIMITS.label, 'name');
    for (const s of allStrings(row)) must(!FORBIDDEN_CHARS.test(s) && s === s.normalize('NFC'), 'clean text');
    must(row.street === null || chars(row.street) <= LIMITS.street, 'street');
    must(row.houseNumber === null || chars(row.houseNumber) <= LIMITS.houseNumber, 'house number');
    must(row.postcode === null || POSTCODE.test(row.postcode), 'postcode');
    must(row.place === null || chars(row.place) <= LIMITS.place, 'place');
    must(row.municipalityName === null || chars(row.municipalityName) <= LIMITS.municipalityName, 'municipality');
    must((row.lat === null) === (row.lon === null), 'lat and lon together');
    if (row.lat !== null && row.lon !== null) {
      must(row.lat >= NL_BOX.latMin && row.lat <= NL_BOX.latMax, 'lat in the box');
      must(row.lon >= NL_BOX.lonMin && row.lon <= NL_BOX.lonMax, 'lon in the box');
    }
  }
  for (const n of [...Object.values(result.invalid), ...Object.values(result.notes)]) {
    must(Number.isInteger(n) && n > 0, 'counts');
  }
}

const feature = (properties: Record<string, unknown>, geometry: unknown = null, id: unknown = 'overzichtmusea.1') => ({
  type: 'Feature',
  id,
  geometry,
  properties,
});
const collection = (features: unknown[]) => ({ type: 'FeatureCollection', features });
const point = (x: unknown, y: unknown) => ({ type: 'Point', coordinates: [x, y] });
const named = (extra: Record<string, unknown> = {}) => ({ [RCE_PROPS.name]: 'Museum', ...extra });

describe('fixtures', () => {
  it.each(CASES)('%s: parses, holds the invariants and matches its golden file', async (name) => {
    const result = parseRce(readFixture('rce', name));
    assertResult(result);
    expect(result.ok).toBe(true);
    await expect(goldenText(result)).toMatchFileSnapshot(fixturePath('rce', name, 'golden.json'));
  });

  it.each(CASES)('%s: has a valid meta file', (name) => {
    const meta = parseFixtureMeta(readMeta('rce', name));
    expect(meta).toMatchObject({ source: 'rce', case: name, licence: 'PDM-1.0' });
    expect(meta?.querySha256).toBeUndefined();
  });

  it.each(CASES)('%s: every parsed coordinate lies inside the NL box', (name) => {
    for (const row of parseCase(name).rows) {
      if (row.lat === null || row.lon === null) continue;
      expect(row.lat).toBeGreaterThanOrEqual(NL_BOX.latMin);
      expect(row.lat).toBeLessThanOrEqual(NL_BOX.latMax);
      expect(row.lon).toBeGreaterThanOrEqual(NL_BOX.lonMin);
      expect(row.lon).toBeLessThanOrEqual(NL_BOX.lonMax);
    }
  });

  it('normal: 40 features with coordinates, postcodes and no problems', () => {
    const r = parseCase('normal');
    expect(r.rows).toHaveLength(40);
    expect(r.invalid).toEqual({});
    expect(r.notes).toEqual({});
    expect(r.rows.every((x) => x.lat !== null && x.postcode !== null && x.street !== null)).toBe(true);
    expect(r.rows.map((x) => x.rceId)).toEqual(r.rows.map((x) => x.rceId).sort());
  });

  it('normal: the notes of the meta file name every row', () => {
    const meta = parseFixtureMeta(readMeta('rce', 'normal'));
    const ids = new Set(parseCase('normal').rows.map((x) => x.rceId));
    const named = new Set(meta?.notes?.match(/overzichtmusea\.[0-9]+/g));
    expect(named).toEqual(ids);
    expect(meta?.notes?.match(/=Q[0-9]+\|Q[0-9]+/g)).toHaveLength(5);
  });

  it('empty: a valid FeatureCollection with no features', () => {
    expect(parseCase('empty')).toEqual({ ok: true, rows: [], invalid: {}, notes: {} });
  });

  it('edge: counts what it drops and what it keeps', () => {
    const r = parseCase('edge');
    expect(r.invalid).toEqual({ bad_feature: 1, duplicate_id: 1, name_too_long: 1, no_id: 1, no_name: 1 });
    const byId = (id: string) => r.rows.find((x) => x.rceId === id);
    expect(byId('overzichtmusea.901')).toMatchObject({ lat: 52.3676, lon: 4.9041 });
    expect(byId('overzichtmusea.902')).toMatchObject({ lat: null, lon: null });
    expect(byId('overzichtmusea.903')).toMatchObject({ lat: null, lon: null });
    expect(byId('overzichtmusea.905')?.name).toBe('Museum Dubbel Een');
    expect(byId('overzichtmusea.907')?.postcode).toBeNull();
    expect(byId('M-0042')).toMatchObject({ houseNumber: '12', postcode: '8911 AB', name: 'Museum Eigen Sleutel' });
    expect(byId('overzichtmusea.909')).toMatchObject({ lat: null, lon: null });
    expect(byId('overzichtmusea.912')).toMatchObject({ lat: 51.4, lon: 3.2 });
    expect(byId('overzichtmusea.913')).toMatchObject({ lat: null, lon: null });
    expect(byId('overzichtmusea.914')).toMatchObject({ lat: null, lon: null });
    expect(r.notes).toEqual({
      coord_outside_nl: 2,
      coord_swapped: 1,
      coord_unparsed: 2,
      postcode_invalid: 1,
    });
  });

  it('hostile: nothing dangerous survives ingest', () => {
    const r = parseCase('hostile');
    expect(r.invalid).toEqual({ name_too_long: 1 });
    for (const s of allStrings(r.rows)) expect(FORBIDDEN_CHARS.test(s)).toBe(false);
    const names = r.rows.map((x) => x.name);
    expect(names).toContain('</script><script>alert(1)</script>');
    expect(names).toContain('<img src=x onerror=alert(1)>');
    expect(names).toContain('gnitset Museum');
    expect(names).toContain('Museum');
    expect(names).toContain('Museum Met Regels');
    expect(names).toContain('Museum');
    const noisy = r.rows.find((x) => x.rceId === 'overzichtmusea.804');
    expect(noisy).toMatchObject({
      street: '<b>Straat</b>',
      houseNumber: '4',
      postcode: '1011 AB',
      place: 'Amsterdam',
      municipalityName: 'Amsterdam',
    });
    expect(r.rows.find((x) => x.rceId === 'overzichtmusea.808')?.street).toBeNull();
    expect(r.rows.some((x) => x.rceId.includes(CH.rlo))).toBe(false);
  });
});

describe('the request', () => {
  it('is one WFS 2.0 GetFeature for the museum layer as GeoJSON in EPSG:4326', () => {
    const url = new URL(rceUrl());
    expect(`${url.origin}${url.pathname}`).toBe(RCE_WFS_URL);
    expect(url.hostname).toBe('services.rce.geovoorziening.nl');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      service: 'WFS',
      version: '2.0.0',
      request: 'GetFeature',
      typeNames: RCE_TYPE_NAME,
      outputFormat: 'application/json',
      srsName: 'EPSG:4326',
    });
    expect(RCE_TYPE_NAME).toMatch(/:overzichtmusea$/);
  });
});

describe('the parser: envelope', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['an empty object', {}],
    ['the wrong type', { type: 'Feature', features: [] }],
    ['no features', { type: 'FeatureCollection' }],
    ['features that are not an array', { type: 'FeatureCollection', features: {} }],
    ['an OGC exception report', { exceptions: [{ code: 'InvalidParameterValue' }] }],
  ])('rejects %s with schema', (_label, json) => {
    expect(parseRce(json)).toEqual({ ok: false, code: 'schema' });
  });

  it('uses the feature id as the key, unless a property holds one', () => {
    const r = ok(
      parseRce(
        collection([
          feature(named(), null, 'overzichtmusea.7'),
          feature(named({ [RCE_PROPS.id]: 'X-1' }), null, 'overzichtmusea.8'),
          feature(named(), null, 42),
        ]),
      ),
    );
    expect(r.rows.map((x) => x.rceId)).toEqual(['42', 'X-1', 'overzichtmusea.7']);
  });

  it('drops features that cannot be used, and says why', () => {
    const r = ok(
      parseRce(
        collection([
          null,
          'x',
          { type: 'Feature', id: 'a' },
          { type: 'Feature', id: 'b', properties: [] },
          feature({ [RCE_PROPS.name]: 7 }, null, 'c'),
          feature({ [RCE_PROPS.name]: '  ' }, null, 'd'),
          feature(named(), null, null),
          feature(named(), null, 'x'.repeat(65)),
          feature(named(), null, ' '),
          feature({ [RCE_PROPS.name]: 'n'.repeat(251) }, null, 'e'),
          feature(named(), null, 'ok'),
        ]),
      ),
    );
    expect(r.invalid).toEqual({ bad_feature: 4, id_too_long: 1, name_too_long: 1, no_id: 2, no_name: 2 });
    expect(r.rows.map((x) => x.rceId)).toEqual(['ok']);
  });

  it('keeps the first of two features with one key', () => {
    const r = ok(
      parseRce(
        collection([
          feature(named({ [RCE_PROPS.name]: 'Een' }), null, 'k'),
          feature(named({ [RCE_PROPS.name]: 'Twee' }), null, 'k'),
        ]),
      ),
    );
    expect(r.rows.map((x) => x.name)).toEqual(['Een']);
    expect(r.invalid).toEqual({ duplicate_id: 1 });
  });

  it('sorts by rceId whatever the order of the features', () => {
    const features = ['c', 'a', 'b', 'a10', 'a9'].map((id) => feature(named(), null, id));
    const forward = ok(parseRce(collection(features)));
    expect(forward.rows.map((x) => x.rceId)).toEqual(['a', 'a10', 'a9', 'b', 'c']);
    expect(parseRce(collection([...features].reverse()))).toEqual(forward);
  });
});

describe('the parser: coordinates', () => {
  const coordsOf = (geometry: unknown) => {
    const r = ok(parseRce(collection([feature(named(), geometry)])));
    return { row: r.rows[0], notes: r.notes };
  };

  it('read GeoJSON order, longitude first', () => {
    expect(coordsOf(point(4.9041, 52.3676))).toMatchObject({ row: { lat: 52.3676, lon: 4.9041 }, notes: {} });
    expect(coordsOf({ type: 'Point', coordinates: [4.9, 52.3, 12] })).toMatchObject({ row: { lat: 52.3, lon: 4.9 } });
  });

  it('detect a swapped pair, which cannot be mistaken in the Netherlands', () => {
    expect(coordsOf(point(52.3676, 4.9041))).toMatchObject({
      row: { lat: 52.3676, lon: 4.9041 },
      notes: { coord_swapped: 1 },
    });
    fc.assert(
      fc.property(
        fc.double({ min: NL_BOX.latMin, max: NL_BOX.latMax, noNaN: true }),
        fc.double({ min: NL_BOX.lonMin, max: NL_BOX.lonMax, noNaN: true }),
        (lat, lon) => {
          const straight = coordsOf(point(lon, lat));
          const swapped = coordsOf(point(lat, lon));
          expect(straight.row).toMatchObject({ lat: expect.any(Number) });
          expect(swapped.row).toEqual(straight.row);
          expect(straight.notes).toEqual({});
          expect(swapped.notes).toEqual({ coord_swapped: 1 });
        },
      ),
    );
  });

  it.each([
    ['RD New metres', point(121000, 487000)],
    ['London', point(-0.1276, 51.5072)],
    ['Bonaire', point(-68.27, 12.15)],
    ['the origin', point(0, 0)],
    ['just west of the box', point(3.19, 52)],
    ['just east of the box', point(7.31, 52)],
    ['just south of the box', point(5, 50.69)],
    ['just north of the box', point(5, 53.71)],
    ['two latitudes', point(52, 52)],
    ['two longitudes', point(5, 5)],
  ])('drop %s with coord_outside_nl', (_label, geometry) => {
    expect(coordsOf(geometry)).toMatchObject({ row: { lat: null, lon: null }, notes: { coord_outside_nl: 1 } });
    expect(coordsOf(geometry).notes.coord_swapped).toBeUndefined();
  });

  it('keep the edges of the box', () => {
    expect(coordsOf(point(3.2, 50.7))).toMatchObject({ row: { lat: 50.7, lon: 3.2 } });
    expect(coordsOf(point(7.3, 53.7))).toMatchObject({ row: { lat: 53.7, lon: 7.3 } });
  });

  it.each([
    ['text', point('5', '52')],
    ['null parts', point(null, 52)],
    ['one number', { type: 'Point', coordinates: [5] }],
    ['no coordinates', { type: 'Point' }],
    ['a polygon', { type: 'Polygon', coordinates: [[[5, 52]]] }],
    ['a multipoint', { type: 'MultiPoint', coordinates: [[5, 52]] }],
    ['a string', 'Point(5 52)'],
    ['a number', 7],
  ])('drop %s with coord_unparsed', (_label, geometry) => {
    expect(coordsOf(geometry)).toMatchObject({ row: { lat: null, lon: null }, notes: { coord_unparsed: 1 } });
  });

  it('keep a feature without a geometry', () => {
    expect(coordsOf(null)).toMatchObject({ row: { name: 'Museum', lat: null, lon: null }, notes: {} });
    expect(coordsOf(undefined)).toMatchObject({ row: { lat: null, lon: null }, notes: {} });
  });
});

describe('the parser: address fields', () => {
  const rowOf = (props: Record<string, unknown>) => ok(parseRce(collection([feature(named(props))]))).rows[0] as RceRow;

  it('maps the property table', () => {
    expect(
      rowOf({
        [RCE_PROPS.street]: 'Museumplein',
        [RCE_PROPS.houseNumber]: '6',
        [RCE_PROPS.postcode]: '1071dj',
        [RCE_PROPS.place]: 'Amsterdam',
        [RCE_PROPS.municipality]: 'Amsterdam',
      }),
    ).toMatchObject({
      name: 'Museum',
      street: 'Museumplein',
      houseNumber: '6',
      postcode: '1071 DJ',
      place: 'Amsterdam',
      municipalityName: 'Amsterdam',
    });
  });

  it('accepts a numeric house number and nothing else that is not text', () => {
    expect(rowOf({ [RCE_PROPS.houseNumber]: 12 }).houseNumber).toBe('12');
    for (const bad of [1.5, -1, null, true, {}, [], Number.NaN]) {
      expect(rowOf({ [RCE_PROPS.houseNumber]: bad }).houseNumber).toBeNull();
    }
  });

  it('turns empty values into null and notes over-long ones', () => {
    const r = ok(
      parseRce(
        collection([
          feature(
            named({
              [RCE_PROPS.street]: '  ',
              [RCE_PROPS.place]: 'p'.repeat(101),
              [RCE_PROPS.houseNumber]: 'h'.repeat(21),
            }),
          ),
        ]),
      ),
    );
    expect(r.rows[0]).toMatchObject({ street: null, place: null, houseNumber: null });
    expect(r.notes).toEqual({ house_number_too_long: 1, place_too_long: 1 });
  });

  it('drops a postcode that is not one', () => {
    for (const bad of ['12345', 'abc', '1071 D', 1071]) {
      const r = ok(parseRce(collection([feature(named({ [RCE_PROPS.postcode]: bad }))])));
      expect(r.rows[0]?.postcode).toBeNull();
      expect(r.notes).toEqual({ postcode_invalid: 1 });
    }
  });
});

describe('robustness', () => {
  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        assertResult(parseRce(json));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        assertResult(parseRce(anything));
      }),
      { numRuns: 300 },
    );
  });

  it('never throws, and holds its invariants, on collections of arbitrary features', () => {
    const text = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 40 }),
      fc.constantFrom('1071 DJ', '</script>', `${CH.rlo}${CH.nul}`, 'Museum'),
    );
    const value = fc.oneof(text, fc.integer(), fc.constant(null), fc.jsonValue());
    const geometry = fc.oneof(
      fc.constant(null),
      fc.jsonValue(),
      fc
        .tuple(
          fc.oneof(fc.double({ min: 0, max: 200000 }), fc.double({ min: -180, max: 180 })),
          fc.oneof(fc.double({ min: 0, max: 600000 }), fc.double({ min: -90, max: 90 })),
        )
        .map(([x, y]) => point(x, y)),
      fc.tuple(fc.double({ min: 3, max: 8 }), fc.double({ min: 50, max: 54 })).map(([x, y]) => point(x, y)),
      fc.tuple(fc.double({ min: 50, max: 54 }), fc.double({ min: 3, max: 8 })).map(([x, y]) => point(x, y)),
    );
    const props = fc.dictionary(fc.constantFrom(...Object.values(RCE_PROPS), 'extra'), value);
    const feat = fc.record({
      type: fc.constant('Feature'),
      id: fc.oneof(text, fc.nat(), fc.constant(null)),
      geometry,
      properties: props,
    });
    fc.assert(
      fc.property(fc.array(feat, { maxLength: 15 }), (features) => {
        const result = parseRce(collection(features));
        expect(result.ok).toBe(true);
        assertResult(result);
      }),
      { numRuns: 400 },
    );
  });

  describe('mutated fixtures', () => {
    const clone = <T>(x: T): T => structuredClone(x);
    const featuresOf = (j: unknown) => (j as { features: Record<string, unknown>[] }).features;
    const nasty: unknown[] = [
      null,
      0,
      -1,
      1e308,
      'x',
      '',
      true,
      [],
      {},
      [[]],
      { type: 'Point' },
      { type: 'Point', coordinates: [] },
    ];

    it.each(['normal', 'edge', 'hostile'] as const)(
      '%s: dropping, retyping, truncating and duplicating never throws',
      (name) => {
        const base = readFixture('rce', name);
        const n = featuresOf(base).length;
        const variants: unknown[] = [];
        for (const value of [undefined, ...nasty]) {
          const j = clone(base) as Record<string, unknown>;
          if (value === undefined) delete j.features;
          else j.features = value;
          variants.push(j);
          const k = clone(base) as Record<string, unknown>;
          if (value === undefined) delete k.type;
          else k.type = value;
          variants.push(k);
        }
        for (const take of [0, 1, Math.floor(n / 2), n - 1]) {
          const j = clone(base);
          featuresOf(j).length = take;
          variants.push(j);
        }
        const doubled = clone(base);
        featuresOf(doubled).push(...clone(featuresOf(base)));
        variants.push(doubled);
        const reversed = clone(base);
        featuresOf(reversed).reverse();
        variants.push(reversed);
        for (let row = 0; row < Math.min(n, 8); row++) {
          const feature = featuresOf(base)[row] ?? {};
          for (const key of Object.keys(feature)) {
            const j = clone(base);
            delete featuresOf(j)[row]?.[key];
            variants.push(j);
            for (const value of nasty) {
              const k = clone(base);
              (featuresOf(k)[row] as Record<string, unknown>)[key] = value;
              variants.push(k);
            }
          }
          for (const key of Object.keys((feature.properties as Record<string, unknown> | null) ?? {})) {
            const j = clone(base);
            const props = featuresOf(j)[row]?.properties as Record<string, unknown> | undefined;
            if (props !== undefined) delete props[key];
            variants.push(j);
            for (const value of nasty) {
              const k = clone(base);
              ((featuresOf(k)[row] as Record<string, unknown>).properties as Record<string, unknown>)[key] = value;
              variants.push(k);
            }
          }
        }
        expect(variants.length).toBeGreaterThan(80);
        for (const v of variants) assertResult(parseRce(v));
      },
      30_000,
    );

    it('a duplicated fixture gives the same rows as the original', () => {
      const base = readFixture('rce', 'normal');
      const twice = clone(base);
      featuresOf(twice).push(...clone(featuresOf(base)));
      const once = ok(parseRce(base));
      const both = ok(parseRce(twice));
      expect(both.rows).toEqual(once.rows);
      expect(both.invalid).toEqual({ duplicate_id: 40 });
    });
  });
});
