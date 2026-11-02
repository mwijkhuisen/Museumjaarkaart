// The shapes of a parsed source row, as the database stores it (db/migrations/20261102000002_museums.sql
// and 20261102000001_museum_reference.sql). The parsers check every row against them before it leaves
// (a row that fails is invalid `bad_payload`, so one odd value never aborts a run's transaction), and
// `admin match resolve --new` checks a stored payload again before it becomes a museum.
//
// Each rule is at least as tight as the CHECK it stands for: lengths count code points (the database's
// char_length), and no string holds a NUL or a lone surrogate (text and jsonb reject both).

import { z } from 'zod';
import { parseDate } from '../../admin/dates.ts';
import { CBS_CODE, LIMITS, NL_BOX, POSTCODE, PROVINCE_CODE, QID } from '../fields.ts';
import { museumnlUrl } from '../museumnl.ts';
import { codePointLength, hasInvisible } from './text.ts';

/** `museum.rce_id`, and the RCE `museum_source_row.external_id`. */
export const RCE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** `museum_source_row.external_id` holds at most this many characters. */
export const EXTERNAL_ID_MAX = 64;

const storable = (v: string): boolean => v.isWellFormed() && !v.includes('\u0000');

/** A non-empty text of at most `max` characters (code points), as `char_length(x) BETWEEN 1 AND max`. */
export const text = (max: number) =>
  z.string().refine((v) => {
    const n = codePointLength(v);
    return n >= 1 && n <= max && storable(v);
  });

export const opt = <T extends z.ZodType>(s: T) => z.union([z.null(), s]);

export const lat = z.number().min(NL_BOX.latMin).max(NL_BOX.latMax);
export const lon = z.number().min(NL_BOX.lonMin).max(NL_BOX.lonMax);
const pointOk = (r: { lat: number | null; lon: number | null }) => (r.lat === null) === (r.lon === null);

/** A calendar day PostgreSQL's `date` accepts (there is no year 0). */
export const date = z.string().refine((v) => parseDate(v) !== undefined && !v.startsWith('0000'));

/** `museum.website`: `^https://`, no whitespace, at most 2,048 characters. */
export const website = z.string().refine((v) => /^https:\/\/\S+$/.test(v) && codePointLength(v) <= LIMITS.url);

/** `museum.museumnl_url`: exactly what museumnlUrl() keeps (the link-out host, at most 2,048 characters). */
export const museumnl = z.string().refine((v) => museumnlUrl(v) === v);

/** `museum.commons_file`: 1-255 characters, no control character and none of `#<>[]|{}/`. */
export const commonsFile = text(LIMITS.commonsFile).refine((v) => !/[#<>[\]|{}/]/u.test(v) && !hasInvisible(v));

/** A QID that also fits `museum_source_row.external_id`. */
export const qid = z
  .string()
  .regex(QID)
  .refine((v) => v.length <= EXTERNAL_ID_MAX);

export const wikidataPayload = z
  .strictObject({
    qid,
    name: text(LIMITS.label),
    nameEn: opt(text(LIMITS.label)),
    descriptionNl: opt(text(LIMITS.description)),
    descriptionEn: opt(text(LIMITS.description)),
    aliases: z.array(text(LIMITS.alias)).max(100),
    lat: opt(lat),
    lon: opt(lon),
    website: opt(website),
    street: opt(text(LIMITS.street)),
    houseNumber: opt(text(LIMITS.houseNumber)),
    postcode: opt(z.string().regex(POSTCODE)),
    place: opt(text(LIMITS.place)),
    municipalityCode: opt(z.string().regex(CBS_CODE)),
    municipalityName: opt(text(LIMITS.municipalityName)),
    provinceCode: opt(z.string().regex(PROVINCE_CODE)),
    registered: z.boolean(),
    museumnlUrl: opt(museumnl),
    commonsFile: opt(commonsFile),
    // Classes stay inside the payload (no column of their own), so a QID is enough.
    classes: z.array(z.string().regex(QID)),
    dissolvedOn: opt(date),
  })
  .refine(pointOk);

export const rcePayload = z
  .strictObject({
    rceId: z.string().regex(RCE_ID),
    name: text(LIMITS.label),
    street: opt(text(LIMITS.street)),
    houseNumber: opt(text(LIMITS.houseNumber)),
    postcode: opt(z.string().regex(POSTCODE)),
    place: opt(text(LIMITS.place)),
    municipalityName: opt(text(LIMITS.municipalityName)),
    lat: opt(lat),
    lon: opt(lon),
  })
  .refine(pointOk);
