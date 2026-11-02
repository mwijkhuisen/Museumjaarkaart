// Records a real Wikidata or RCE answer as a museum fixture (plan §2.2, owner action O1).
// Usage: node scripts/record-fixture.ts <wikidata|rce> <normal|edge|empty> [--qids Q1,Q2,…] [--out <dir>] [--contact <email or https URL>]
//
// Wikimedia etiquette: a descriptive User-Agent (the sync's own, with --contact), ONE query per run,
// and a pause between recordings: this script sleeps 10 s first when it ran a Wikidata request
// less than 60 s ago (a timestamp file under os.tmpdir()). It runs on the owner's machine only
// and refuses under CI (exit 3) before it parses anything or imports the fetchers.
// It prints counts and timings, never row content.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleepFor } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { FixtureMeta } from '../apps/server/src/museums/sources/fixture-meta.ts';
import type { HttpDeps } from '../apps/server/src/museums/sources/http.ts';

export const USAGE =
  'usage: node scripts/record-fixture.ts <wikidata|rce> <normal|edge|empty> [--qids Q1,Q2,…] [--out <dir>] [--contact <email or https URL>]';
export const EXIT_CI = 3;
export const EXIT_USAGE = 64;
export const DEFAULT_OUT = fileURLToPath(new URL('../apps/server/test/fixtures/museums', import.meta.url));
export const PAUSE_MS = 10_000;
export const PAUSE_WINDOW_MS = 60_000;
export const STAMP_FILE = 'mjk-record-fixture.stamp';
const QID_RE = /^Q[1-9][0-9]{0,11}$/;
const MAX_QIDS = 500;

export type RecordArgs = {
  source: 'wikidata' | 'rce';
  case: 'normal' | 'edge' | 'empty';
  qids: string[] | undefined;
  out: string;
  contact: string | undefined;
};
export type ParsedArgs = { ok: true; args: RecordArgs } | { ok: false; reason: string };

/** The refusal text when `CI` is set at all (even empty, `false` or `0`), else undefined. */
export function refuseUnderCi(env: Readonly<Record<string, string | undefined>>): string | undefined {
  return 'CI' in env ? 'record-fixture: refusing to run under CI (it runs on the owner machine only)' : undefined;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const bad = (reason: string): ParsedArgs => ({ ok: false, reason });
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!['qids', 'out', 'contact'].includes(name)) return bad('unknown option');
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--') || flags.has(name)) return bad('bad option value');
      flags.set(name, value);
      i++;
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) return bad('need a source and a case');
  const [source, kind] = positional;
  if (source !== 'wikidata' && source !== 'rce') return bad('unknown source');
  if (kind !== 'normal' && kind !== 'edge' && kind !== 'empty') return bad('unknown case');

  let qids: string[] | undefined;
  const rawQids = flags.get('qids');
  if (rawQids !== undefined) {
    if (source === 'rce') return bad('rce takes no --qids');
    qids = rawQids.split(',');
    if (qids.length > MAX_QIDS || qids.some((q) => !QID_RE.test(q))) return bad('bad --qids');
  }
  if (source === 'rce' && kind !== 'normal') {
    return bad('rce records only the normal case (RCE has no restriction; its edge cases stay synthetic)');
  }
  if (source === 'wikidata' && kind !== 'normal' && qids === undefined) return bad('edge and empty need --qids');

  return {
    ok: true,
    args: { source, case: kind, qids, out: flags.get('out') ?? DEFAULT_OUT, contact: flags.get('contact') },
  };
}

/** The `.meta.json` of a recording; `querySha256` is the Wikidata query's hash. */
export function metaFor(args: RecordArgs, today: string, querySha256: string | undefined): FixtureMeta {
  const meta: FixtureMeta = {
    source: args.source,
    case: args.case,
    origin: 'recorded',
    recordedOn: today,
    licence: args.source === 'wikidata' ? 'CC0-1.0' : 'PDM-1.0',
  };
  if (args.source === 'wikidata' && querySha256 !== undefined) meta.querySha256 = querySha256;
  if (args.qids !== undefined) meta.qids = args.qids;
  return meta;
}

