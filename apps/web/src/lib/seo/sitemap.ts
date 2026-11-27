import type { SsrConfig } from '@mjk/contracts';
import { type Locale, PROVINCE_SLUGS, type ProvinceSlug, pathOf, type Route } from '../routes.ts';

const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] as string);

/**
 * `sitemap.xml` (A§15.2): the home page, the list, the provinces and every museum, in NL and then
 * EN; the slugs in the order given, then the opted-in profiles' handles (P2c, Q2). No legal, shell,
 * map or search pages.
 */
export function sitemapXml(slugs: readonly string[], handles: readonly string[], config: SsrConfig): string {
  const urls = (['nl', 'en'] as Locale[]).flatMap((locale) => {
    const routes: Route[] = [
      { page: 'home', locale },
      { page: 'museums', locale, query: '' },
      ...(Object.keys(PROVINCE_SLUGS) as ProvinceSlug[]).map(
        (province): Route => ({
          page: 'province',
          locale,
          province,
          query: '',
        }),
      ),
      ...slugs.map((slug): Route => ({ page: 'museum', locale, slug })),
      ...handles.map((handle): Route => ({ page: 'profile', locale, handle })),
    ];
    return routes.map((r) => `<url><loc>${escapeXml(`https://${config.domain}${pathOf(r)}`)}</loc></url>`);
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>\n`;
}
