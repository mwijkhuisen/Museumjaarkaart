import { afterEach, expect, it } from 'vitest';
import type { Db } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import { MUSEUM_SYNC_PATTERN, SCHEDULE_TIMEZONE, type Schedule, startSchedule } from '../../src/worker/schedule.ts';

// The callback never runs here (the next run is days away), so no database is needed.
let schedule: Schedule | undefined;
afterEach(() => schedule?.stop());

const amsterdam = (d: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: SCHEDULE_TIMEZONE,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);

it('exports the Tuesday 03:17 Amsterdam schedule and protects against overlapping runs', () => {
  expect(MUSEUM_SYNC_PATTERN).toBe('17 3 * * 2');
  expect(SCHEDULE_TIMEZONE).toBe('Europe/Amsterdam');
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  expect(schedule.cron.options.protect).toBe(true);
  expect(schedule.cron.name).toBe('museum_sync');
});

it('runs on Tuesday at 03:17 Amsterdam time on both sides of a DST change', () => {
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  const cases: [from: string, expectedUtc: string][] = [
    // Winter time (UTC+1), then summer time (UTC+2): the clocks go forward on 2027-03-28.
    ['2027-03-20T12:00:00Z', '2027-03-23T02:17:00.000Z'],
    ['2027-03-29T12:00:00Z', '2027-03-30T01:17:00.000Z'],
    // And back on 2027-10-31.
    ['2027-10-25T12:00:00Z', '2027-10-26T01:17:00.000Z'],
    ['2027-11-01T12:00:00Z', '2027-11-02T02:17:00.000Z'],
  ];
  for (const [from, expectedUtc] of cases) {
    const next = schedule.cron.nextRun(new Date(from));
    expect(next?.toISOString()).toBe(expectedUtc);
    expect(amsterdam(next as Date)).toBe('Tue 03:17');
  }
});

it('runs once a week', () => {
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  const [a, b] = schedule.cron.nextRuns(2, new Date('2027-06-01T00:00:00Z'));
  expect((b as Date).getTime() - (a as Date).getTime()).toBe(7 * 24 * 3_600_000);
});
