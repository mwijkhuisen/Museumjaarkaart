import { z } from 'zod';
import {
  CategorySchema,
  CbsCode,
  Cursor,
  IsoDate,
  IsoDateTime,
  Lat,
  LIMITS,
  Lon,
  MuseumkaartStatusSchema,
  PhotoPolicySchema,
  POSTCODE_RE,
  ProvinceCodeSchema,
  Slug,
} from './common.ts';
import { ASPECTS, type Aspect, AspectStat, Mean } from './reviews.ts';

export const Healthz = z.strictObject({ ok: z.boolean() });
export type Healthz = z.infer<typeof Healthz>;

export const MuseumListItem = z.strictObject({
  id: z.uuid(),
  slug: Slug,
  name: z.string().min(1).max(250),
  name_en: z.string().max(250).nullable(),
  place: z.string().max(LIMITS.place).nullable(),
  municipality_code: CbsCode.nullable(),
  municipality_name: z.string().max(LIMITS.municipalityName).nullable(),
  province_code: ProvinceCodeSchema.nullable(),
  lat: Lat.nullable(),
  lon: Lon.nullable(),
  categories: z.array(CategorySchema),
  museumkaart_status: MuseumkaartStatusSchema,
  registered: z.boolean(),
  closed_on: IsoDate.nullable(),
  temp_closed: z.boolean(),
  rating_count: z.int().min(0),
  rating_mean: Mean.nullable(),
});
export type MuseumListItem = z.infer<typeof MuseumListItem>;

export const MuseumList = z.strictObject({
  items: z.array(MuseumListItem).max(50),
  next_cursor: Cursor.nullable(),
  total: z.int().min(0),
});
export type MuseumList = z.infer<typeof MuseumList>;

/** The Commons image of a museum (ADR-0018): `https://media.<domain>/p/<public_key>/<width>.<avif|webp>`; the credit is plain text. */
export const MuseumImage = z.strictObject({
  public_key: z.string().regex(/^[0-9a-f]{32}$/),
  widths: z.array(z.int().min(1).max(2000)).min(1).max(4),
  width: z.int().min(1).max(100000),
  height: z.int().min(1).max(100000),
  licence: z.string().max(40),
  attribution: z.string().min(1).max(200).nullable(),
  file: z.string().min(1).max(255),
});
export type MuseumImage = z.infer<typeof MuseumImage>;

export const MuseumDetail = MuseumListItem.extend({
  description_nl: z.string().max(250).nullable(),
  description_en: z.string().max(250).nullable(),
  street: z.string().max(LIMITS.street).nullable(),
  house_number: z.string().max(LIMITS.houseNumber).nullable(),
  postcode: z.string().regex(POSTCODE_RE).nullable(),
  website: z
    .string()
    .max(2048)
    .regex(/^https:\/\//)
    .nullable(),
  museumnl_url: z
    .string()
    .max(2048)
    .regex(/^https:\/\/www\.museum\.nl\//)
    .nullable(),
  mk_since: IsoDate.nullable(),
  mk_until: IsoDate.nullable(),
  mk_last_verified_at: IsoDateTime.nullable(),
  admission_adult_cents: z.int().min(0).max(20000).nullable(),
  price_verified_at: IsoDateTime.nullable(),
  photo_policy: PhotoPolicySchema,
  temp_closed_until: IsoDate.nullable(),
  mk_list: z.strictObject({ published_on: IsoDate, n: z.int().min(0), member: z.boolean() }).nullable(),
  image: MuseumImage.nullable(),
  /** Per aspect: the mean is null below 3 ratings (WP4 fills it). */
  aspects: z.strictObject(Object.fromEntries(ASPECTS.map((a) => [a, AspectStat])) as Record<Aspect, typeof AspectStat>),
});
export type MuseumDetail = z.infer<typeof MuseumDetail>;

export const Suggest = z.strictObject({
  items: z
    .array(
      z.strictObject({
        slug: Slug,
        name: z.string().min(1).max(250),
        place: z.string().max(LIMITS.place).nullable(),
        municipality_name: z.string().max(LIMITS.municipalityName).nullable(),
      }),
    )
    .max(10),
});
export type Suggest = z.infer<typeof Suggest>;

export const NearItem = MuseumListItem.extend({
  lat: Lat,
  lon: Lon,
  distance_m: z.int().min(0),
});
export type NearItem = z.infer<typeof NearItem>;

export const NearList = z.strictObject({ items: z.array(NearItem).max(50) });
export type NearList = z.infer<typeof NearList>;

export const MuseumPoint = z.strictObject({
  id: MuseumListItem.shape.id,
  slug: MuseumListItem.shape.slug,
  name: MuseumListItem.shape.name,
  name_en: MuseumListItem.shape.name_en,
  lat: Lat,
  lon: Lon,
  museumkaart_status: MuseumListItem.shape.museumkaart_status,
  categories: MuseumListItem.shape.categories,
});
export type MuseumPoint = z.infer<typeof MuseumPoint>;

export const MuseumPoints = z.strictObject({ items: z.array(MuseumPoint).max(5000) });
export type MuseumPoints = z.infer<typeof MuseumPoints>;

export const Provinces = z.strictObject({
  items: z
    .array(
      z.strictObject({
        code: ProvinceCodeSchema,
        name_nl: z.string().min(1).max(100),
        name_en: z.string().min(1).max(100),
        museum_count: z.int().min(0),
      }),
    )
    .length(12),
});
export type Provinces = z.infer<typeof Provinces>;

export const MkList = z.strictObject({
  list: z.strictObject({ published_on: IsoDate, n: z.int().min(0) }).nullable(),
});
export type MkList = z.infer<typeof MkList>;
