import { expect, it } from 'vitest';
import { createLogger, memoryLogger } from '../src/lib/log.ts';

it('writes one JSON line per call with the role, level, time, fields and msg', () => {
  const chunks: string[] = [];
  const logger = createLogger({ role: 'worker', destination: { write: (c) => chunks.push(c) } });
  logger.info({ kind: 'museum_sync', id: '7', ms: 12, ok: true }, 'job_done');
  logger.error({}, 'db_unavailable');
  expect(chunks).toHaveLength(2);
  expect(chunks.every((c) => c.endsWith('\n'))).toBe(true);
  const [first, second] = chunks.map((c) => JSON.parse(c));
  expect(first).toEqual({
    level: 30,
    time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
    role: 'worker',
    kind: 'museum_sync',
    id: '7',
    ms: 12,
    ok: true,
    msg: 'job_done',
  });
  expect(second).toMatchObject({ level: 50, role: 'worker', msg: 'db_unavailable' });
});

it('carries no pid or hostname', () => {
  const { logger, lines } = memoryLogger('api');
  logger.warn({ n: 1 }, 'something');
  const [line] = lines();
  expect(line).toBeDefined();
  expect(Object.keys(line as object).sort()).toEqual(['level', 'msg', 'n', 'role', 'time']);
});

it('memoryLogger collects the lines in order and its role defaults to test', () => {
  const { logger, lines } = memoryLogger();
  logger.info({}, 'a');
  logger.info({}, 'b');
  expect(lines().map((l) => [l.role, l.msg])).toEqual([
    ['test', 'a'],
    ['test', 'b'],
  ]);
});

it('never serialises an error under the err key', () => {
  const { logger, lines } = memoryLogger();
  // Not allowed by the types; this proves the safety net if a cast ever sneaks one in.
  logger.error({ err: new Error('mail to someone@example.invalid failed') } as never, 'oops');
  expect(JSON.stringify(lines())).not.toContain('someone@example.invalid');
});
