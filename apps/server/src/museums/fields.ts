// The museum columns by origin (A§7.2, A§7.4, plan §2.1 and §2.4). The one source
// for the migrations' CHECKs and grants (a test compares them), the sync's safe
// set and the curation CLI. Default deny: a column that is not in SAFE_FIELDS
// never auto-applies.

/** The six categories of A§7.2. */
export const CATEGORIES = ['art', 'history', 'natural_history', 'science_technology', 'ethnology', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const MUSEUMKAART_STATUSES = ['participating', 'left', 'unknown'] as const;
export type MuseumkaartStatus = (typeof MUSEUMKAART_STATUSES)[number];

export const PHOTO_POLICIES = ['allowed', 'no_flash', 'forbidden', 'unknown'] as const;
export type PhotoPolicy = (typeof PHOTO_POLICIES)[number];

/** Columns a source feeds. The seed inserts them (plus `slug`); the owner can pin any of them. */
export const SOURCE_FIELDS = [
  'wikidata_qid',
  'rce_id',
  'name',
  'name_en',
  'description_nl',
  'description_en',
  'lat',
  'lon',
  'website',
  'street',
  'house_number',
  'postcode',
  'place',
  'municipality_code',
  'registered',
  'museumnl_url',
  'categories',
  'closed_on',
  'commons_file',
] as const;
export type SourceField = (typeof SOURCE_FIELDS)[number];

/**
 * Auto-applied by the sync (A§7.4 + Q4). Coordinates only for a move under 250 m;
 * a value going to null queues; `rce_id` is set when an RCE row is matched.
 * `mjk_worker` may UPDATE exactly these columns.
 */
export const SAFE_FIELDS = [
  'rce_id',
  'name_en',
  'description_nl',
  'description_en',
  'lat',
  'lon',
  'website',
  'street',
  'house_number',
  'postcode',
  'place',
  'municipality_code',
  'registered',
  'museumnl_url',
] as const satisfies readonly SourceField[];

/** Columns the seed (as `mjk_worker`) may INSERT: no curated column, no closure (the seed skips dissolved items). */
export const WORKER_INSERT_FIELDS: readonly string[] = ['slug', ...SOURCE_FIELDS.filter((f) => f !== 'closed_on')];

/** Curated by the owner only (A§7.5, Q6); `mjk_worker` can neither INSERT nor UPDATE them. */
export const CURATED_FIELDS = [
  'museumkaart_status',
  'mk_since',
  'mk_until',
  'mk_last_verified_at',
  'admission_adult_cents',
  'price_verified_at',
  'photo_policy',
  'temp_closed',
  'temp_closed_until',
  'hidden',
  'pinned_fields',
] as const;
export type CuratedField = (typeof CURATED_FIELDS)[number];

/** `museum_change.field` beyond the column names: identity and presence events. */
export const PSEUDO_FIELDS = ['new_museum', 'presence', 'qid_link'] as const;
export type PseudoField = (typeof PSEUDO_FIELDS)[number];

export const CHANGE_FIELDS = [...SOURCE_FIELDS, ...CURATED_FIELDS, ...PSEUDO_FIELDS] as const;
export type ChangeField = (typeof CHANGE_FIELDS)[number];

export const SOURCES = ['wikidata', 'rce'] as const;
export type Source = (typeof SOURCES)[number];

/** A move of this many metres or more queues (A§7.4 [U]). */
export const MOVE_QUEUE_METRES = 250;
