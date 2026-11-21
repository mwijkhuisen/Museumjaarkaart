import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SsrBundle } from '@mjk/contracts';

/**
 * The SSR bundle `apps/web` builds (A§15.1), `missing` when its file is absent, or `broken` when it
 * fails to load or has the wrong shape. The bundle reads and checks Vite's manifest when it loads,
 * so a build without its client files is `broken` here, before `ssr` serves.
 */
export async function loadBundle(
  url: URL = new URL('../../../web/dist/server/entry-server.js', import.meta.url),
): Promise<SsrBundle | 'missing' | 'broken'> {
  if (!existsSync(fileURLToPath(url))) return 'missing';
  try {
    const m = (await import(url.href)) as Partial<SsrBundle>;
    return typeof m.render === 'function' && typeof m.sitemap === 'function'
      ? { render: m.render, sitemap: m.sitemap }
      : 'broken';
  } catch {
    return 'broken';
  }
}
