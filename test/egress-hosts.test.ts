import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HC_PING_ORIGIN } from '../apps/server/src/lib/healthchecks.ts';
import { LETTERMINT_URL } from '../apps/server/src/mail/lettermint.ts';
import { ALLOWED_HOSTS } from '../apps/server/src/museums/sources/http.ts';
import { BUILDS_URL, SOURCE_BASE } from '../apps/server/src/tiles/builds.ts';

// The worker's tcp/443 outside cf4 reaches only worker_dst4, filled from deploy/host/egress-hosts
// (A§17.4, P3b Q3): a host the code dials but the list lacks fails only in production.

describe('egress-hosts', () => {
  it('names exactly the hosts the worker dials outside Cloudflare', () => {
    const listed = readFileSync(new URL('../deploy/host/egress-hosts', import.meta.url), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter((line) => line !== '');
    const dialed = [
      ...ALLOWED_HOSTS,
      ...[LETTERMINT_URL, HC_PING_ORIGIN, BUILDS_URL, SOURCE_BASE].map((url) => new URL(url).hostname),
    ];
    expect([...listed].sort()).toEqual([...new Set(dialed)].sort());
  });
});
