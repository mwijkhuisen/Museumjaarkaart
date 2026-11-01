import { readFile, writeFile } from 'node:fs/promises';
import { createDb, type Db } from '../db/kysely.ts';
import { EXIT_CONFIG } from '../db/migrate.ts';
import { ADMIN_POOL_MAX, createPool } from '../db/pool.ts';
import { writeCsv } from '../museums/csv.ts';
import {
  AdminError,
  EDITABLE,
  EXIT_DATA,
  EXIT_NOT_FOUND,
  EXIT_USAGE,
  exportRows,
  flagMuseum,
  ImportRefused,
  importCsv,
  priceMuseum,
  publishList,
  type Summary,
  showList,
} from '../museums/curation.ts';

// The `admin` role (A§5, plan §2.6): the owner's curation tool, run as `mjk_api`. Exit codes:
// 0 ok · 64 usage · 65 bad data · 66 not found · 78 config · 2 a command a later phase builds.

export { EXIT_CONFIG, EXIT_DATA, EXIT_NOT_FOUND, EXIT_USAGE };
export const EXIT_NOT_BUILT = 2;

type Env = Readonly<Record<string, string | undefined>>;

export type AdminIo = {
  out(line: string): void;
  err(line: string): void;
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
};

export const nodeIo = (): AdminIo => ({
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, text) => writeFile(path, text, 'utf8'),
});

/**
 * Museum names come from Wikidata and are untrusted: control characters (ESC and friends) and the
 * bidi and zero-width format characters never reach the terminal.
 */
export const clean = (s: string): string => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').slice(0, 120);

// --- argument parsing ----------------------------------------------------------------------------

type Spec = {
  min: number;
  max: number;
  values?: readonly string[];
  bools?: readonly string[];
  required?: readonly string[];
};
type Parsed = { pos: string[]; flags: Map<string, string | true> };
export type Ctx = { pos: string[]; flags: Map<string, string | true>; db: Db; io: AdminIo };
export type Command = { spec: Spec; run(ctx: Ctx): Promise<number> };
export type Group = Record<string, Command>;

function parseArgs(args: readonly string[], spec: Spec): Parsed | undefined {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const name = a.slice(2);
    if (flags.has(name)) return undefined;
    if (spec.bools?.includes(name)) flags.set(name, true);
    else if (spec.values?.includes(name)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) return undefined;
      flags.set(name, v);
    } else return undefined;
  }
  if (pos.length < spec.min || pos.length > spec.max) return undefined;
  return spec.required?.every((r) => flags.has(r)) === false ? undefined : { pos, flags };
}

const flag = (ctx: Ctx, name: string): string | undefined => {
  const v = ctx.flags.get(name);
  return typeof v === 'string' ? v : undefined;
};

/** Optional properties stay absent, not undefined (exactOptionalPropertyTypes). */
const given = <K extends string>(o: Record<K, string | undefined>): { [P in K]?: string } =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [P in K]?: string };

// --- commands ------------------------------------------------------------------------------------

function printSummary(io: AdminIo, s: Summary) {
  io.out(`${s.slug} (${clean(s.name)}): ${s.changed.length === 0 ? 'no change' : `changed ${s.changed.join(', ')}`}`);
}

