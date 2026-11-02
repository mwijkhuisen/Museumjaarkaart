// The `week2` fixture (plan §2.4): the `normal` answers with one week of news,
// derived in code so it still works after the owner re-records `normal` (O1).
// Items are picked by role in QID order, each for one piece of news.

type Value = { type: string; value: string; datatype?: string; 'xml:lang'?: string };
type Binding = Record<string, Value>;
type SparqlAnswer = { head: { vars: string[] }; results: { bindings: Binding[] } };

const ENTITY = 'http://www.wikidata.org/entity/';
const FILEPATH = 'http://commons.wikimedia.org/wiki/Special:FilePath/';
/** 1 m of latitude in degrees (1° ≈ 111,195 m). */
const METRE = 1 / 111_195;

const qidOf = (b: Binding) => (b.item?.value ?? '').slice(ENTITY.length);
const literal = (value: string): Value => ({ type: 'literal', value });

/** The first point of a binding's coordinates, or undefined. */
function point(b: Binding): { lon: number; lat: number } | undefined {
  const m = /^Point\(([-0-9.]+) ([-0-9.]+)\)/.exec(b.coords?.value ?? '');
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : undefined;
}

const movedNorth = (b: Binding, metres: number): Binding => {
  const p = point(b);
  if (!p) throw new Error('week2: the item has no coordinates');
  return { ...b, coords: literal(`Point(${p.lon.toFixed(5)} ${(p.lat + metres * METRE).toFixed(6)})`) };
};

export type Week2Picks = {
  moved100: string;
  moved300: string;
  renamed: string;
  newWebsite: string;
  newImage: string;
  gone: string;
  dissolved: string;
  /** The QID that disappears in the merge, and the QID that replaces it at the same place under the same name. */
  mergedFrom: string;
  mergedInto: string;
  /** A brand-new item. */
  added: string;
};

export function week2(normal: SparqlAnswer): { answer: SparqlAnswer; picks: Week2Picks } {
  const bindings = [...normal.results.bindings].sort((a, b) => (qidOf(a) < qidOf(b) ? -1 : 1));
  const used = new Set<string>();
  const pick = (ok: (b: Binding) => boolean): Binding => {
    // From the back: the first items of `normal` are neighbour pairs for the ambiguous RCE rows.
    const b = [...bindings].reverse().find((x) => !used.has(qidOf(x)) && !x.dissolved && ok(x));
    if (!b) throw new Error('week2: the normal fixture has too few items for every role');
    used.add(qidOf(b));
    return b;
  };
  const withCoords = (b: Binding) => point(b) !== undefined;
  const moved100 = pick(withCoords);
  const moved300 = pick(withCoords);
  const mergedFrom = pick(withCoords);
  const renamed = pick((b) => b.labelNl !== undefined);
  // One that has a website, so the week after (the old one back) is a safe change too.
  const newWebsite = pick((b) => (b.websites?.value ?? '') !== '');
  const newImage = pick(() => true);
  const gone = pick(() => true);
  const dissolved = pick(() => true);

  const mergedInto = 'Q99000998';
  const added = 'Q99000999';
  const out: Binding[] = [];
  for (const b of bindings) {
    const q = qidOf(b);
    if (q === qidOf(gone) || q === qidOf(mergedFrom)) continue;
    if (q === qidOf(moved100)) out.push(movedNorth(b, 100));
    else if (q === qidOf(moved300)) out.push(movedNorth(b, 300));
    else if (q === qidOf(renamed))
      out.push({ ...b, labelNl: { ...(b.labelNl as Value), value: `${b.labelNl?.value} Nieuw` } });
    else if (q === qidOf(newWebsite)) out.push({ ...b, websites: literal('https://www.nieuwe-site.example/') });
    else if (q === qidOf(newImage)) out.push({ ...b, images: literal(`${FILEPATH}Nieuwe%20gevel%202026.jpg`) });
    else if (q === qidOf(dissolved)) {
      out.push({
        ...b,
        dissolved: {
          type: 'literal',
          datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
          value: '2026-10-01T00:00:00Z',
        },
      });
    } else out.push(b);
  }
  out.push({ ...mergedFrom, item: { type: 'uri', value: `${ENTITY}${mergedInto}` } });
  out.push({
    item: { type: 'uri', value: `${ENTITY}${added}` },
    labelNl: { type: 'literal', 'xml:lang': 'nl', value: 'Gloednieuw Museum Verweg' },
    coords: literal('Point(6.91000 53.31000)'),
    classes: literal(`${ENTITY}Q33506`),
  });
  return {
    answer: { head: normal.head, results: { bindings: out } },
    picks: {
      moved100: qidOf(moved100),
      moved300: qidOf(moved300),
      renamed: qidOf(renamed),
      newWebsite: qidOf(newWebsite),
      newImage: qidOf(newImage),
      gone: qidOf(gone),
      dissolved: qidOf(dissolved),
      mergedFrom: qidOf(mergedFrom),
      mergedInto,
      added,
    },
  };
}
