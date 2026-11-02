// Runs a sync plan (diff.ts) inside one transaction as mjk_worker, and loads the
// state the plan starts from. Every value goes in as a bound parameter; jsonb
// values are serialised here, because pg would turn a JS array into a
// PostgreSQL array literal.

import { sql, type Transaction } from 'kysely';
import type { DB } from '../db/types.ts';
import type {
  MatchReason,
  MatchRuleState,
  MatchState,
  MuseumRef,
  MuseumState,
  PendingChange,
  Plan,
  SourceRowState,
  SyncState,
} from './diff.ts';
import type { ChangeField, Source } from './fields.ts';

type Tx = Transaction<DB>;

const json = (value: unknown) => (value === undefined || value === null ? null : JSON.stringify(value));
const CHUNK = 200;
const chunks = <T>(items: readonly T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

/** Everything plan() reads, in the transaction that will apply the plan. */
export async function loadState(tx: Tx): Promise<SyncState> {
  const [museums, aliases, sourceRows, pending, rejected, municipalities, provinces] = await Promise.all([
    tx
      .selectFrom('museum')
      .select([
        'id',
        'slug',
        'wikidata_qid',
        'rce_id',
        'name',
        'name_en',
        'description_nl',
        'description_en',
        'lat',
        'lon',
        'website',
        'street',
        'house_number',
        'postcode',
        'place',
        'municipality_code',
        'registered',
        'museumnl_url',
        'categories',
        'closed_on',
        'commons_file',
        'pinned_fields',
      ])
      .orderBy('id')
      .execute(),
    tx.selectFrom('museum_alias').select(['museum_id', 'alias']).orderBy('museum_id').orderBy('alias').execute(),
    tx
      .selectFrom('museum_source_row')
      .select([
        'source',
        'external_id',
        'hash',
        'matched_museum_id',
        'match_state',
        'match_rule',
        'match_reason',
        'candidate_ids',
        'gone_since_run_id',
      ])
      .orderBy('source')
      .orderBy('external_id')
      .execute(),
    tx
      .selectFrom('museum_change')
      .select(['id', 'museum_id', 'field', 'source', 'new'])
      .where('state', '=', 'pending')
      .where('origin', '=', 'sync')
      .orderBy('id')
      .execute(),
    tx
      .selectFrom('museum_change')
      .select(['id', 'museum_id', 'field', 'source', 'new'])
      .where('state', '=', 'rejected')
      .where('origin', '=', 'sync')
      .orderBy('id')
      .execute(),
    tx.selectFrom('municipality').select(['cbs_code', 'name', 'province_code']).execute(),
    tx.selectFrom('province').select('code').execute(),
  ]);
  type ChangeRow = { id: string; museum_id: string | null; field: string; source: string | null; new: unknown };
  const changes = (rows: readonly ChangeRow[]): PendingChange[] =>
    rows.flatMap((c) =>
      c.museum_id === null
        ? []
        : [
            {
              id: c.id,
              museum_id: c.museum_id,
              field: c.field as ChangeField,
              source: c.source as Source | null,
              new: c.new,
            },
          ],
    );
  const aliasesOf = new Map<string, string[]>();
  for (const a of aliases) aliasesOf.set(a.museum_id, [...(aliasesOf.get(a.museum_id) ?? []), a.alias]);
  return {
    museums: museums.map(
      (m): MuseumState => ({ ...m, aliases: aliasesOf.get(m.id) ?? [], pinned_fields: m.pinned_fields }),
    ),
    sourceRows: sourceRows.map(
      (r): SourceRowState => ({
        source: r.source as Source,
        external_id: r.external_id,
        hash: r.hash,
        matched_museum_id: r.matched_museum_id,
        match_state: r.match_state as MatchState,
        match_rule: r.match_rule as MatchRuleState | null,
        match_reason: r.match_reason as MatchReason | null,
        candidate_ids: r.candidate_ids,
        gone: r.gone_since_run_id !== null,
      }),
    ),
    pending: changes(pending),
    rejected: changes(rejected),
    municipalities,
    provinces: provinces.map((p) => p.code),
  };
}

/** Executes a plan. The caller owns the transaction and the run row (`runId`). */
export async function applyPlan(tx: Tx, plan: Plan, runId: string): Promise<void> {
  for (const part of chunks(plan.municipalities)) {
    await tx
      .insertInto('municipality')
      .values(part)
      .onConflict((oc) =>
        oc.column('cbs_code').doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          province_code: eb.ref('excluded.province_code'),
        })),
      )
      .execute();
  }

  // New museums (the seed): their ids come back by QID, the key of a seed museum.
  const idOfKey = new Map<string, string>();
  for (const part of chunks(plan.create)) {
    const rows = await tx
      .insertInto('museum')
      .values(part.map((c) => ({ slug: c.slug, ...c.fields })))
      .returning(['id', 'wikidata_qid'])
      .execute();
    for (const r of rows) if (r.wikidata_qid !== null) idOfKey.set(r.wikidata_qid, r.id);
  }
  const idOf = (ref: MuseumRef): string => {
    if ('id' in ref) return ref.id;
    const id = idOfKey.get(ref.key);
    if (id === undefined) throw new Error('applyPlan: a reference to a museum the plan did not create');
    return id;
  };

  const aliases = [
    ...plan.create.flatMap((c) => c.aliases.map((alias) => ({ museum: { key: c.key } as MuseumRef, alias }))),
    ...plan.aliases,
  ];
  for (const part of chunks(aliases)) {
    await tx
      .insertInto('museum_alias')
      .values(part.map((a) => ({ museum_id: idOf(a.museum), alias: a.alias, source: 'wikidata' })))
      .onConflict((oc) => oc.columns(['museum_id', 'alias']).doNothing())
      .execute();
  }

  for (const u of plan.update) await tx.updateTable('museum').set(u.set).where('id', '=', u.museumId).execute();

  for (const part of chunks(plan.supersede)) {
    await tx
      .updateTable('museum_change')
      .set({ state: 'superseded', decided_at: sql<Date>`now()` })
      .where('id', 'in', part)
      .where('state', '=', 'pending')
      .execute();
  }

  for (const part of chunks(plan.sourceRows)) {
    await tx
      .insertInto('museum_source_row')
      .values(
        part.map((r) => ({
          source: r.source,
          external_id: r.external_id,
          payload: json(r.payload) as string,
          hash: r.hash,
          run_id: runId,
          fetched_at: sql<Date>`now()`,
          matched_museum_id: r.museum === null ? null : idOf(r.museum),
          match_state: r.match_state,
          match_rule: r.match_rule,
          match_reason: r.match_reason,
          candidate_ids: r.candidates.map(idOf),
          gone_since_run_id: null,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['source', 'external_id']).doUpdateSet((eb) => ({
          payload: eb.ref('excluded.payload'),
          hash: eb.ref('excluded.hash'),
          run_id: eb.ref('excluded.run_id'),
          fetched_at: eb.ref('excluded.fetched_at'),
          matched_museum_id: eb.ref('excluded.matched_museum_id'),
          match_state: eb.ref('excluded.match_state'),
          match_rule: eb.ref('excluded.match_rule'),
          match_reason: eb.ref('excluded.match_reason'),
          candidate_ids: eb.ref('excluded.candidate_ids'),
          gone_since_run_id: null,
        })),
      )
      .execute();
  }

  for (const g of plan.gone) {
    await tx
      .updateTable('museum_source_row')
      .set({ gone_since_run_id: runId })
      .where('source', '=', g.source)
      .where('external_id', '=', g.external_id)
      .execute();
  }

  for (const part of chunks(plan.changes)) {
    await tx
      .insertInto('museum_change')
      .values(
        part.map((c) => ({
          museum_id: c.museumId,
          field: c.field,
          old: json(c.old),
          new: json(c.new),
          source: c.source,
          external_id: c.external_id,
          run_id: runId,
          state: c.state,
          decided_at: c.state === 'applied' ? sql<Date>`now()` : null,
        })),
      )
      .execute();
  }
}
