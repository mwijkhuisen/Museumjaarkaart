import { describe, expect, it } from 'vitest';
import { readApiConfig } from '../../src/api/config.ts';

// readApiConfig (P1e WP5): MJK_DOMAIN, CF_ACCESS_TEAM and CF_ACCESS_AUD are required; a bad value
// names the variable, never the value. Tests use the team `test-team` and an AUD of 64 `a`s.

const AUD = 'a'.repeat(64);
const ok = { MJK_DOMAIN: 'mjk.test', CF_ACCESS_TEAM: 'test-team', CF_ACCESS_AUD: AUD };

describe('readApiConfig', () => {
  it('reads the domain, the admin host, the team and the AUD', () => {
    expect(readApiConfig(ok)).toEqual({
      domain: 'mjk.test',
      adminHost: 'admin.mjk.test',
      accessTeam: 'test-team',
      accessAud: AUD,
    });
  });

  it.each([
    [{ MJK_DOMAIN: undefined }, 'MJK_DOMAIN is missing'],
    [{ MJK_DOMAIN: '' }, 'MJK_DOMAIN is missing'],
    [{ MJK_DOMAIN: 'Evil Domain' }, 'MJK_DOMAIN must be a lowercase host name with a dot'],
    [{ MJK_DOMAIN: 'MJK.test' }, 'MJK_DOMAIN must be a lowercase host name with a dot'],
    [{ MJK_DOMAIN: 'localhost' }, 'MJK_DOMAIN must be a lowercase host name with a dot'],
    [
      { MJK_DOMAIN: `${'a'.repeat(61)}.${'b'.repeat(61)}.${'c'.repeat(61)}.${'d'.repeat(61)}.nl` },
      'MJK_DOMAIN must be a lowercase host name with a dot',
    ],
    [{ CF_ACCESS_TEAM: undefined }, 'CF_ACCESS_TEAM is missing'],
    [{ CF_ACCESS_TEAM: '' }, 'CF_ACCESS_TEAM is missing'],
    [{ CF_ACCESS_TEAM: 'Test-Team' }, 'CF_ACCESS_TEAM must be one label of lowercase letters, digits and hyphens'],
    [{ CF_ACCESS_TEAM: 'evil.com/x' }, 'CF_ACCESS_TEAM must be one label of lowercase letters, digits and hyphens'],
    [{ CF_ACCESS_TEAM: 'a.b' }, 'CF_ACCESS_TEAM must be one label of lowercase letters, digits and hyphens'],
    [{ CF_ACCESS_TEAM: '-team' }, 'CF_ACCESS_TEAM must be one label of lowercase letters, digits and hyphens'],
    [{ CF_ACCESS_AUD: undefined }, 'CF_ACCESS_AUD is missing'],
    [{ CF_ACCESS_AUD: 'a'.repeat(63) }, 'CF_ACCESS_AUD must be 64 lowercase hex characters'],
    [{ CF_ACCESS_AUD: 'a'.repeat(65) }, 'CF_ACCESS_AUD must be 64 lowercase hex characters'],
    [{ CF_ACCESS_AUD: 'A'.repeat(64) }, 'CF_ACCESS_AUD must be 64 lowercase hex characters'],
    [{ CF_ACCESS_AUD: 'g'.repeat(64) }, 'CF_ACCESS_AUD must be 64 lowercase hex characters'],
  ])('%j → %s', (patch, message) => {
    const r = readApiConfig({ ...ok, ...patch });
    expect(r).toBe(message);
    for (const value of Object.values(patch)) if (value !== undefined && value !== '') expect(r).not.toContain(value);
  });
});
