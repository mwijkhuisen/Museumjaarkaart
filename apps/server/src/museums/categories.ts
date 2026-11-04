import { CATEGORIES, type Category } from './fields.ts';

// P31 class QID -> category (A§7.2, plan §2.2). Completed from the owner's full recording (O1,
// 2026-11-02): every class that five or more live items use is mapped here or neutral below; the
// labels come from Wikidata (nl / en). Most items only have plain "museum" and start as `other`.
export const CLASS_CATEGORY: Readonly<Record<string, Category>> = {
  Q207694: 'art', // art museum (38)
  Q3196771: 'art', // kunstmuseum, art museum (13)
  Q1759852: 'art', // beeldenpark, sculpture garden (17)
  Q1007870: 'art', // art gallery
  Q17438516: 'art', // muziekinstrumentenmuseum, musical instrument museum (8)
  Q17455058: 'art', // muziekmuseum, music museum (5)
  Q16735822: 'history', // history museum (11)
  Q2087181: 'history', // historic house museum (11)
  Q2772772: 'history', // military museum (20)
  Q3329412: 'history', // archaeological museum (7)
  Q756102: 'history', // openluchtmuseum, open-air museum (14)
  Q1595639: 'history', // streekmuseum, local museum (11)
  Q1863818: 'history', // scheepvaartmuseum, maritime museum (10)
  Q751876: 'history', // kasteel, château (12)
  Q23413: 'history', // burcht, castle (5)
  Q44613: 'history', // kloostercomplex, monastery (5)
  Q16970: 'history', // kerkgebouw, church building (7)
  Q575759: 'history', // oorlogsmonument, war memorial (7)
  Q5739135: 'history', // erfgoedcentrum, heritage centre (5)
  Q1970365: 'natural_history', // natuurmuseum, natural history museum (6)
  Q167346: 'natural_history', // hortus botanicus, botanical garden (9)
  Q2281788: 'natural_history', // publiek aquarium, public aquarium (5)
  Q38720: 'science_technology', // windmolen, windmill (9)
  Q3851468: 'science_technology', // stellingmolen, stage mill (8)
  Q446013: 'science_technology', // pompgemaal, pumping station (7)
  Q2069086: 'science_technology', // stoomgemaal, steam pumping station (6)
  Q420962: 'science_technology', // toeristische spoorweg, heritage railway (7)
  Q2516357: 'science_technology', // vervoermuseum, transport museum (5)
  Q1093436: 'science_technology', // computermuseum, computer museum (5)
};

/**
 * Classes that deliberately map to nothing: they say nothing about the collection (plain
 * "museum", "national museum", the kind of building or of organisation). `unmappedClasses`
 * leaves them out.
 */
export const NEUTRAL_CLASSES: readonly string[] = [
  'Q33506', // museum (1,114)
  'Q17431399', // national museum (17)
  'Q41176', // gebouw, building (18)
  'Q3947', // woonhuis, house (10)
  'Q1497375', // complex van meerdere objecten, architectural ensemble (11)
  'Q7075', // bibliotheek, library (8)
  'Q166118', // archiefinstelling, archives (8)
  'Q43229', // organisatie, organization (7)
  'Q163740', // non-profitorganisatie, nonprofit organization (7)
  'Q3152824', // cultureel instituut, cultural institution (5)
];

const mapped = (c: string): Category | undefined => (Object.hasOwn(CLASS_CATEGORY, c) ? CLASS_CATEGORY[c] : undefined);

/** Unique categories of the classes that map, in `CATEGORIES` order; `['other']` when none does. */
export function categoriesOf(classes: readonly string[]): Category[] {
  const found = new Set<Category>();
  for (const c of classes) {
    const category = mapped(c);
    if (category !== undefined) found.add(category);
  }
  const sorted = CATEGORIES.filter((c) => found.has(c));
  return sorted.length > 0 ? sorted : ['other'];
}

/** The distinct classes with no mapping and not neutral, sorted (for the fixture test "a class used by 10+ items"). */
export function unmappedClasses(classes: readonly string[]): string[] {
  return [...new Set(classes)].filter((c) => mapped(c) === undefined && !NEUTRAL_CLASSES.includes(c)).sort();
}
