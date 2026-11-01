import { Kysely, PostgresDialect } from 'kysely';
import type pg from 'pg';
import type { DB } from './types.ts';

export type Db = Kysely<DB>;

/** A Kysely instance over a pool from createPool(); destroying it ends the pool. */
export const createDb = (pool: pg.Pool): Db => new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
