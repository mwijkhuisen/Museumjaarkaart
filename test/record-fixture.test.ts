import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureMeta } from '../apps/server/src/museums/sources/fixture-meta.ts';
import { wikidataQuerySha256 } from '../apps/server/src/museums/sources/wikidata.ts';
import { parseArgs, type RecordArgs, record, refuseUnderCi } from '../scripts/record-fixture.ts';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(repoRoot, 'apps/server/test/fixtures/museums');
const script = join(repoRoot, 'scripts/record-fixture.ts');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'mjk-rec-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('record-fixture: CI refusal', () => {
  it.each(['', 'false', '0', '1'])('exits 3 with CI=%j and attempts no request', (ci) => {
    // A proxy on a closed port: any request attempt would fail differently (and print more).
    const r = spawnSync(process.execPath, [script, 'wikidata', 'normal'], {
      env: {
        PATH: process.env.PATH ?? '',
        CI: ci,
        HTTPS_PROXY: 'http://127.0.0.1:9',
        HTTP_PROXY: 'http://127.0.0.1:9',
      },
      encoding: 'utf8',
    });
    expect(r.status).toBe(3);
    expect(r.stderr.trim().split('\n')).toEqual([
      'record-fixture: refusing to run under CI (it runs on the owner machine only)',
    ]);
    expect(r.stdout).toBe('');
  });

  it('refuseUnderCi looks at presence only', () => {
    expect(refuseUnderCi({})).toBeUndefined();
    expect(refuseUnderCi({ CI: undefined })).toBeDefined();
    expect(refuseUnderCi({ CI: '' })).toBeDefined();
  });

  it('exits 64 with the usage line for a bad argument (CI unset)', () => {
    const env = { ...process.env };
    delete env.CI;
    const r = spawnSync(process.execPath, [script, 'rce', 'edge'], { env, encoding: 'utf8' });
    expect(r.status).toBe(64);
    expect(r.stderr).toContain('usage: node scripts/record-fixture.ts');
  });
});

describe('record-fixture: parseArgs', () => {
  it('accepts the good cases', () => {
    expect(parseArgs(['wikidata', 'normal'])).toMatchObject({
      ok: true,
      args: { source: 'wikidata', qids: undefined },
    });
    expect(
      parseArgs(['wikidata', 'edge', '--qids', 'Q1,Q22', '--out', '/x', '--contact', 'https://example.org/c']),
    ).toMatchObject({
      ok: true,
      args: { case: 'edge', qids: ['Q1', 'Q22'], out: '/x', contact: 'https://example.org/c' },
    });
    expect(parseArgs(['rce', 'normal'])).toMatchObject({ ok: true, args: { source: 'rce' } });
    expect(parseArgs(['wikidata', 'normal', '--qids', 'Q5'])).toMatchObject({ ok: true });
  });

  it.each([
    [[]],
    [['wikidata']],
    [['wikidata', 'normal', 'extra']],
    [['nope', 'normal']],
    [['wikidata', 'hostile']],
    [['wikidata', 'edge']],
    [['wikidata', 'empty']],
    [['wikidata', 'edge', '--qids', 'Q1,x']],
    [['wikidata', 'edge', '--qids', 'Q0']],
    [['wikidata', 'edge', '--qids', '']],
    [['wikidata', 'edge', '--qids']],
    [['wikidata', 'normal', '--bogus', '1']],
    [['wikidata', 'normal', '--out', 'a', '--out', 'b']],
    [['rce', 'edge']],
    [['rce', 'empty']],
    [['rce', 'normal', '--qids', 'Q1']],
  ])('rejects %j', (argv) => {
    expect(parseArgs(argv)).toMatchObject({ ok: false });
  });
});

