import type { SsrBundle } from '@mjk/contracts';

/** The SSR bundle `apps/web` builds (A§15.1), or null when the file is missing or has the wrong shape. */
export async function loadBundle(
  url: URL = new URL('../../../web/dist/server/entry-server.js', import.meta.url),
): Promise<SsrBundle | null> {
  try {
    const m = (await import(url.href)) as Partial<SsrBundle>;
    return typeof m.render === 'function' && typeof m.sitemap === 'function'
      ? { render: m.render, sitemap: m.sitemap }
      : null;
  } catch {
    return null;
  }
}
