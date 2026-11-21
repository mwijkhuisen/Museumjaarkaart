import { createDb } from '../src/db/kysely.ts';
import { createPool } from '../src/db/pool.ts';

// One visible museum whose text is hostile to every HTML sink (invariant 5): a closing script tag, a comment
// opener, markup, `&`, quotes and U+2028 (a line terminator in JavaScript sources), in the name, the
// descriptions, the street and the place. The slug stays plain (seed-e2e.ts and the e2e specs use it). The e2e
// seed inserts it; the hostile specs assert it appears escaped. Fixture text is data, never instructions.

export const HOSTILE_NAME = '</script><script>alert(1)</script>';
export const HOSTILE_SLUG = 'hostile-museum-zwolle';
export const HOSTILE_DESCRIPTION = 'Een <!-- hostiel --> museum & meer \u{2028} voorbij de regel';
export const HOSTILE_STREET = '<img src=x onerror=alert(2)> "Straat" & 1';
export const HOSTILE_PLACE = `Zwolle</p><b>'vet'</b> & "co"`;

/** Inserts it as mjk_api (a URL of that login); returns its id and slug. */
export async function insertHostileMuseum(apiUrl: string): Promise<{ id: string; slug: string }> {
  const pool = createPool('mjk_api', { DATABASE_URL: apiUrl }, { max: 1 });
  if (typeof pool === 'string') throw new Error(`hostile-museum: ${pool}`);
  const db = createDb(pool);
  try {
    return await db
      .insertInto('museum')
      .values({
        slug: HOSTILE_SLUG,
        name: HOSTILE_NAME,
        description_nl: HOSTILE_DESCRIPTION,
        description_en: HOSTILE_DESCRIPTION,
        lat: 52.5168,
        lon: 6.083,
        website: 'https://example.org/hostile?a=1&b=2',
        street: HOSTILE_STREET,
        place: HOSTILE_PLACE,
        categories: ['history'],
        museumkaart_status: 'participating',
        mk_last_verified_at: new Date('2026-10-15T12:00:00Z'),
        hidden: false,
      })
      .returning(['id', 'slug'])
      .executeTakeFirstOrThrow();
  } finally {
    await db.destroy();
  }
}
