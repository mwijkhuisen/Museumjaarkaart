import { afterAll, beforeAll, expect, it } from 'vitest';
import { type Harness, openHarness } from './harness.ts';

// `admin tiles refresh|rollback` as mjk_api (A§15.3): they only queue the job; the worker holds the R2 secret.

let h: Harness;
beforeAll(async () => {
  h = await openHarness();
});
afterAll(async () => {
  await h?.close();
});

const jobs = async () =>
  (
    await h.api.query<{ kind: string; state: string; payload: unknown; max_attempts: number }>(
      'SELECT kind, state, payload, max_attempts FROM job ORDER BY kind',
    )
  ).rows;

it('queues each job once; a second request while one is open says so and queues nothing', async () => {
  expect(await h.admin('tiles', 'refresh')).toEqual({ code: 0, out: ['tiles_refresh queued'], err: [] });
  expect(await h.admin('tiles', 'refresh')).toEqual({
    code: 0,
    out: ['tiles_refresh is already queued or running'],
    err: [],
  });
  expect(await h.admin('tiles', 'rollback')).toEqual({ code: 0, out: ['tiles_rollback queued'], err: [] });
  expect(await jobs()).toEqual([
    { kind: 'tiles_refresh', state: 'queued', payload: {}, max_attempts: 3 },
    { kind: 'tiles_rollback', state: 'queued', payload: {}, max_attempts: 3 },
  ]);
});
