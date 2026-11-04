import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWED_HOSTS } from '../apps/server/src/museums/sources/http.ts';

// Plan §2.7, CLAUDE.md data rules: no code, fixture or config reaches a museum.nl, OpenStreetMap or Google
// host. ALLOWED_HOSTS in http.ts is the runtime control; this grep test is the second line. Prose (*.md) is
// exempt, and each remaining occurrence is a link-out value, a validator or a negative test, listed below.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SELF = 'test/forbidden-hosts.test.ts';
const FIXTURES = 'apps/server/test/fixtures/museums/';

// A host label run before the dotted name, so `rijksmuseum.nl` is not `museum.nl`. An optional backslash
// before each dot also catches a regex written `museum\.nl`.
const D = String.raw`\\?\.`;
const START = '(?<![a-z0-9-])';
const PATTERNS: Record<string, RegExp> = {
  'museum.nl': new RegExp(`${START}(?:[a-z0-9-]+${D})*museum${D}nl(?![a-z0-9-])`, 'gi'),
  'museumkaart.nl': new RegExp(`${START}(?:[a-z0-9-]+${D})*museumkaart${D}nl`, 'gi'),
  'museumjaarkaart.nl': new RegExp(`${START}(?:[a-z0-9-]+${D})*museumjaarkaart${D}nl`, 'gi'),
  openstreetmap: new RegExp(`${START}(?:[a-z0-9-]+${D})*openstreetmap${D}(?:org|de)`, 'gi'),
  'osm.org': new RegExp(`${START}(?:[a-z0-9-]+${D})*osm${D}org`, 'gi'),
  overpass: new RegExp(`${START}(?:overpass-api${D}de|overpass${D}kumi${D}systems)`, 'gi'),
  nominatim: /nominatim/gi,
  'geofabrik.de': new RegExp(`${START}(?:[a-z0-9-]+${D})*geofabrik${D}de`, 'gi'),
  google: new RegExp(
    `${START}(?:maps${D}google${D}|maps${D}googleapis${D}com|places${D}googleapis${D}com|google${D}com/maps|goo${D}gl/maps)`,
    'gi',
  ),
};

/** Counts the matches per pattern name in a text. */
function scan(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, re] of Object.entries(PATTERNS)) {
    const n = text.match(re)?.length ?? 0;
    if (n > 0) out[name] = n;
  }
  return out;
}

type Allowed = { path: string; pattern: string; count: number; why: string };
const ALLOWED: readonly Allowed[] = [
  {
    path: 'apps/server/src/museums/museumnl.ts',
    pattern: 'museum.nl',
    count: 2,
    why: 'the link-out host constant and its comment',
  },
  {
    path: 'apps/server/src/museums/sources/types.ts',
    pattern: 'museum.nl',
    count: 1,
    why: 'a comment on the P973 link-out hint',
  },
  {
    path: 'db/migrations/20261102000002_museums.sql',
    pattern: 'museum.nl',
    count: 2,
    why: 'the museumnl_url CHECK regex and its comment',
  },
  {
    path: 'apps/server/test/museums/sources/http.test.ts',
    pattern: 'museum.nl',
    count: 1,
    why: 'host_not_allowed: a museum.nl URL is refused',
  },
  {
    path: 'apps/server/test/museums/sources/http.test.ts',
    pattern: 'openstreetmap',
    count: 1,
    why: 'host_not_allowed: an OSM URL is refused',
  },
  {
    path: 'apps/server/test/museums/sources/wikidata.test.ts',
    pattern: 'museum.nl',
    count: 1,
    why: 'negative test: a bare museum.nl P973 is dropped',
  },
  {
    path: 'apps/server/test/museums/diff.test.ts',
    pattern: 'museum.nl',
    count: 1,
    why: 'a link-out value in a diff case',
  },
  {
    path: 'apps/server/test/grants.int.test.ts',
    pattern: 'museum.nl',
    count: 2,
    why: 'link-out values inserted to test grants',
  },
  {
    path: 'apps/server/test/schema.int.test.ts',
    pattern: 'museum.nl',
    count: 5,
    why: 'the CHECK on museumnl_url: accepted and rejected values',
  },
];

/** Removes the P973 link-out values of the recorded answers (`museumnl`) and the goldens (`museumnlUrl`). */
function stripLinkOut(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripLinkOut);
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) if (k !== 'museumnl' && k !== 'museumnlUrl') out[k] = stripLinkOut(v);
    return out;
  }
  return node;
}

function textOf(path: string): string | null {
  const buf = readFileSync(`${ROOT}${path}`);
  if (buf.includes(0)) return null; // binary
  const text = buf.toString('utf8');
  return path.startsWith(FIXTURES) && path.endsWith('.json') ? JSON.stringify(stripLinkOut(JSON.parse(text))) : text;
}

const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter((p) => p !== '' && !p.endsWith('.md') && p !== SELF);

describe('forbidden hosts', () => {
  it('the scanner catches museum.nl, OSM and Google hosts and not the repository name', () => {
    expect(scan('https://www.museum.nl/x')).toEqual({ 'museum.nl': 1 });
    expect(scan('"api.openstreetmap.org"')).toEqual({ openstreetmap: 1 });
    expect(scan(String.raw`^https://www\.museum\.nl/`)).toEqual({ 'museum.nl': 1 });
    expect(scan('https://maps.googleapis.com/x and nominatim')).toEqual({ google: 1, nominatim: 1 });
    expect(scan('github.com/mwijkhuisen/Museumjaarkaart')).toEqual({});
    expect(scan('https://www.rijksmuseum.nl/')).toEqual({});
    expect(scan('museumjaarkaart.nl')).toEqual({ 'museumjaarkaart.nl': 1 });
  });

  it('ALLOWED_HOSTS is exactly Wikidata and RCE', () => {
    expect([...ALLOWED_HOSTS]).toEqual(['query.wikidata.org', 'services.rce.geovoorziening.nl']);
    for (const h of ALLOWED_HOSTS) expect(Object.keys(scan(h))).toEqual([]);
    expect(ALLOWED_HOSTS.some((h) => /commons|wikimedia|upload\./i.test(h))).toBe(false);
  });

  it('only the listed files mention a forbidden host, each as often as listed', () => {
    const found: Record<string, number> = {};
    for (const path of files) {
      const text = textOf(path);
      if (text === null) continue;
      for (const [pattern, n] of Object.entries(scan(text))) found[`${path}\t${pattern}`] = n;
    }
    const expected: Record<string, number> = {};
    for (const a of ALLOWED) expected[`${a.path}\t${a.pattern}`] = a.count;
    expect(found).toEqual(expected);
  });

  it('every allow-list entry names a tracked file and gives a reason', () => {
    for (const a of ALLOWED) {
      expect(files, a.path).toContain(a.path);
      expect(a.why.length).toBeGreaterThan(10);
    }
  });
});
