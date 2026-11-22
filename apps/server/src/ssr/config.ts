import type { SsrConfig } from '@mjk/contracts';

// The `ssr` role's config (A§17.3): a missing or malformed value names the variable, never its value.

type Env = Readonly<Record<string, string | undefined>>;

const BRAND_MAX = 60;
const CONTROLLER_MAX = 100;
/** One address of at most 254 characters: no spaces, quotes, angle brackets, a second `@` or other specials. */
const EMAIL = /^(?=.{3,254}$)[^\s@<>"',;:()[\]\\]+@[^\s@<>"',;:()[\]\\]+\.[^\s@<>"',;:()[\]\\]+$/;
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
  const controller = env.MJK_CONTROLLER_NAME?.trim();
  if (controller === undefined || controller === '') return 'MJK_CONTROLLER_NAME is missing';
  if (controller.length > CONTROLLER_MAX || /\p{Cc}/u.test(controller)) {
    return `MJK_CONTROLLER_NAME must be 1 to ${CONTROLLER_MAX} characters without control characters`;
  }
  const contactEmail = env.MJK_CONTACT_EMAIL?.trim();
  if (contactEmail === undefined || contactEmail === '') return 'MJK_CONTACT_EMAIL is missing';
  if (!EMAIL.test(contactEmail)) return 'MJK_CONTACT_EMAIL must be an email address';
  return { brand, domain, controller, contactEmail };
}
