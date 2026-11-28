import { afterEach, expect, it } from 'vitest';
import type { Db } from '../../src/db/kysely.ts';
import { silentLogger } from '../../src/lib/log.ts';
import {
  COMMONS_SYNC_PATTERN,
  MUSEUM_SYNC_PATTERN,
  PURGE_PATTERN,
  SCHEDULE_TIMEZONE,
  type Schedule,
  startSchedule,
  TILES_REFRESH_PATTERN,
} from '../../src/worker/schedule.ts';

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

it('runs the tiles refresh on the first Sunday of January, April, July and October at 02:23 Amsterdam time', () => {
  expect(TILES_REFRESH_PATTERN).toBe('23 2 * 1,4,7,10 0#1');
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  expect(schedule.tilesCron.name).toBe('tiles_refresh');
  expect(schedule.tilesCron.options.protect).toBe(true);
  const runs = schedule.tilesCron.nextRuns(6, new Date('2026-11-22T12:00:00Z'));
  expect(runs.map((d) => d.toISOString())).toEqual([
    '2027-01-03T01:23:00.000Z', // winter time, UTC+1
    '2027-04-04T00:23:00.000Z', // summer time since 2027-03-28, UTC+2
    '2027-07-04T00:23:00.000Z',
    '2027-10-03T00:23:00.000Z', // still summer time (the clocks go back on 2027-10-31)
    '2028-01-02T01:23:00.000Z',
    '2028-04-02T00:23:00.000Z',
  ]);
  for (const d of runs) expect(amsterdam(d)).toBe('Sun 02:23');
  // Always the first Sunday: never later than the 7th.
  expect(runs.every((d) => d.getUTCDate() <= 7)).toBe(true);
});

it('skips the months outside the four', () => {
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  expect(schedule.tilesCron.nextRun(new Date('2027-01-03T02:00:00Z'))?.toISOString()).toBe('2027-04-04T00:23:00.000Z');
});

it('runs once a week', () => {
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  const [a, b] = schedule.cron.nextRuns(2, new Date('2027-06-01T00:00:00Z'));
  expect((b as Date).getTime() - (a as Date).getTime()).toBe(7 * 24 * 3_600_000);
});

it('registers the 10-minute purge, protected against overlap', () => {
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  expect(PURGE_PATTERN).toBe('*/10 * * * *');
  expect(schedule.purgeCron.options.protect).toBe(true);
  expect(schedule.purgeCron.name).toBe('purge');
  const next = schedule.purgeCron.nextRun(new Date('2027-01-05T12:03:00Z'));
  expect(next?.toISOString()).toBe('2027-01-05T12:10:00.000Z');
});

it('registers the weekly Commons check on Thursday at 04:11 Amsterdam time', () => {
  schedule = startSchedule({ db: {} as Db, logger: silentLogger });
  expect(COMMONS_SYNC_PATTERN).toBe('11 4 * * 4');
  expect(schedule.commonsCron.name).toBe('commons_sync');
  expect(schedule.commonsCron.options.protect).toBe(true);
  const next = schedule.commonsCron.nextRun(new Date('2027-06-01T00:00:00Z')) as Date;
  expect(amsterdam(next)).toBe('Thu 04:11');
});
