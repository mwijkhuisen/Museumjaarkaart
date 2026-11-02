import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CBS_CODE, LIMITS, NL_BOX, POSTCODE, PROVINCE_CODE, QID } from '../../../src/museums/fields.ts';
import { MUSEUMNL_HOST } from '../../../src/museums/museumnl.ts';
import { parseFixtureMeta } from '../../../src/museums/sources/fixture-meta.ts';
import type { ParseResult, WikidataRow } from '../../../src/museums/sources/types.ts';
import {
  FIELD_SEP,
  parseWikidata,
  RECORD_SEP,
  wikidataQuery,
  wikidataQuerySha256,
  wikidataQueryText,
} from '../../../src/museums/sources/wikidata.ts';
import {
  allStrings,
  CASES,
  CH,
  type FixtureCase,
  FORBIDDEN_CHARS,
  fixturePath,
  goldenText,
  readFixture,
  readMeta,
} from './golden.ts';

const LINK_OUT_HOST = MUSEUMNL_HOST;
const ENTITY = 'http://www.wikidata.org/entity/';
const FILEPATH = 'http://commons.wikimedia.org/wiki/Special:FilePath/';

type Rows = Extract<ParseResult<WikidataRow>, { ok: true }>;

function ok(result: ParseResult<WikidataRow>): Rows {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
  return result;
}

const parseCase = (name: FixtureCase): Rows => ok(parseWikidata(readFixture('wikidata', name)));

const cell = (value: string) => ({ type: 'literal', value });
const doc = (bindings: unknown[]) => ({ head: { vars: ['item'] }, results: { bindings } });
/** One item with a Dutch label plus the given raw variables. */
function item(extra: Record<string, string> = {}, qid = 'Q1', label: string | null = 'Museum') {
  return {
    item: { type: 'uri', value: `${ENTITY}${qid}` },
    ...(label === null ? {} : { labelNl: { type: 'literal', 'xml:lang': 'nl', value: label } }),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, cell(v)])),
  };
}
const only = (extra: Record<string, string>): WikidataRow => {
  const r = ok(parseWikidata(doc([item(extra)])));
  expect(r.rows).toHaveLength(1);
  return r.rows[0] as WikidataRow;
};

/** Cheap check for the property tests: thousands of rows, so no expect() per field. */
function must(condition: boolean, what: string): void {
  if (!condition) throw new Error(`invariant broken: ${what}`);
}
const chars = (s: string): number => [...s].length;
const isSortedUnique = (xs: readonly string[]): boolean => xs.every((x, i) => i === 0 || (xs[i - 1] as string) < x);

/** What every row of every result must satisfy, whatever the input. */
function assertRows(rows: readonly WikidataRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    must(QID.test(row.qid), 'qid');
    must(!seen.has(row.qid), 'unique qid');
    seen.add(row.qid);
    for (const s of allStrings(row)) {
      must(!FORBIDDEN_CHARS.test(s), `forbidden character in ${row.qid}`);
      must(s === s.normalize('NFC'), 'NFC');
    }
    must(row.name !== '' && chars(row.name) <= LIMITS.label, 'name');
    must(row.nameEn === null || chars(row.nameEn) <= LIMITS.label, 'nameEn');
    for (const d of [row.descriptionNl, row.descriptionEn])
      must(d === null || chars(d) <= LIMITS.description, 'description');
    must(isSortedUnique(row.aliases) && !row.aliases.includes(row.name), 'aliases');
    must(row.aliases.length <= 50 && row.aliases.every((a) => chars(a) <= LIMITS.alias), 'alias cap');
    must((row.lat === null) === (row.lon === null), 'lat and lon together');
    if (row.lat !== null && row.lon !== null) {
      must(row.lat >= NL_BOX.latMin && row.lat <= NL_BOX.latMax, 'lat in the box');
      must(row.lon >= NL_BOX.lonMin && row.lon <= NL_BOX.lonMax, 'lon in the box');
    }
    if (row.website !== null) {
      const url = new URL(row.website);
      must(url.protocol === 'https:' && url.username === '' && url.password === '', 'website');
      must(row.website.length <= LIMITS.url, 'website length');
    }
    must(row.museumnlUrl === null || new URL(row.museumnlUrl).hostname === LINK_OUT_HOST, 'link-out host');
    must(row.street === null || chars(row.street) <= LIMITS.street, 'street');
    must(row.houseNumber === null || chars(row.houseNumber) <= LIMITS.houseNumber, 'house number');
    must(row.postcode === null || POSTCODE.test(row.postcode), 'postcode');
    must(row.place === null || chars(row.place) <= LIMITS.place, 'place');
    must(row.municipalityCode === null || CBS_CODE.test(row.municipalityCode), 'municipality code');
    must(
      row.municipalityCode !== null || (row.municipalityName === null && row.provinceCode === null),
      'municipality parts',
    );
    must(row.municipalityName === null || chars(row.municipalityName) <= LIMITS.municipalityName, 'municipality name');
    must(row.provinceCode === null || PROVINCE_CODE.test(row.provinceCode), 'province');
    must(
      row.commonsFile === null ||
        (!/[#<>[\]|{}/]/.test(row.commonsFile) &&
          !/^https?:/.test(row.commonsFile) &&
          chars(row.commonsFile) <= LIMITS.commonsFile),
      'commons file',
    );
    must(row.classes.every((c) => QID.test(c)) && isSortedUnique(row.classes), 'classes');
    must(row.dissolvedOn === null || /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(row.dissolvedOn), 'dissolved');
  }
}

function assertResult(result: ParseResult<WikidataRow>): void {
  if (!result.ok) {
    must(result.code === 'schema', 'schema code');
    return;
  }
  assertRows(result.rows);
  for (const n of [...Object.values(result.invalid), ...Object.values(result.notes)]) {
    must(Number.isInteger(n) && n > 0, 'counts');
  }
}

