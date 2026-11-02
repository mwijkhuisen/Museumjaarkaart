import { describe, expect, it } from 'vitest';
import { type AdminIo, clean, runAdmin } from '../../src/admin/cli.ts';

// A URL whose host nothing listens on: every case below stops before a query, or fails to connect.
const SECRET_URL = 'postgres://mjk_api:s3cret-pw@127.0.0.1:1/none';

function harness() {
  const out: string[] = [];
  const err: string[] = [];
  const io: AdminIo = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    readFile: async () => {
      throw new Error('nope');
    },
    writeFile: async () => {},
  };
  return { io, out, err };
}

describe('runAdmin', () => {
  it.each([['invite'], ['user']])('%s is not built yet: exit 2', async (group) => {
    const h = harness();
    expect(await runAdmin([group, 'list'], {}, h.io)).toBe(2);
    expect(h.err).toEqual([`admin ${group} is not built yet`]);
  });

  it.each([
    [[]],
    [['museum']],
    [['museum', 'nope']],
    [['nope', 'x']],
    [['list', 'show', 'extra']],
    [['list', 'publish', '--date']],
    [['list', 'publish', '--bogus', 'x']],
    [['museum', 'flag', 'Q1']],
    [['museum', 'export']],
    [['museum', 'import']],
    [['museum', 'slug']],
    [['museum', 'flag', 'Q1', 'participating', '--since', '2020-01-01', '--since', '2020-01-02']],
  ])('usage error %j: exit 64, before any connection', async (argv) => {
    const h = harness();
    expect(await runAdmin(argv, {}, h.io)).toBe(64);
  });

  it('a config error exits 78 and prints no URL or secret', async () => {
    const h = harness();
    expect(await runAdmin(['list', 'show'], { PATH: '/bin' }, h.io)).toBe(78);
    expect(h.err.join('\n')).not.toMatch(/postgres|:\/\/|db_mjk/);
  });

  it('left without --until, a bad date and a bad status are usage errors; no output echoes the URL', async () => {
    const h = harness();
    const env = { DATABASE_URL: SECRET_URL };
    expect(await runAdmin(['museum', 'flag', 'Q1', 'left'], env, h.io)).toBe(64);
    expect(await runAdmin(['museum', 'flag', 'Q1', 'participating', '--since', '2026-02-30'], env, h.io)).toBe(64);
    expect(await runAdmin(['museum', 'flag', 'Q1', 'maybe'], env, h.io)).toBe(64);
    expect(await runAdmin(['museum', 'price', 'Q1', '--clear', '5'], env, h.io)).toBe(64);
    expect(h.err.join('\n')).not.toMatch(/s3cret|postgres/);
  });

  it.each([
    [['match', 'resolve', 'wikidata:Q1']],
    [['match', 'resolve', 'junk', '--new']],
    [['match', 'resolve', 'rce:x', '--new', '--ignore']],
    [['match', 'resolve', 'rce:x', '--ignore', '--replace-qid']],
    [['match', 'list', '--reason', 'whatever']],
    [['match', 'list', '--source', 'osm']],
    [['change', 'list', '--field', 'nope']],
    [['change', 'apply', '--close', '2026-02-30', '019a0000-0000-7000-8000-000000000000']],
    [['museum', 'slug', 'Q1']],
    [['museum', 'slug', 'Q1', 'new-slug', '--from-name']],
    [['museum', 'slug', 'Q1', 'new-slug', 'extra']],
    [['museum', 'slug', 'Q1', '--from-name', '--from-name']],
  ])('match, change and slug usage error %j: exit 64 before any query', async (argv) => {
    const h = harness();
    expect(await runAdmin(argv, { DATABASE_URL: SECRET_URL }, h.io)).toBe(64);
    expect(h.err.join('\n')).not.toMatch(/s3cret|postgres/);
  });

  it.each([[['change', 'apply']], [['change', 'reject']], [['match', 'resolve']]])(
    'missing arguments %j: exit 64 before any connection',
    async (argv) => {
      const h = harness();
      expect(await runAdmin(argv, {}, h.io)).toBe(64);
    },
  );

  it('a bad price is exit 65', async () => {
    const h = harness();
    const env = { DATABASE_URL: SECRET_URL };
    for (const bad of ['20001', '-1', '12.5', 'abc']) {
      expect(await runAdmin(['museum', 'price', 'Q1', bad], env, h.io)).toBe(65);
    }
  });

  it('a missing import file is exit 66', async () => {
    const h = harness();
    expect(await runAdmin(['museum', 'import', '--csv', 'gone.csv'], { DATABASE_URL: SECRET_URL }, h.io)).toBe(66);
  });

  it('an unreachable database prints only a fixed failure line', async () => {
    const h = harness();
    expect(await runAdmin(['list', 'show'], { DATABASE_URL: SECRET_URL }, h.io)).toBe(1);
    expect(h.err.join('\n')).not.toMatch(/s3cret|127\.0\.0\.1|postgres/);
  });
});

describe('clean', () => {
  it('strips control, escape and bidi characters', () => {
    expect(clean('a\u001b[31mb‮c​d\ne')).toBe('a[31mbcde');
  });
});
