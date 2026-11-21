import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuilder } from 'vite';

/**
 * Builds the client and the SSR bundle, as `vite build` does, into `outDir/client` and
 * `outDir/server` (default `apps/web/dist`). The JS `build()` would build the client only, so this
 * goes through the builder. Paraglide must be compiled first (`pnpm i18n`).
 *
 * NODE_ENV is "production" for the run: Vitest sets "test", and a client built under it would
 * bundle React's development build (CLAUDE.md gotcha).
 */
export async function buildWeb(outDir?: string): Promise<void> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const out =
      outDir === undefined
        ? {}
        : {
            environments: {
              client: { build: { outDir: join(outDir, 'client'), emptyOutDir: true } },
              ssr: { build: { outDir: join(outDir, 'server'), emptyOutDir: true } },
            },
          };
    const builder = await createBuilder({
      configFile: fileURLToPath(new URL('./vite.config.ts', import.meta.url)),
      mode: 'production',
      logLevel: 'warn',
      ...out,
    });
    await builder.buildApp();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}
