import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASS_CATEGORY, categoriesOf, NEUTRAL_CLASSES, unmappedClasses } from '../../src/museums/categories.ts';
import { CATEGORIES, QID } from '../../src/museums/fields.ts';
import { parseWikidata } from '../../src/museums/sources/wikidata.ts';

describe('CLASS_CATEGORY', () => {
  it('holds only QIDs and the six categories, never `other`', () => {
    for (const [qid, category] of Object.entries(CLASS_CATEGORY)) {
      expect(qid).toMatch(QID);
      expect(CATEGORIES).toContain(category);
      expect(category).not.toBe('other');
    }
  });

  it('maps no neutral class', () => {
    for (const q of NEUTRAL_CLASSES) expect(CLASS_CATEGORY).not.toHaveProperty(q);
  });
});

describe('categoriesOf', () => {
  it('maps art museum and art gallery to art', () => {
    expect(categoriesOf(['Q207694'])).toEqual(['art']);
    expect(categoriesOf(['Q1007870'])).toEqual(['art']);
  });

  it('maps the history family to history', () => {
    expect(categoriesOf(['Q16735822'])).toEqual(['history']);
    expect(categoriesOf(['Q2087181'])).toEqual(['history']);
    expect(categoriesOf(['Q2772772'])).toEqual(['history']);
    expect(categoriesOf(['Q3329412'])).toEqual(['history']);
  });

  it('is unique and in CATEGORIES order whatever the input order', () => {
    expect(categoriesOf(['Q16735822', 'Q207694', 'Q2087181', 'Q207694'])).toEqual(['art', 'history']);
    expect(categoriesOf(['Q2087181', 'Q1007870'])).toEqual(['art', 'history']);
  });

  it('plain museum maps to nothing by itself', () => {
    expect(categoriesOf(['Q33506'])).toEqual(['other']);
    expect(categoriesOf(['Q33506', 'Q207694'])).toEqual(['art']);
  });

  it('is `other` when no class maps, including none at all and hostile keys', () => {
    expect(categoriesOf([])).toEqual(['other']);
    expect(categoriesOf(['Q999999999'])).toEqual(['other']);
    expect(categoriesOf(['__proto__', 'constructor', 'toString', ''])).toEqual(['other']);
  });
});

describe('the table against the real data (O1)', () => {
  // The classes that five or more live items use in the owner's full recording (2026-11-02, 1,344
  // live items, 231 distinct classes), most used first.
  const FULL_SET = [
    'Q33506',
    'Q207694',
    'Q2772772',
    'Q41176',
    'Q17431399',
    'Q1759852',
    'Q756102',
    'Q3196771',
    'Q751876',
    'Q2087181',
    'Q16735822',
    'Q1497375',
    'Q1595639',
    'Q1863818',
    'Q3947',
    'Q167346',
    'Q38720',
    'Q7075',
    'Q17438516',
    'Q3851468',
    'Q166118',
    'Q575759',
    'Q16970',
    'Q3329412',
    'Q43229',
    'Q446013',
    'Q420962',
    'Q163740',
    'Q1970365',
    'Q2069086',
    'Q3152824',
    'Q23413',
    'Q2281788',
    'Q44613',
    'Q2516357',
    'Q5739135',
    'Q1093436',
    'Q17455058',
  ];

  it('maps or neutralises every class five or more items of the full recording use', () => {
    expect(unmappedClasses(FULL_SET)).toEqual([]);
  });

  it('leaves no class unmapped that ten or more items of the recorded sample use', () => {
    const path = new URL('../fixtures/museums/wikidata/normal.json', import.meta.url);
    const r = parseWikidata(JSON.parse(readFileSync(path, 'utf8')));
    if (!r.ok) throw new Error('the normal fixture must parse');
    const uses = new Map<string, number>();
    for (const row of r.rows) for (const c of row.classes) uses.set(c, (uses.get(c) ?? 0) + 1);
    expect(unmappedClasses([...uses].filter(([, n]) => n >= 10).map(([c]) => c))).toEqual([]);
  });

  it('maps the building-type classes to nothing and the museum types to their category', () => {
    expect(categoriesOf(['Q33506', 'Q41176'])).toEqual(['other']);
    expect(categoriesOf(['Q38720', 'Q33506'])).toEqual(['science_technology']);
    expect(categoriesOf(['Q751876', 'Q3196771'])).toEqual(['art', 'history']);
    expect(categoriesOf(['Q167346'])).toEqual(['natural_history']);
  });
});

describe('unmappedClasses', () => {
  it('lists distinct unmapped classes sorted, leaving out mapped and neutral ones', () => {
    expect(unmappedClasses(['Q9', 'Q207694', 'Q33506', 'Q17431399', 'Q5', 'Q9'])).toEqual(['Q5', 'Q9']);
    expect(unmappedClasses([])).toEqual([]);
  });
});
