import type { SsrConfig } from '@mjk/contracts';

// The `ssr` role's config (A§17.3): a missing or malformed value names the variable, never its value.

type Env = Readonly<Record<string, string | undefined>>;

const BRAND_MAX = 60;
/** A lowercase DNS host name with at least one dot: labels of a-z, 0-9 and inner hyphens. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function readSsrConfig(env: Env): SsrConfig | string {
  const brand = env.MJK_BRAND_NAME?.trim();
  if (brand === undefined || brand === '') return 'MJK_BRAND_NAME is missing';
  if (brand.length > BRAND_MAX || /\p{Cc}/u.test(brand)) {
    return `MJK_BRAND_NAME must be 1 to ${BRAND_MAX} characters without control characters`;
  }
  const domain = env.MJK_DOMAIN;
  if (domain === undefined || domain === '') return 'MJK_DOMAIN is missing';
  if (!DOMAIN.test(domain)) return 'MJK_DOMAIN must be a lowercase host name with a dot';
  return { brand, domain };
}
