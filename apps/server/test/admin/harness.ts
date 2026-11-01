import pg from 'pg';
import { type AdminIo, runAdmin } from '../../src/admin/cli.ts';
import { createMigratedDb, type TestDb } from '../db.ts';

// Shared by the curation integration tests: a migrated database, museums inserted as mjk_api with
// bound parameters, and the admin CLI run in-process with an in-memory file system.

export type Seed = {
  slug: string;
  name: string;
  qid?: string | null;
  place?: string | null;
  status?: 'participating' | 'left' | 'unknown';
  until?: string | null;
  hidden?: boolean;
};

export type Harness = {
  db: TestDb;
  api: pg.Client;
  files: Map<string, string>;
  /** Runs `admin <argv>` as mjk_api; returns the exit code and the output lines. */
  admin(...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }>;
  seed(rows: readonly Seed[]): Promise<string[]>;
  close(): Promise<void>;
};

export async function openHarness(): Promise<Harness> {
  const db = await createMigratedDb();
  const api = new pg.Client({ connectionString: db.urls.mjk_api });
  await api.connect();
  const files = new Map<string, string>();
  return {
    db,
    api,
    files,
    async admin(...argv) {
      const out: string[] = [];
      const err: string[] = [];
      const io: AdminIo = {
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        readFile: async (p) => {
          const f = files.get(p);
          if (f === undefined) throw new Error('missing');
          return f;
        },
        writeFile: async (p, t) => {
          files.set(p, t);
        },
      };
      const code = await runAdmin(argv, { DATABASE_URL: db.urls.mjk_api }, io);
      return { code, out, err };
    },
    async seed(rows) {
      const ids: string[] = [];
      for (const r of rows) {
        const { rows: got } = await api.query<{ id: string }>(
          `INSERT INTO museum (slug, name, wikidata_qid, place, museumkaart_status, mk_until, hidden)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [r.slug, r.name, r.qid ?? null, r.place ?? null, r.status ?? 'unknown', r.until ?? null, r.hidden ?? false],
        );
        ids.push((got[0] as { id: string }).id);
      }
      return ids;
    },
    async close() {
      await api.end();
      await db.drop();
    },
  };
}