describe('record-fixture: record() with an injected fetch', () => {
  type Seen = { calls: number; url?: string; body?: string };
  const wdArgs = (out: string): RecordArgs => ({
    source: 'wikidata',
    case: 'normal',
    qids: ['Q99000101'],
    out,
    contact: undefined,
  });
  const fixtureBody = readFileSync(join(fixtures, 'wikidata/normal.json'), 'utf8');
  const okFetch = (body: string, seen: Seen) =>
    (async (url, init) => {
      seen.calls++;
      seen.url = String(url);
      seen.body = String(init?.body ?? '');
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

  it('writes the data and meta files; the meta passes the schema and the JSON round-trips', async () => {
    const out = tmp();
    const seen: Seen = { calls: 0 };
    const r = await record(wdArgs(out), {
      fetch: okFetch(fixtureBody, seen),
      today: () => '2026-11-02',
      stampFile: join(tmp(), 'stamp'),
    });
    expect(r.ok).toBe(true);
    expect(seen.calls).toBe(1);
    expect(seen.url).toBe('https://query.wikidata.org/sparql');
    expect(seen.body).toContain('Q99000101');
    expect(readdirSync(join(out, 'wikidata')).sort()).toEqual(['normal.json', 'normal.meta.json']);
    const text = readFileSync(join(out, 'wikidata/normal.json'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(JSON.parse(fixtureBody));
    const meta = FixtureMeta.parse(JSON.parse(readFileSync(join(out, 'wikidata/normal.meta.json'), 'utf8')));
    expect(meta).toEqual({
      source: 'wikidata',
      case: 'normal',
      origin: 'recorded',
      recordedOn: '2026-11-02',
      licence: 'CC0-1.0',
      querySha256: wikidataQuerySha256(),
      qids: ['Q99000101'],
    });
    if (r.ok) expect(r.rows).toBeGreaterThan(0);
  });

  it("a full Wikidata recording (no --qids) is the sync's batched fetch: the item list, then the batches", async () => {
    const out = tmp();
    const bodies: string[] = [];
    const list = JSON.stringify({
      head: { vars: ['item'] },
      results: { bindings: [{ item: { type: 'uri', value: 'http://www.wikidata.org/entity/Q99000101' } }] },
    });
    const fetchFn = (async (_url, init) => {
      const query = new URLSearchParams(String(init?.body ?? '')).get('query') ?? '';
      bodies.push(query);
      const body = query.includes('VALUES ?item') ? fixtureBody : list;
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const r = await record(
      { source: 'wikidata', case: 'normal', qids: undefined, out, contact: undefined },
      { fetch: fetchFn, today: () => '2026-11-02', stampFile: join(tmp(), 'stamp'), sleep: async () => {} },
    );
    expect(r.ok).toBe(true);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain('VALUES ?item { wd:Q99000101 }');
    const meta = FixtureMeta.parse(JSON.parse(readFileSync(join(out, 'wikidata/normal.meta.json'), 'utf8')));
    expect(meta.querySha256).toBe(wikidataQuerySha256());
  });

  it('records RCE with the PDM licence and no query hash', async () => {
    const out = tmp();
    const body = readFileSync(join(fixtures, 'rce/normal.json'), 'utf8');
    const r = await record(
      { source: 'rce', case: 'normal', qids: undefined, out, contact: undefined },
      { fetch: okFetch(body, { calls: 0 }), today: () => '2026-11-02' },
    );
    expect(r.ok).toBe(true);
    const meta = FixtureMeta.parse(JSON.parse(readFileSync(join(out, 'rce/normal.meta.json'), 'utf8')));
    expect(meta.licence).toBe('PDM-1.0');
    expect(meta.querySha256).toBeUndefined();
  });

  it('pauses 10 s when the last Wikidata request was under 60 s ago', async () => {
    const stamp = join(tmp(), 'stamp');
    writeFileSync(stamp, String(1_000_000));
    const slept: number[] = [];
    await record(wdArgs(tmp()), {
      fetch: okFetch(fixtureBody, { calls: 0 }),
      stampFile: stamp,
      now: () => 1_030_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(slept).toEqual([10_000]);
  });

  it('returns the fetcher code on a failure and writes nothing', async () => {
    const out = tmp();
    const r = await record(wdArgs(out), {
      fetch: (async () => new Response('nope', { status: 500 })) as typeof fetch,
      stampFile: join(tmp(), 'stamp'),
    });
    expect(r).toEqual({ ok: false, code: 'http_status' });
    expect(existsSync(join(out, 'wikidata'))).toBe(false);
  });
});

describe('museum fixture metas', () => {
  // One directory per source; week2.ts (a derived fixture) sits beside them.
  const sources = readdirSync(fixtures, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const metas = sources.flatMap((source) =>
    readdirSync(join(fixtures, source))
      .filter((f) => f.endsWith('.meta.json'))
      .map((f) => join(fixtures, source, f)),
  );

  it('finds the metas', () => {
    expect(metas.length).toBeGreaterThanOrEqual(8);
  });

  it.each(metas.map((m) => [m.slice(fixtures.length + 1), m] as const))('%s passes the schema', (_, file) => {
    const meta = FixtureMeta.parse(JSON.parse(readFileSync(file, 'utf8')));
    // Every Wikidata fixture (synthetic ones too, as WP2 wrote them) pins the current query.
    if (meta.source === 'wikidata') expect(meta.querySha256).toBe(wikidataQuerySha256());
    expect(existsSync(file.replace('.meta.json', '.json'))).toBe(true);
  });
});
