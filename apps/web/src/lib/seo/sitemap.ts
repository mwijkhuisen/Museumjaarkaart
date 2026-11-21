import type { SsrConfig } from '@mjk/contracts';

/** `sitemap.xml` (A§15.2). WP5 adds the lists, the provinces and every museum in both languages. */
export function sitemapXml(_slugs: readonly string[], config: SsrConfig): string {
  const home = [`https://${config.domain}/`, `https://${config.domain}/en/`];
  const urls = home.map((loc) => `<url><loc>${loc}</loc></url>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>\n`;
}
