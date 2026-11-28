import { ASPECTS, type MuseumDetail, type ProvinceCode } from '@mjk/contracts';
import type { Db } from '../db/kysely.ts';
import { ASPECT_MIN } from '../reviews/score.ts';
import { currentMkList } from './reference.ts';

// The public detail of one museum and the old-slug lookup (A§14, A§15.2). Reads only the pub_*
// views, so it works as mjk_api and as mjk_ssr. The slug must already have passed SlugParam.

/** The `MuseumDetail` contract's shape (timestamps as ISO strings). */
export type DetailRow = MuseumDetail;

export type Lookup = { kind: 'found'; detail: DetailRow } | { kind: 'moved'; slug: string } | { kind: 'missing' };

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export async function getMuseumDetail(db: Db, slug: string): Promise<DetailRow | null> {
  const r = await db
    .selectFrom('pub_museum')
    .select([
      'id',
      'slug',
      'name',
      'name_en',
      'place',
      'municipality_code',
      'municipality_name',
      'province_code',
      'lat',
      'lon',
      'categories',
      'museumkaart_status',
      'registered',
      'closed_on',
      'temp_closed',
      'description_nl',
      'description_en',
      'street',
      'house_number',
      'postcode',
      'website',
      'museumnl_url',
      'mk_since',
      'mk_until',
      'mk_last_verified_at',
      'admission_adult_cents',
      'price_verified_at',
      'photo_policy',
      'temp_closed_until',
      'mk_list_member',
    ])
    .where('slug', '=', slug)
    .executeTakeFirst();
  if (r === undefined) return null;
  const list = await currentMkList(db);
  const stats = await db
    .selectFrom('pub_museum_stats')
    .selectAll()
    .where('museum_id', '=', r.id as string)
    .executeTakeFirst();
  // The mean of an aspect shows from ASPECT_MIN ratings of it (owner Q2); the count is always true.
  const aspects = Object.fromEntries(
    ASPECTS.map((a) => {
      const count = stats?.[`${a}_count`] ?? 0;
      return [a, { mean: count >= ASPECT_MIN ? (stats?.[`${a}_mean`] ?? null) : null, count }];
    }),
  ) as MuseumDetail['aspects'];
  const img = await db
    .selectFrom('pub_museum_image')
    .select(['public_key', 'widths', 'width', 'height', 'licence', 'attribution', 'file'])
    .where('museum_id', '=', r.id as string)
    .executeTakeFirst();
  const image =
    img === undefined || img.public_key === null || img.widths === null || img.width === null || img.height === null
      ? null
      : {
          public_key: img.public_key,
          widths: img.widths,
          width: img.width,
          height: img.height,
          licence: img.licence as string,
          attribution: img.attribution,
          file: img.file as string,
        };
  return {
    id: r.id as string,
    slug: r.slug as string,
    name: r.name as string,
    name_en: r.name_en,
    place: r.place,
    municipality_code: r.municipality_code,
    municipality_name: r.municipality_name,
    province_code: r.province_code as ProvinceCode | null,
    lat: r.lat,
    lon: r.lon,
    categories: (r.categories ?? []) as DetailRow['categories'],
    museumkaart_status: r.museumkaart_status as DetailRow['museumkaart_status'],
    registered: r.registered === true,
    closed_on: r.closed_on,
    temp_closed: r.temp_closed === true,
    description_nl: r.description_nl,
    description_en: r.description_en,
    street: r.street,
    house_number: r.house_number,
    postcode: r.postcode,
    website: r.website,
    museumnl_url: r.museumnl_url,
    mk_since: r.mk_since,
    mk_until: r.mk_until,
    mk_last_verified_at: iso(r.mk_last_verified_at),
    admission_adult_cents: r.admission_adult_cents,
    price_verified_at: iso(r.price_verified_at),
    photo_policy: r.photo_policy as DetailRow['photo_policy'],
    temp_closed_until: r.temp_closed_until,
    image,
    mk_list: list === null ? null : { ...list, member: r.mk_list_member === true },
    rating_count: stats?.rating_count ?? 0,
    rating_mean: stats?.rating_mean ?? null,
    aspects,
  };
}

/** The current slug of the visible museum that once had `oldSlug`, or null. */
export async function findRedirect(db: Db, oldSlug: string): Promise<string | null> {
  const r = await db.selectFrom('pub_slug_redirect').select('slug').where('old_slug', '=', oldSlug).executeTakeFirst();
  return r?.slug ?? null;
}

/** A current slug is found; an old one is moved (to the current slug, never a chain); else missing. */
export async function lookupMuseum(db: Db, slug: string): Promise<Lookup> {
  const detail = await getMuseumDetail(db, slug);
  if (detail !== null) return { kind: 'found', detail };
  const current = await findRedirect(db, slug);
  return current === null ? { kind: 'missing' } : { kind: 'moved', slug: current };
}