const museum: Group = {
  flag: {
    spec: { min: 2, max: 2, values: ['since', 'until', 'verified'] },
    async run(ctx) {
      const [ref, status] = ctx.pos as [string, string];
      const s = await flagMuseum(
        ctx.db,
        ref,
        status,
        given({ since: flag(ctx, 'since'), until: flag(ctx, 'until'), verified: flag(ctx, 'verified') }),
      );
      printSummary(ctx.io, s);
      return 0;
    },
  },
  price: {
    spec: { min: 1, max: 2, values: ['verified'], bools: ['clear'] },
    async run(ctx) {
      const clear = ctx.flags.has('clear');
      if (ctx.pos.length !== (clear ? 1 : 2)) throw new AdminError(EXIT_USAGE, 'usage');
      const [ref, cents] = ctx.pos as [string, string | undefined];
      if (!clear && !/^(0|[1-9][0-9]{0,8})$/.test(cents as string)) throw new AdminError(EXIT_DATA, 'bad_price');
      const s = await priceMuseum(ctx.db, ref, clear ? null : Number(cents), flag(ctx, 'verified'));
      printSummary(ctx.io, s);
      return 0;
    },
  },
  export: {
    spec: { min: 0, max: 0, values: ['csv'], required: ['csv'] },
    async run(ctx) {
      const path = flag(ctx, 'csv');
      if (path === undefined) throw new AdminError(EXIT_USAGE, 'usage');
      const rows = await exportRows(ctx.db);
      await ctx.io.writeFile(path, writeCsv(rows));
      ctx.io.out(`exported ${rows.length - 1} museums`);
      return 0;
    },
  },
  import: {
    spec: { min: 0, max: 0, values: ['csv'], bools: ['dry-run'], required: ['csv'] },
    async run(ctx) {
      const path = flag(ctx, 'csv');
      if (path === undefined) throw new AdminError(EXIT_USAGE, 'usage');
      let text: string;
      try {
        text = await ctx.io.readFile(path);
      } catch {
        throw new AdminError(EXIT_NOT_FOUND, 'file_not_found');
      }
      const dry = ctx.flags.has('dry-run');
      const r = await importCsv(ctx.db, text, dry);
      ctx.io.out(`${dry ? 'dry run: nothing written, ' : ''}${r.rows} rows read, ${r.changedRows} rows changed`);
      for (const f of EDITABLE) if (r.counts[f] !== undefined) ctx.io.out(`  ${f}: ${r.counts[f]}`);
      return 0;
    },
  },
};

const list: Group = {
  publish: {
    spec: { min: 0, max: 0, values: ['date'] },
    async run(ctx) {
      const r = await publishList(ctx.db, flag(ctx, 'date'));
      ctx.io.out(`published list of ${r.publishedOn}: N = ${r.n}`);
      return 0;
    },
  },
  show: {
    spec: { min: 0, max: 0 },
    async run(ctx) {
      const r = await showList(ctx.db);
      ctx.io.out(r === undefined ? 'no list published' : `N = ${r.n}, list of ${r.publishedOn}`);
      return 0;
    },
  },
};

/** The groups that are built. Part b adds `match` and `change` here and drops them from NOT_BUILT. */
export const GROUPS: Record<string, Group> = { museum, list };
/** Groups of later phases (and of part b): exit 2. */
export const NOT_BUILT: readonly string[] = ['invite', 'user', 'match', 'change'];

const USAGE =
  'usage: admin <museum flag|price|export|import | list publish|show> …  (admin <group> <command> --help is not built)';

// --- dispatch ------------------------------------------------------------------------------------

export async function runAdmin(argv: readonly string[], env: Env, io: AdminIo): Promise<number> {
  const [group, sub, ...rest] = argv;
  if (group !== undefined && NOT_BUILT.includes(group) && GROUPS[group] === undefined) {
    io.err(`admin ${group} is not built yet`);
    return EXIT_NOT_BUILT;
  }
  const cmd = group === undefined || sub === undefined ? undefined : GROUPS[group]?.[sub];
  if (cmd === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const parsed = parseArgs(rest, cmd.spec);
  if (parsed === undefined) {
    io.err(USAGE);
    return EXIT_USAGE;
  }
  const pool = createPool('mjk_api', env, { max: ADMIN_POOL_MAX });
  if (typeof pool === 'string') {
    // The text names a secret file, never its content; a fixed line is still all that is printed.
    io.err('admin: the database configuration is missing or invalid');
    return EXIT_CONFIG;
  }
  const db = createDb(pool);
  try {
    return await cmd.run({ ...parsed, db, io });
  } catch (err) {
    if (err instanceof ImportRefused) {
      io.err(`admin: ${err.code}`);
      for (const i of err.issues) io.err(`  row ${i.row}${i.column === '' ? '' : ` ${i.column}`}: ${i.code}`);
      return err.exit;
    }
    if (err instanceof AdminError) {
      io.err(`admin: ${err.code}`);
      return err.exit;
    }
    // A pg error's message can quote data: only its five-character SQLSTATE is printed.
    const code = (err as { code?: unknown }).code;
    io.err(`admin: failed${typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? ` (${code})` : ''}`);
    return 1;
  } finally {
    await db.destroy();
  }
}
