import type { ProvinceCode } from '@mjk/contracts';
import { PROVINCE_SLUGS, type ProvinceSlug } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';

/** The route slug of a province code. */
export const provinceSlugOf = (code: ProvinceCode): ProvinceSlug | undefined =>
  (Object.keys(PROVINCE_SLUGS) as ProvinceSlug[]).find((slug) => PROVINCE_SLUGS[slug] === code);

/**
 * A province's name in the page's language without the provinces list (the museum page does not
 * fetch it). Chosen by name, never `m[key]`.
 */
export const PROVINCE_NAME = {
  drenthe: m.province_drenthe,
  flevoland: m.province_flevoland,
  fryslan: m.province_fryslan,
  gelderland: m.province_gelderland,
  groningen: m.province_groningen,
  limburg: m.province_limburg,
  'noord-brabant': m.province_noord_brabant,
  'noord-holland': m.province_noord_holland,
  overijssel: m.province_overijssel,
  utrecht: m.province_utrecht,
  zeeland: m.province_zeeland,
  'zuid-holland': m.province_zuid_holland,
} as const satisfies Record<ProvinceSlug, () => string>;