describe('fixtures', () => {
  it.each(CASES)('%s: parses, holds the invariants and matches its golden file', async (name) => {
    const result = parseWikidata(readFixture('wikidata', name));
    assertResult(result);
    expect(result.ok).toBe(true);
    await expect(goldenText(result)).toMatchFileSnapshot(fixturePath('wikidata', name, 'golden.json'));
  });

  it.each(CASES)('%s: has a valid meta file written for this query', (name) => {
    const meta = parseFixtureMeta(readMeta('wikidata', name));
    expect(meta).toMatchObject({ source: 'wikidata', case: name, licence: 'CC0-1.0' });
    expect(meta?.querySha256).toBe(wikidataQuerySha256());
  });

  it('pins the query: changing wikidata.sparql changes its sha256 and forces a re-recording', () => {
    const meta = parseFixtureMeta(readMeta('wikidata', 'normal'));
    expect(wikidataQuerySha256()).toMatch(/^[0-9a-f]{64}$/);
    expect(meta?.querySha256).toBe(wikidataQuerySha256());
  });

  it('normal: about 60 items, most with coordinates, some without', () => {
    const r = parseCase('normal');
    expect(r.rows).toHaveLength(60);
    expect(r.invalid).toEqual({});
    expect(r.rows.map((x) => x.qid)).toEqual(
      r.rows.map((x) => x.qid).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)),
    );
    const withCoords = r.rows.filter((x) => x.lat !== null).length;
    expect(withCoords).toBeGreaterThanOrEqual(50);
    expect(withCoords).toBeLessThan(60);
    expect(r.rows.filter((x) => x.registered).length).toBeGreaterThanOrEqual(15);
    expect(r.rows.filter((x) => x.museumnlUrl !== null).length).toBeGreaterThanOrEqual(8);
    expect(r.rows.filter((x) => x.commonsFile !== null).length).toBeGreaterThanOrEqual(25);
    expect(r.rows.filter((x) => x.postcode !== null && x.street === null).length).toBeGreaterThanOrEqual(3);
    expect(r.notes.address_parsed).toBeGreaterThan(40);
    expect(r.notes.address_unparsed).toBeUndefined();
  });

  it('empty: a valid envelope with no rows', () => {
    expect(parseCase('empty')).toEqual({ ok: true, rows: [], invalid: {}, notes: {} });
  });

  it('edge: counts what it drops and what it keeps', () => {
    const r = parseCase('edge');
    expect(r.invalid).toEqual({ bad_qid: 2, bad_row: 2, no_label: 1 });
    const byName = (name: string) => r.rows.find((x) => x.name === name);
    expect(byName('Museum Zonder Plek')).toMatchObject({
      lat: null,
      lon: null,
      street: 'Voorbeeldlaan',
      postcode: '1234 AB',
    });
    expect(byName('Oud Museum Opgeheven')?.dissolvedOn).toBe('2019-12-31');
    expect(r.rows.filter((x) => x.name === 'Stedelijk Museum').map((x) => x.municipalityName)).toEqual([
      'Zwolle',
      'Maastricht',
      'Middelburg',
    ]);
    expect(byName('Museum Met Twee Foto’s')?.commonsFile).toBe('Voorbeeld eerste gevel.jpg');
    expect(byName('Museum Met Twee Punten')).toMatchObject({ lat: 52.3, lon: 4.9 });
    expect(byName('Museum Verkeerde Host')?.museumnlUrl).toBeNull();
    expect(byName('Museum Zonder Slot')?.website).toBeNull();
    expect(byName('Museum In Twee Rijen')).toMatchObject({
      aliases: ['Dubbelmuseum', 'Rij Twee'],
      website: 'https://www.dubbelmuseum.example/',
      lat: 51.9851,
    });
    expect(byName('Museum Over De Grens')).toMatchObject({ lat: null, lon: null });
    expect(byName('Museum Met Rommel')).toMatchObject({ street: null, commonsFile: null });
    expect(byName('Museum Met Slechte Gemeente')?.municipalityCode).toBeNull();
    expect(byName('English Only Museum')).toMatchObject({ name: 'English Only Museum', nameEn: 'English Only Museum' });
    expect(byName('Museum Met Lange Omschrijving')).toMatchObject({ descriptionNl: null, aliases: ['Korte alias'] });
    expect(byName('Museum Met Twee Adressen')).toMatchObject({
      street: 'Anderestraat',
      postcode: '2011 AB',
      place: 'Elders',
    });
    expect(byName('Museum Met Postcode Alleen')).toMatchObject({
      postcode: '1071 DJ',
      registered: true,
      municipalityCode: 'GM0363',
      provinceCode: 'NL-NH',
    });
    expect(r.notes).toEqual({
      address_parsed: 5,
      address_unparsed: 1,
      alias_too_long: 1,
      commons_file_invalid: 1,
      coord_multiple: 1,
      coord_outside_nl: 1,
      description_too_long: 1,
      dissolved_bad_date: 1,
      municipality_bad_code: 1,
      museumnl_bad_host: 1,
      postcode_invalid: 1,
      website_invalid: 1,
      website_not_https: 1,
    });
  });

  it('hostile: nothing dangerous survives ingest', () => {
    const r = parseCase('hostile');
    expect(r.invalid).toEqual({ label_too_long: 1, no_label: 1 });
    for (const s of allStrings(r.rows)) expect(FORBIDDEN_CHARS.test(s)).toBe(false);
    for (const row of r.rows) expect([...row.name].length).toBeLessThanOrEqual(LIMITS.label);
    const names = r.rows.map((x) => x.name);
    // Markup stays as plain text: the output side escapes it (invariant 5).
    expect(names).toContain('</script><script>alert(1)</script>');
    expect(names).toContain('gnitset Museum LRO iso');
    expect(names).toContain('Museum ZeroWidth');
    expect(names).toContain('Museum Met Regel eindes');
    expect(names).toContain('Museum Met Nul');
    expect(names).toContain('b'.repeat(250));
    expect(names.some((n) => n.startsWith('aaaa'))).toBe(false);
    const javascript = r.rows.find((x) => x.name === 'Museum Met Javascript');
    expect(javascript).toMatchObject({ website: null, museumnlUrl: null });
    expect(r.rows.find((x) => x.name === 'Museum Met Wachtwoord')?.website).toBeNull();
    expect(r.rows.find((x) => x.name === 'Museum Met Bestandsnaam')?.commonsFile).toBeNull();
    // An alias equal to the name (also after cleaning) is dropped; markup stays plain text.
    expect(r.rows.find((x) => x.name === 'Museum Met Markup')?.aliases).toEqual(['<i>cursief</i>', 'alias']);
  });
});