export type RecordDeps = HttpDeps & {
  today?: () => string;
  /** The timestamp file of the last Wikidata request. */
  stampFile?: string;
};

export type RecordResult = { ok: true; rows: number; ms: number; files: string[] } | { ok: false; code: string };

function countRows(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0;
  const o = body as { results?: { bindings?: unknown }; features?: unknown };
  const list = o.results?.bindings ?? o.features;
  return Array.isArray(list) ? list.length : 0;
}

function readStamp(file: string): number | undefined {
  try {
    const n = Number(readFileSync(file, 'utf8').trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** Fetches with the sync's own fetchers (one request), then writes `<out>/<source>/<case>.json` and `.meta.json`. */
export async function record(args: RecordArgs, deps: RecordDeps = {}): Promise<RecordResult> {
  // Imported here, after the CI refusal, so a refused run loads none of the fetcher code.
  const { wikidataQuery, wikidataQuerySha256, fetchWikidata } = await import(
    '../apps/server/src/museums/sources/wikidata.ts'
  );
  const { fetchRce } = await import('../apps/server/src/museums/sources/rce.ts');
  const { FixtureMeta: MetaSchema } = await import('../apps/server/src/museums/sources/fixture-meta.ts');

  const { today, stampFile, ...http } = deps;
  const httpDeps: HttpDeps = { ...http, ...(args.contact === undefined ? {} : { contact: args.contact }) };
  const now = http.now ?? Date.now;
  const sleep = http.sleep ?? ((ms: number) => sleepFor(ms));

  let result: Awaited<ReturnType<typeof fetchRce>>;
  if (args.source === 'wikidata') {
    const stamp = stampFile ?? join(tmpdir(), STAMP_FILE);
    const last = readStamp(stamp);
    if (last !== undefined && now() - last >= 0 && now() - last < PAUSE_WINDOW_MS) await sleep(PAUSE_MS);
    let query: string;
    try {
      query = wikidataQuery(args.qids === undefined ? {} : { qids: args.qids });
    } catch {
      return { ok: false, code: 'bad_query' };
    }
    try {
      writeFileSync(stamp, String(now()));
    } catch {
      // The pause is a courtesy; a missing stamp is not an error.
    }
    result = await fetchWikidata(query, httpDeps);
  } else {
    result = await fetchRce(httpDeps);
  }
  if (!result.ok) return { ok: false, code: result.code };

  const day = (today ?? (() => new Date().toISOString().slice(0, 10)))();
  const meta = MetaSchema.parse(metaFor(args, day, args.source === 'wikidata' ? wikidataQuerySha256() : undefined));
  const dir = join(args.out, args.source);
  mkdirSync(dir, { recursive: true });
  const data = join(dir, `${args.case}.json`);
  const metaFile = join(dir, `${args.case}.meta.json`);
  writeFileSync(data, `${JSON.stringify(result.body, null, 2)}\n`);
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return { ok: true, rows: countRows(result.body), ms: result.ms, files: [data, metaFile] };
}

if (import.meta.main) {
  const refusal = refuseUnderCi(process.env);
  if (refusal !== undefined) {
    console.error(refusal);
    process.exit(EXIT_CI);
  }
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`record-fixture: ${parsed.reason}\n${USAGE}`);
    process.exit(EXIT_USAGE);
  }
  const args = parsed.args;
  const contact = args.contact ?? process.env.MJK_SYNC_CONTACT;
  const result = await record({ ...args, contact });
  if (!result.ok) {
    console.error(`record-fixture: failed (${result.code})`);
    process.exit(1);
  }
  console.log(`record-fixture: ${args.source}/${args.case}: ${result.rows} rows in ${result.ms} ms`);
  console.log('Regenerate the goldens with `pnpm test -- -u`, then look at the diff before you commit.');
}
