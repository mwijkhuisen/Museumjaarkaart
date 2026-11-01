import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './db.ts';

// A§17.2 [U P0]: under `log_error_verbosity = terse` and
// `log_min_error_statement = panic` a constraint error never writes a value
// (such as an email) to the server log. The compose `db` service sets both
// server-wide; this test sets them per connection and compares with a control
// connection on the defaults, so it also proves the log is captured. Needs
// PG_LOG_CONTAINER: the id or name of the container that runs the server.

const exec = promisify(execFile);
const container = process.env.PG_LOG_CONTAINER;

const rnd = () => randomBytes(6).toString('hex');

async function dockerLog(name: string): Promise<string> {
  const { stdout, stderr } = await exec('docker', ['logs', name], { maxBuffer: 256 * 1024 * 1024 });
  return `${stdout}\n${stderr}`; // PostgreSQL logs to stderr
}

type Markers = { unique: string; check: string; type: string };
const markers = (kind: 'terse' | 'control'): Markers => {
  const r = rnd();
  return {
    unique: `${kind}-unique-${r}@example.invalid`,
    check: `${kind}-check-${r}@example.invalid`,
    type: `${kind}-type-${r}`,
  };
};

/** Provokes a unique violation, a check violation and a type-input error; the values only go in as parameters. */
async function provoke(c: pg.Client, m: Markers) {
  await c.query('INSERT INTO probe_log (email, n) VALUES ($1, 1)', [m.unique]);
  await expect(c.query('INSERT INTO probe_log (email, n) VALUES ($1, 1)', [m.unique])).rejects.toMatchObject({
    code: '23505',
  });
  await expect(c.query('INSERT INTO probe_log (email, n) VALUES ($1, -1)', [m.check])).rejects.toMatchObject({
    code: '23514',
  });
  await expect(c.query('SELECT $1::int', [m.type])).rejects.toMatchObject({ code: '22P02' });
}

if (container === undefined || container === '') {
  if (process.env.CI) {
    it('PG_LOG_CONTAINER is set in CI', () => {
      expect.fail('PG_LOG_CONTAINER must name the PostgreSQL container in CI');
    });
  } else {
    it.skip('terse logging hides values (skipped: PG_LOG_CONTAINER, the PostgreSQL container, is not set)', () => {});
  }
} else {
  describe('PostgreSQL error log (container from PG_LOG_CONTAINER)', () => {
    let db: TestDb;
    const clients: pg.Client[] = [];
    const connect = async () => {
      const c = new pg.Client({ connectionString: db.urls.admin });
      await c.connect();
      clients.push(c);
      return c;
    };

    beforeAll(async () => {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(container)) throw new Error('PG_LOG_CONTAINER is not a container name');
      db = await createTestDb();
      const c = await connect();
      await c.query('CREATE TABLE probe_log (email text UNIQUE, n int CHECK (n > 0))');
    });
    afterAll(async () => {
      await Promise.all(clients.map((c) => c.end()));
      await db.drop();
    });

    it('a unique or check violation writes its value to the log by default and not under terse', {
      timeout: 60_000,
    }, async () => {
      const control = markers('control');
      const terse = markers('terse');

      const t = await connect();
      await t.query('SET log_error_verbosity = terse');
      await t.query('SET log_min_error_statement = panic');
      await provoke(t, terse);

      const d = await connect();
      await provoke(d, control);

      // The log is written asynchronously: wait until the control values show up.
      let log = '';
      for (let i = 0; i < 30; i++) {
        log = await dockerLog(container);
        if (log.includes(control.unique) && log.includes(control.check)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      // Only booleans are asserted: a failure never prints the log.
      const found = {
        controlUnique: log.includes(control.unique),
        controlCheck: log.includes(control.check),
        terseUnique: log.includes(terse.unique),
        terseCheck: log.includes(terse.check),
      };
      expect(found).toEqual({ controlUnique: true, controlCheck: true, terseUnique: false, terseCheck: false });
    });

    it('a type-input error still quotes the value in the primary message under terse', {
      timeout: 60_000,
    }, async () => {
      const control = markers('control');
      const terse = markers('terse');

      const t = await connect();
      await t.query('SET log_error_verbosity = terse');
      await t.query('SET log_min_error_statement = panic');
      await expect(t.query('SELECT $1::int', [terse.type])).rejects.toMatchObject({ code: '22P02' });
      const d = await connect();
      await expect(d.query('SELECT $1::int', [control.type])).rejects.toMatchObject({ code: '22P02' });

      let log = '';
      for (let i = 0; i < 30; i++) {
        log = await dockerLog(container);
        if (log.includes(control.type)) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect({ controlType: log.includes(control.type), terseType: log.includes(terse.type) }).toEqual({
        controlType: true,
        terseType: true,
      });
    });
  });
}
