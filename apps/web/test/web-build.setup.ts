import { execFileSync } from 'node:child_process';
import { buildWeb } from '../build.ts';

// Integration globalSetup: the `ssr` tests import the real SSR bundle from apps/web/dist, so the
// run builds it once. Paraglide first, with the flags of the `i18n` script (its one source).
export default async function setup(): Promise<void> {
  execFileSync('pnpm', ['--filter', '@mjk/web', 'i18n'], { stdio: 'inherit' });
  await buildWeb();
}
