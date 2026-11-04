import { z } from 'zod';

// Shared constants and scalar schemas. Browser-safe: zod only, no Node API.
// A test in apps/server compares these values with the server's fields.ts and the reference migration.

export const PROVINCE_CODES = [
  'NL-DR',
  'NL-FL',
  'NL-FR',
  'NL-GE',
  'NL-GR',
  'NL-LI',
  'NL-NB',
  'NL-NH',
  'NL-OV',
  'NL-UT',
  'NL-ZE',
  'NL-ZH',
] as const;
export type ProvinceCode = (typeof PROVINCE_CODES)[number];

export const CATEGORIES = ['art', 'history', 'natural_history', 'science_technology', 'ethnology', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const MUSEUMKAART_STATUSES = ['participating', 'left', 'unknown'] as const;
export type MuseumkaartStatus = (typeof MUSEUMKAART_STATUSES)[number];

export const PHOTO_POLICIES = ['allowed', 'no_flash', 'forbidden', 'unknown'] as const;
export type PhotoPolicy = (typeof PHOTO_POLICIES)[number];

export const NL_BOX = { latMin: 50.7, latMax: 53.7, lonMin: 3.2, lonMax: 7.3 } as const;

/** Length caps of the `museum` CHECKs (P1a's fields.ts LIMITS; a server test compares them). */
export const LIMITS = {
  label: 250,
  description: 250,
  street: 200,
  houseNumber: 20,
  place: 100,
  municipalityName: 100,
  url: 2048,
} as const;

export const SLUG_MAX = 120;
export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const CBS_CODE_RE = /^GM[0-9]{4}$/;
export const POSTCODE_RE = /^[1-9][0-9]{3} [A-Z]{2}$/;

export const ProvinceCodeSchema = z.enum(PROVINCE_CODES);
export const CategorySchema = z.enum(CATEGORIES);
export const MuseumkaartStatusSchema = z.enum(MUSEUMKAART_STATUSES);
export const PhotoPolicySchema = z.enum(PHOTO_POLICIES);

export const IsoDate = z.iso.date();
export const IsoDateTime = z.iso.datetime();
export const Slug = z.string().max(SLUG_MAX).regex(SLUG_RE);
export const CbsCode = z.string().regex(CBS_CODE_RE);
export const Lat = z.number().min(NL_BOX.latMin).max(NL_BOX.latMax);
export const Lon = z.number().min(NL_BOX.lonMin).max(NL_BOX.lonMax);
export const Cursor = z.string().regex(/^[A-Za-z0-9_-]{1,4096}$/);