describe('the query', () => {
  const text = wikidataQueryText();

  it('selects the museums of the European Netherlands, dissolved ones included', () => {
    expect(text).toMatch(/\?class wdt:P279\* wd:Q33506 \.\s+\?item wdt:P31 \?class ;\s+wdt:P17 wd:Q55 \./);
    expect(text).toContain('wd:Q27561');
    expect(text).toMatch(/FILTER NOT EXISTS \{\s+VALUES \?caribbean/);
    expect(text).not.toMatch(/FILTER NOT EXISTS \{\s*\?item wdt:P576/);
    expect(text.match(/^SELECT/gm)).toHaveLength(1);
    expect(text).toContain('GROUP BY ?item');
  });

  // The outer WHERE starts a line; the item set's own WHERE sits indented inside the WITH block.
  const outerWhere = text.search(/^WHERE \{/m);
  const withBlock = text.slice(text.indexOf('\nWITH {'), outerWhere);
  const where = text.slice(outerWhere);

  it("collects each kind of value in its own UNION branch, so an item's rows add up instead of multiplying", () => {
    // The same values as OPTIONALs in one join made every combination of aliases, links, images and
    // classes, and ran past the WDQS 60 s limit (HTTP 504, the owner's recording on 2026-11-02).
    expect(outerWhere).toBeGreaterThan(0);
    expect(where.match(/\} UNION \{/g)).toHaveLength(15);
    // The only OPTIONALs sit inside the two municipality branches: P576, the label and the province.
    expect(where.match(/\bOPTIONAL\b/g)).toHaveLength(6);
  });

  it('starts every branch from the named item set, computed once', () => {
    // A sub-select joined to the UNION still timed out for three items (the owner's probe, 2026-11-02):
    // Blazegraph evaluated the branches over all of Wikidata.
    expect(withBlock).toContain('SELECT DISTINCT ?item WHERE {');
    expect(withBlock).toMatch(/\} AS %items\s*$/);
    expect(withBlock).toContain('?class wdt:P279* wd:Q33506 .');
    const body = where
      .slice(where.indexOf('{') + 1, where.lastIndexOf('}'))
      .replace('hint:Query hint:optimizer "None" .', '');
    const branches = body.split('} UNION {');
    expect(branches).toHaveLength(16);
    for (const branch of branches) {
      const code = branch
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .join('\n')
        .replace(/^\s*\{?\s*/, '');
      expect(code.startsWith('INCLUDE %items .'), code.slice(0, 60)).toBe(true);
    }
  });

  it('keeps the written join order, which runs every group from its bound variables', () => {
    // With 1,430 items the planner could start from another pattern: the full run took 42 s once
    // and timed out the next time, while 60 items took 1.4 s (the owner's runs, 2026-11-02).
    expect(text).toContain('PREFIX hint: <http://www.bigdata.com/queryHints#>');
    expect(where).toMatch(/^WHERE \{\n\s+hint:Query hint:optimizer "None" \.\n/);
    // The selection runs class first (the order the owner's probe timed at 1.6 s), and a restricted
    // recording's VALUES comes after it, before the Caribbean filter.
    const sel = withBlock.indexOf('?class wdt:P279* wd:Q33506');
    const marker = withBlock.indexOf('# @@MJK_VALUES@@');
    expect(sel).toBeGreaterThan(0);
    expect(marker).toBeGreaterThan(sel);
    expect(withBlock.indexOf('FILTER NOT EXISTS')).toBeGreaterThan(marker);
  });

  it('has no zero-length property path outside the item set (unbound at both ends it matches every node)', () => {
    expect(where).not.toMatch(/wdt:P\d+[?*]/);
    expect(where).toContain('?item wdt:P131 ?muni .');
    expect(where).toContain('?item wdt:P131 ?part . ?part wdt:P131 ?muni .');
  });

  it('aggregates only expressions that cannot fail (one error makes a SPARQL 1.1 aggregate an error)', () => {
    const head = text.slice(text.indexOf('SELECT ?item'), text.indexOf('\nWITH {'));
    const aggregates = head.match(/\((?:MAX|MIN|SAMPLE|GROUP_CONCAT|COUNT|SUM|AVG)\(.*\) AS \?\w+\)/g) ?? [];
    expect(aggregates).toHaveLength(15);
    for (const a of aggregates) expect(a).toMatch(/^\((?:MAX|GROUP_CONCAT)\((?:DISTINCT )?COALESCE\(/);
    expect(head).toContain('(MAX(COALESCE(?reg, "false")) AS ?registered)');
  });

  it('asks for every property the parser reads, with truthy values', () => {
    for (const p of ['P625', 'P856', 'P6375', 'P281', 'P131', 'P382', 'P300', 'P166', 'P973', 'P18', 'P31', 'P576']) {
      expect(text).toContain(`wdt:${p}`);
    }
    expect(text).toContain('wd:Q110989587');
    expect(text).not.toMatch(/\bp:P|\bps:P/);
  });

  it('keeps a comment where a restricted recording injects its VALUES', () => {
    expect(wikidataQuery()).toBe(text);
    expect(wikidataQuery({})).toBe(text);
    expect(text).toMatch(/^ *# @@MJK_VALUES@@$/m);
  });

  it('injects a VALUES list for a restricted recording', () => {
    const q = wikidataQuery({ qids: ['Q1', 'Q42'] });
    expect(q).toContain('\n  VALUES ?item { wd:Q1 wd:Q42 }\n');
    expect(q).not.toContain('@@MJK_VALUES@@');
    expect(q.length).toBeGreaterThan(text.length - 30);
    expect(wikidataQuery({ qids: [] })).toContain('VALUES ?item {  }');
  });

  it.each(['q1', 'Q0', 'Q01', 'Q1 wd:Q2', 'Q1}', '} UNION { ?s ?p ?o', '', 'wd:Q1', 'Q1\n'])(
    'throws a usage error for the QID %j, without echoing it',
    (bad) => {
      let message = '';
      try {
        wikidataQuery({ qids: ['Q1', bad] });
      } catch (e) {
        message = String((e as Error).message);
      }
      expect(message).toMatch(/^wikidata_query_usage/);
      expect(message).not.toContain(bad === '' ? '\u0000never' : bad);
    },
  );

  it('refuses a restricted recording of more than 500 items', () => {
    expect(() => wikidataQuery({ qids: Array.from({ length: 501 }, (_, i) => `Q${i + 1}`) })).toThrow(/usage/);
    expect(wikidataQuery({ qids: Array.from({ length: 500 }, (_, i) => `Q${i + 1}`) })).toContain('wd:Q500 }');
  });

  it('uses separators that cleanText removes, so a value cannot contain them', () => {
    expect(RECORD_SEP).toBe('\u001F');
    expect(FIELD_SEP).toBe('\u001E');
    expect(text).toContain('SEPARATOR="\\u001F"');
    expect(text).toContain('"\\u001E"');
  });
});

describe('the parser: envelope', () => {
  it.each([
    ['null', null],
    ['a string', 'x'],
    ['an array', []],
    ['an empty object', {}],
    ['no head', { results: { bindings: [] } }],
    ['no results', { head: { vars: [] } }],
    ['vars that are not strings', { head: { vars: [1] }, results: { bindings: [] } }],
    ['bindings that are not an array', { head: { vars: [] }, results: { bindings: {} } }],
    ['an ASK answer', { head: {}, boolean: true }],
  ])('rejects %s with schema', (_label, json) => {
    expect(parseWikidata(json)).toEqual({ ok: false, code: 'schema' });
  });

  it('counts a row that is not an object, or has a cell that is not a cell, as bad_row', () => {
    const r = ok(parseWikidata(doc([null, 5, 'x', [], { item: cell(`${ENTITY}Q1`), labelNl: 5 }, item()])));
    expect(r.invalid).toEqual({ bad_row: 5 });
    expect(r.rows.map((x) => x.qid)).toEqual(['Q1']);
  });

  it('counts a row with a missing or malformed item as bad_qid', () => {
    const r = ok(
      parseWikidata(
        doc([
          { labelNl: cell('x') },
          { item: cell('Q1') },
          { item: cell(`${ENTITY}Q0`) },
          { item: cell(`${ENTITY}Q1/../x`) },
          { item: cell('') },
          { item: { type: 'uri', value: 7 } },
        ]),
      ),
    );
    // `Q1` alone is accepted as a bare QID (and then has no label).
    expect(r.invalid).toEqual({ bad_qid: 5, no_label: 1 });
    expect(r.rows).toEqual([]);
  });

  it('merges the rows of one item and sorts the items by QID number', () => {
    const r = ok(
      parseWikidata(
        doc([
          item({}, 'Q100', 'Honderd'),
          item({ aliases: `b${RECORD_SEP}a` }, 'Q9', 'Negen'),
          item({ aliases: `c${RECORD_SEP}a` }, 'Q9', 'Negen'),
          item({}, 'Q20', 'Twintig'),
        ]),
      ),
    );
    expect(r.rows.map((x) => x.qid)).toEqual(['Q9', 'Q20', 'Q100']);
    expect(r.rows[0]?.aliases).toEqual(['a', 'b', 'c']);
  });

  it('does not depend on the order of the bindings', () => {
    const rows = [item({}, 'Q3', 'C'), item({ aliases: 'x' }, 'Q1', 'A'), item({ aliases: 'y' }, 'Q1', 'A')];
    const a = parseWikidata(doc(rows));
    const b = parseWikidata(doc([...rows].reverse()));
    expect(a).toEqual(b);
  });
});

describe('the parser: fields', () => {
  it('takes the Dutch label as the name, else the English one', () => {
    expect(only({ labelEn: 'English' })).toMatchObject({ name: 'Museum', nameEn: 'English' });
    const r = ok(parseWikidata(doc([item({ labelEn: 'Only English' }, 'Q2', null)])));
    expect(r.rows[0]).toMatchObject({ name: 'Only English', nameEn: 'Only English' });
  });

  it('drops an item without any label, or with an over-long one', () => {
    expect(ok(parseWikidata(doc([item({}, 'Q2', null)]))).invalid).toEqual({ no_label: 1 });
    expect(ok(parseWikidata(doc([item({}, 'Q2', `${CH.zwsp} `)]))).invalid).toEqual({ no_label: 1 });
    expect(ok(parseWikidata(doc([item({}, 'Q2', 'a'.repeat(251))]))).invalid).toEqual({ label_too_long: 1 });
    expect(ok(parseWikidata(doc([item({ labelEn: 'e'.repeat(251) })]))).invalid).toEqual({ label_too_long: 1 });
    expect(ok(parseWikidata(doc([item({}, 'Q2', 'a'.repeat(250))]))).rows).toHaveLength(1);
  });

  it('keeps an item whose description or alias is over its cap, and says so', () => {
    const r = ok(parseWikidata(doc([item({ descEn: 'd'.repeat(251), aliases: `${'a'.repeat(251)}${RECORD_SEP}ok` })])));
    expect(r.rows[0]).toMatchObject({ descriptionEn: null, aliases: ['ok'] });
    expect(r.notes).toEqual({ alias_too_long: 1, description_too_long: 1 });
  });

  it('does not split a label at the record separator', () => {
    expect(only({}).name).toBe('Museum');
    const r = ok(parseWikidata(doc([item({}, 'Q2', `a${RECORD_SEP}b`)])));
    expect(r.rows[0]?.name).toBe('ab');
  });

  it('collects unique sorted aliases without the name, at most 50', () => {
    const many = Array.from({ length: 80 }, (_, i) => `alias ${String(i).padStart(2, '0')}`).join(RECORD_SEP);
    const r = ok(parseWikidata(doc([item({ aliases: `${many}${RECORD_SEP}Museum${RECORD_SEP}alias 00` })])));
    expect(r.rows[0]?.aliases).toHaveLength(50);
    expect(r.rows[0]?.aliases[0]).toBe('alias 00');
    expect(r.notes).toEqual({ aliases_truncated: 1 });
  });

  describe('coordinates', () => {
    it('come from the WKT Point(lon lat)', () => {
      expect(only({ coords: 'Point(4.8999991 52.3)' })).toMatchObject({ lat: 52.3, lon: 4.899999 });
      expect(only({ coords: 'Point(5 52)' })).toMatchObject({ lat: 52, lon: 5 });
      expect(only({ coords: 'Point(5e0 5.2E1)' })).toMatchObject({ lat: 52, lon: 5 });
    });

    it.each([
      ['Point(-0.1276 51.5072)', 'coord_outside_nl'],
      ['Point(52.3 4.9)', 'coord_outside_nl'],
      ['Point(-68.27 12.15)', 'coord_outside_nl'],
      ['Point(3.1 52)', 'coord_outside_nl'],
      ['Point(7.31 52)', 'coord_outside_nl'],
      ['Point(5 50.69)', 'coord_outside_nl'],
      ['Point(5 53.71)', 'coord_outside_nl'],
      ['<http://www.wikidata.org/entity/Q405> Point(4.9 52.3)', 'coord_unparsed'],
      ['POINT(4.9)', 'coord_unparsed'],
      ['Point(a b)', 'coord_unparsed'],
      ['', null],
    ])('%j: no coordinates, note %s', (coords, note) => {
      const r = ok(parseWikidata(doc([item({ coords })])));
      expect(r.rows[0]).toMatchObject({ lat: null, lon: null });
      expect(r.notes).toEqual(note === null ? {} : { [note]: 1 });
    });

    it('keeps the box edges', () => {
      expect(only({ coords: 'Point(3.2 50.7)' })).toMatchObject({ lat: 50.7, lon: 3.2 });
      expect(only({ coords: 'Point(7.3 53.7)' })).toMatchObject({ lat: 53.7, lon: 7.3 });
    });

    it('take the first valid point of several, in sorted order', () => {
      const r = ok(
        parseWikidata(doc([item({ coords: ['Point(0 51)', 'Point(6 52)', 'Point(5 52)'].join(RECORD_SEP) })])),
      );
      expect(r.rows[0]).toMatchObject({ lat: 52, lon: 5 });
      expect(r.notes).toEqual({ coord_multiple: 1 });
    });
  });

  describe('websites and the link-out host', () => {
    it('accept https only', () => {
      expect(only({ websites: 'https://www.example.org/nl' }).website).toBe('https://www.example.org/nl');
      expect(only({ websites: 'https://example.org' }).website).toBe('https://example.org/');
      expect(only({ websites: `http://a.example/${RECORD_SEP}https://b.example/` }).website).toBe('https://b.example/');
    });

    it.each([
      ['http://example.org/', 'website_not_https'],
      ['javascript:alert(1)', 'website_not_https'],
      ['data:text/html,<script>', 'website_not_https'],
      ['ftp://example.org/', 'website_not_https'],
      ['https://user:pw@example.org/', 'website_invalid'],
      ['https://exa mple.org/', 'website_invalid'],
      ['https://example.org/\nx', 'website_invalid'],
      [`https://example.org/${CH.rlo}`, 'website_invalid'],
      ['not a url', 'website_invalid'],
      [`https://example.org/${'a'.repeat(2100)}`, 'website_invalid'],
    ])('drop %j with %s', (websites, note) => {
      const r = ok(parseWikidata(doc([item({ websites })])));
      expect(r.rows[0]?.website).toBeNull();
      expect(r.notes).toEqual({ [note]: 1 });
    });

    it('keep P973 on the link-out host only', () => {
      const host = LINK_OUT_HOST;
      expect(only({ museumnl: `https://${host}/nl/museum/x` }).museumnlUrl).toBe(`https://${host}/nl/museum/x`);
      for (const bad of [
        `http://${host}/x`,
        'https://museum.nl/x',
        `https://evil.${host}/x`,
        `https://${host}.evil.example/x`,
        `https://${host}:8443/x`,
        `https://u@${host}/x`,
        `https://${host}/x y`,
        'https://www.example.org/x',
        'javascript:alert(1)',
      ]) {
        const r = ok(parseWikidata(doc([item({ museumnl: bad })])));
        expect(r.rows[0]?.museumnlUrl).toBeNull();
        expect(r.notes).toEqual({ museumnl_bad_host: 1 });
      }
    });
  });

  describe('Commons files (P18)', () => {
    it('keep the decoded file name and never a URL', () => {
      const r = only({ images: `${FILEPATH}Voorbeeld%20gevel%20%28oud%29.jpg` });
      expect(r.commonsFile).toBe('Voorbeeld gevel (oud).jpg');
      expect(JSON.stringify(r)).not.toContain('commons.wikimedia.org');
      expect(only({ images: `https://commons.wikimedia.org/wiki/Special:FilePath/A.png` }).commonsFile).toBe('A.png');
      expect(only({ images: `${FILEPATH}%C3%A9t%C3%A9.jpg` }).commonsFile).toBe('été.jpg');
    });

    it('take the first of two in sorted order', () => {
      expect(only({ images: [`${FILEPATH}B.jpg`, `${FILEPATH}A.jpg`].join(RECORD_SEP) }).commonsFile).toBe('A.jpg');
    });

    it.each([
      ['a path', `${FILEPATH}a%2Fb.jpg`],
      ['a hash', `${FILEPATH}a%23b.jpg`],
      ['angle brackets', `${FILEPATH}%3Cscript%3E.jpg`],
      ['a bracket', `${FILEPATH}a%5Bb.jpg`],
      ['a pipe', `${FILEPATH}a%7Cb.jpg`],
      ['braces', `${FILEPATH}a%7Bb%7D.jpg`],
      ['a control character', `${FILEPATH}a%00b.jpg`],
      ['a newline', `${FILEPATH}a%0Ab.jpg`],
      ['a bidi override', `${FILEPATH}a%E2%80%AEb.jpg`],
      ['an empty name', FILEPATH],
      ['a bad escape', `${FILEPATH}%E0%A4%A`],
      ['a long name', `${FILEPATH}${'a'.repeat(256)}.jpg`],
      ['leading space', `${FILEPATH}%20a.jpg`],
      ['another host', 'http://upload.wikimedia.org/wikipedia/commons/a/ab/A.jpg'],
      ['a look-alike host', 'http://commons.wikimedia.org.evil.example/wiki/Special:FilePath/A.jpg'],
      ['plain text', 'A.jpg'],
    ])('drop %s', (_label, images) => {
      const r = ok(parseWikidata(doc([item({ images })])));
      expect(r.rows[0]?.commonsFile).toBeNull();
      expect(r.notes).toEqual({ commons_file_invalid: 1 });
    });

    it('accept a name of exactly 255 characters', () => {
      expect(only({ images: `${FILEPATH}${'a'.repeat(255)}` }).commonsFile).toBe('a'.repeat(255));
    });
  });

  describe('addresses (P6375, P281)', () => {
    it.each([
      ['Museumplein 6, 1071 DJ Amsterdam', 'Museumplein', '6', '1071 DJ', 'Amsterdam'],
      ['Dorpsstraat 12a, Ergens', 'Dorpsstraat', '12a', null, 'Ergens'],
      ['Dorpsstraat 12 a, Ergens', 'Dorpsstraat', '12 a', null, 'Ergens'],
      ['Singel 1-3, 1012 AB Amsterdam', 'Singel', '1-3', '1012 AB', 'Amsterdam'],
      ['2e Hugo de Grootstraat 14, 1052 LA Amsterdam', '2e Hugo de Grootstraat', '14', '1052 LA', 'Amsterdam'],
      ['Museumplein 6 1071 DJ Amsterdam', 'Museumplein', '6', '1071 DJ', 'Amsterdam'],
      ['Museumplein 6 1071dj', 'Museumplein', '6', '1071 DJ', null],
      ['Museumplein 6, 1071DJ', 'Museumplein', '6', '1071 DJ', null],
      ['Museumplein 6', 'Museumplein', '6', null, null],
      ['Kasteel Doorwerth, Doorwerth', 'Kasteel Doorwerth', null, null, 'Doorwerth'],
      ['  Kerkstraat\n 3 ,\t 1234 ab   Plaats ', 'Kerkstraat', '3', '1234 AB', 'Plaats'],
      ['Kerkstraat 3, 1234 AB Plaats, Nederland', 'Kerkstraat', '3', '1234 AB', 'Plaats'],
      ['Kerkstraat 3, Nederland, Plaats', 'Kerkstraat', '3', null, 'Nederland'],
    ])('parses %j', (addresses, street, houseNumber, pc, place) => {
      const r = ok(parseWikidata(doc([item({ addresses })])));
      expect(r.rows[0]).toMatchObject({ street, houseNumber, postcode: pc, place });
      expect(r.notes).toEqual({ address_parsed: 1 });
    });

    it.each([
      '?!',
      '1234',
      '12 34',
      ',',
      ', 1234 AB',
      'x'.repeat(5000),
      `${'s'.repeat(201)} 1, Plaats`,
      `Straat ${'1'.repeat(25)}`,
    ])('cannot parse %j', (addresses) => {
      const r = ok(parseWikidata(doc([item({ addresses })])));
      expect(r.rows[0]).toMatchObject({ street: null, houseNumber: null, place: null, postcode: null });
      expect(r.notes).toEqual({ address_unparsed: 1 });
    });

    it('counts nothing for an item without an address', () => {
      expect(ok(parseWikidata(doc([item()]))).notes).toEqual({});
    });

    it('uses P281 only when the address has no postcode', () => {
      expect(only({ addresses: 'Straat 1, 1111 AA Plaats', postcodes: '2222BB' }).postcode).toBe('1111 AA');
      expect(only({ addresses: 'Straat 1, Plaats', postcodes: '2222bb' })).toMatchObject({
        postcode: '2222 BB',
        street: 'Straat',
      });
      expect(only({ postcodes: '2222 BB' })).toMatchObject({ postcode: '2222 BB', street: null });
    });

    it('notes a P281 that is no postcode', () => {
      const r = ok(parseWikidata(doc([item({ postcodes: `12345${RECORD_SEP}abc` })])));
      expect(r.rows[0]?.postcode).toBeNull();
      expect(r.notes).toEqual({ postcode_invalid: 1 });
    });

    it('takes the first address that parses, in sorted order', () => {
      const r = only({ addresses: `?!${RECORD_SEP}B-straat 2, Bplaats${RECORD_SEP}A-straat 1, Aplaats` });
      expect(r).toMatchObject({ street: 'A-straat', place: 'Aplaats' });
    });
  });

  describe('the municipality', () => {
    const rec = (code: string, name = 'Amsterdam', prov = 'NL-NH') => [code, name, prov].join(FIELD_SEP);

    it('becomes GM plus four digits, with its name and province', () => {
      expect(only({ municipalities: rec('0363') })).toMatchObject({
        municipalityCode: 'GM0363',
        municipalityName: 'Amsterdam',
        provinceCode: 'NL-NH',
      });
      expect(only({ municipalities: rec('0014', 'Groningen', '') })).toMatchObject({
        municipalityCode: 'GM0014',
        provinceCode: null,
      });
    });

    it.each(['36', '00363', 'GM0363', '03 63', 'abcd', '', '0363 '])('rejects the code %j', (code) => {
      const r = ok(parseWikidata(doc([item({ municipalities: rec(code) })])));
      expect(r.rows[0]).toMatchObject({ municipalityCode: null, municipalityName: null, provinceCode: null });
      expect(r.notes).toEqual({ municipality_bad_code: 1 });
    });

    it('takes the lowest valid code, and joins the records of one code', () => {
      const r = only({
        municipalities: [
          rec('xx'),
          rec('0518', "'s-Gravenhage", 'NL-ZH'),
          rec('0363', 'Amsterdam', ''),
          rec('0363', 'Amsterdam', 'NL-NH'),
        ].join(RECORD_SEP),
      });
      expect(r).toMatchObject({ municipalityCode: 'GM0363', municipalityName: 'Amsterdam', provinceCode: 'NL-NH' });
    });

    it('drops a province code that is not NL-xx, and a name that is over its cap', () => {
      expect(only({ municipalities: rec('0363', 'Amsterdam', 'DE-BE') }).provinceCode).toBeNull();
      expect(only({ municipalities: rec('0363', 'n'.repeat(101), 'NL-NH') }).municipalityName).toBeNull();
    });
  });

  it('reads the shape of the UNION query: "" is no value and an empty record is dropped', () => {
    const r = ok(
      parseWikidata(
        doc([
          item(
            {
              labelNl: '',
              labelEn: 'Museum EN',
              descNl: '',
              descEn: 'A museum',
              aliases: `${RECORD_SEP}Alias B${RECORD_SEP}Alias A`,
              coords: '',
              websites: `https://example.org/${RECORD_SEP}`,
              municipalities: `${RECORD_SEP}0363${FIELD_SEP}Amsterdam${FIELD_SEP}NL-NH`,
              images: '',
              classes: `${RECORD_SEP}${ENTITY}Q33506`,
              registered: 'false',
              dissolved: '',
            },
            'Q1',
            null,
          ),
        ]),
      ),
    );
    expect(r.invalid).toEqual({});
    expect(r.notes).toEqual({});
    const row = r.rows[0] as WikidataRow;
    expect(row.name).toBe('Museum EN');
    expect(row.descriptionNl).toBeNull();
    expect(row.descriptionEn).toBe('A museum');
    expect(row.aliases).toEqual(['Alias A', 'Alias B']);
    expect(row.lat).toBeNull();
    expect(row.website).toBe('https://example.org/');
    expect(row.municipalityCode).toBe('GM0363');
    expect(row.commonsFile).toBeNull();
    expect(row.classes).toEqual(['Q33506']);
    expect(row.dissolvedOn).toBeNull();
  });

  it('reads the registered flag and the dissolved date', () => {
    expect(only({ registered: 'true' }).registered).toBe(true);
    expect(only({ registered: '1' }).registered).toBe(true);
    expect(only({ registered: 'false' }).registered).toBe(false);
    expect(only({}).registered).toBe(false);
    expect(only({ dissolved: '2019-12-31T00:00:00Z' }).dissolvedOn).toBe('2019-12-31');
    expect(only({ dissolved: '2019-12-31' }).dissolvedOn).toBe('2019-12-31');
    // Several P576 dates: the earliest valid one.
    const ends = (...dates: string[]) => dates.join(RECORD_SEP);
    const earliest = only({ dissolved: ends('', '2001-05-01T00:00:00Z', '1999-01-01T00:00:00Z') });
    expect(earliest.dissolvedOn).toBe('1999-01-01');
    expect(only({ dissolved: ends('-0100-01-01T00:00:00Z', '2019-12-31T00:00:00Z') }).dissolvedOn).toBe('2019-12-31');
    expect(only({ dissolved: '' }).dissolvedOn).toBeNull();
    for (const bad of ['-0100-01-01T00:00:00Z', '2019-02-30T00:00:00Z', 'x', '0000-01-01T00:00:00Z', '19-01-01']) {
      const r = ok(parseWikidata(doc([item({ dissolved: bad })])));
      expect(r.rows[0]?.dissolvedOn).toBeNull();
      expect(r.notes).toEqual({ dissolved_bad_date: 1 });
    }
  });

  it('reduces the P31 classes to unique sorted QIDs', () => {
    const uris = [
      `${ENTITY}Q207694`,
      `${ENTITY}Q33506`,
      `${ENTITY}Q33506`,
      'Q5',
      'http://example.org/Q7',
      `${ENTITY}Qx`,
    ];
    expect(only({ classes: uris.join(RECORD_SEP) }).classes).toEqual(['Q207694', 'Q33506', 'Q5']);
  });

  it('cleans text fields', () => {
    const r = only({ descNl: `<b>vet</b>\r\n&${CH.rlo}`, descEn: CH.zwsp });
    expect(r.descriptionNl).toBe('<b>vet</b> &');
    expect(r.descriptionEn).toBeNull();
  });
});

describe('robustness', () => {
  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        assertResult(parseWikidata(json));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.anything(), (anything) => {
        assertResult(parseWikidata(anything));
      }),
      { numRuns: 300 },
    );
  });

  it('never throws, and holds its invariants, on envelopes with arbitrary cells', () => {
    const text = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 60 }),
      fc.constantFrom(
        'Point(4.9 52.3)',
        'Point(0 0)',
        'https://example.org/',
        'javascript:alert(1)',
        `${FILEPATH}A%20b.jpg`,
        `${ENTITY}Q33506`,
        'Straat 1, 1234 AB Plaats',
        `0363${FIELD_SEP}Amsterdam${FIELD_SEP}NL-NH`,
        '2020-01-01T00:00:00Z',
        'true',
        '</script>',
        `${CH.rlo}${CH.nul}${CH.zwsp}`,
        `a${RECORD_SEP}b${RECORD_SEP}`,
      ),
      fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }).map((a) => a.join(RECORD_SEP)),
    );
    const names = [
      'item',
      'labelNl',
      'labelEn',
      'descNl',
      'descEn',
      'aliases',
      'coords',
      'websites',
      'addresses',
      'postcodes',
      'municipalities',
      'registered',
      'museumnl',
      'images',
      'classes',
      'dissolved',
    ];
    const bindingArb = fc
      .record({
        qid: fc.nat({ max: 5 }),
        cells: fc.array(fc.tuple(fc.constantFrom(...names), text), { maxLength: 16 }),
      })
      .map(({ qid, cells }) => ({
        item: { type: 'uri', value: `${ENTITY}Q${qid}` },
        ...Object.fromEntries(cells.map(([k, v]) => [k, { type: 'literal', value: v }])),
      }));
    fc.assert(
      fc.property(fc.array(bindingArb, { maxLength: 12 }), (bindings) => {
        const result = parseWikidata(doc(bindings));
        expect(result.ok).toBe(true);
        assertResult(result);
      }),
      { numRuns: 400 },
    );
  });

  describe('mutated fixtures', () => {
    const clone = <T>(x: T): T => structuredClone(x);
    const bindingsOf = (j: unknown) => (j as { results: { bindings: Record<string, unknown>[] } }).results.bindings;
    const nasty: unknown[] = [null, 0, -1, 1e308, 'x', '', true, [], {}, [[]], { value: 1 }, { type: 1, value: 'x' }];

    it.each(['normal', 'edge', 'hostile'] as const)(
      '%s: dropping, retyping, truncating and duplicating never throws',
      (name) => {
        const base = readFixture('wikidata', name);
        const variants: unknown[] = [];
        const n = bindingsOf(base).length;
        for (const key of ['head', 'results']) {
          const j = clone(base) as Record<string, unknown>;
          delete j[key];
          variants.push(j);
        }
        for (const [path, key] of [
          ['head', 'vars'],
          ['results', 'bindings'],
        ] as const) {
          const j = clone(base) as Record<string, Record<string, unknown>>;
          delete j[path]?.[key];
          variants.push(j);
          for (const value of nasty) {
            const k = clone(base) as Record<string, Record<string, unknown>>;
            (k[path] as Record<string, unknown>)[key] = value;
            variants.push(k);
          }
        }
        for (const take of [0, 1, Math.floor(n / 2), n - 1]) {
          const j = clone(base);
          bindingsOf(j).length = take;
          variants.push(j);
        }
        {
          const j = clone(base);
          const b = bindingsOf(j);
          b.push(...clone(b));
          variants.push(j);
          const k = clone(base);
          const kb = bindingsOf(k);
          kb.splice(1, 0, clone(kb[0] as Record<string, unknown>));
          variants.push(k);
          const r = clone(base);
          bindingsOf(r).reverse();
          variants.push(r);
        }
        for (let row = 0; row < Math.min(n, 4); row++) {
          for (const key of Object.keys(bindingsOf(base)[row] ?? {})) {
            const j = clone(base);
            delete bindingsOf(j)[row]?.[key];
            variants.push(j);
            for (const value of nasty) {
              const k = clone(base);
              (bindingsOf(k)[row] as Record<string, unknown>)[key] = value;
              variants.push(k);
              const m = clone(base);
              const cellValue = (bindingsOf(m)[row] as Record<string, Record<string, unknown>>)[key];
              if (cellValue !== undefined && typeof cellValue === 'object' && cellValue !== null) {
                cellValue.value = value;
                variants.push(m);
              }
            }
          }
        }
        expect(variants.length).toBeGreaterThan(100);
        for (const v of variants) assertResult(parseWikidata(v));
      },
      30_000,
    );

    it('a duplicated fixture gives the same rows as the original', () => {
      const base = readFixture('wikidata', 'normal');
      const twice = clone(base);
      bindingsOf(twice).push(...clone(bindingsOf(base)));
      expect(parseWikidata(twice)).toEqual(parseWikidata(base));
    });

    it('random mutations never throw', () => {
      const base = readFixture('wikidata', 'edge');
      const rows = bindingsOf(base).length;
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              row: fc.nat({ max: rows }),
              key: fc.nat({ max: 20 }),
              op: fc.constantFrom('drop', 'retype', 'text'),
              value: fc.oneof(fc.jsonValue(), fc.string({ unit: 'binary', maxLength: 30 })),
            }),
            { maxLength: 6 },
          ),
          (ops) => {
            const j = clone(base);
            const b = bindingsOf(j);
            for (const { row, key, op, value } of ops) {
              const target = b[row] as Record<string, unknown> | undefined;
              if (typeof target !== 'object' || target === null) continue;
              const k = Object.keys(target)[key % Math.max(1, Object.keys(target).length)];
              if (k === undefined) continue;
              if (op === 'drop') delete target[k];
              else if (op === 'retype') target[k] = value;
              else target[k] = { type: 'literal', value: typeof value === 'string' ? value : JSON.stringify(value) };
            }
            assertResult(parseWikidata(j));
          },
        ),
        { numRuns: 300 },
      );
    });
  });
});
