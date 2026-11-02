import { sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { parseDate } from '../admin/dates.ts';
import type { Db } from '../db/kysely.ts';
import type { DB } from '../db/types.ts';
import { AdminError, EXIT_DATA, EXIT_NOT_FOUND, EXIT_USAGE, findMuseum } from './curation.ts';
import { fieldsFromSources } from './diff.ts';
import { CATEGORIES, CBS_CODE, CHANGE_FIELDS, LIMITS, NL_BOX, POSTCODE, QID, SOURCES, type Source } from './fields.ts';
import { museumnlUrl } from './museumnl.ts';
import { uniqueSlug } from './slug.ts';
import type { RceRow, WikidataRow } from './sources/types.ts';

// The owner's two queues (plan §2.4, §2.6): which museum a source row is (`match …`), and field news
// about a museum we hold (`change …`). Each call is one transaction as `mjk_api`; every museum write
// leaves a `museum_change` (origin 'admin', state 'applied'). Results are data; cli.ts prints them.

type Trx = Transaction<DB>;

export const MATCH_REASONS = ['no_candidate', 'ambiguous', 'qid_conflict', 'qid_link', 'duplicate'] as const;
export type QueueReason = (typeof MATCH_REASONS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RCE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

const fail = (exit: number, code: string): never => {
  throw new AdminError(exit, code);
};

/** The database's integrity errors, mapped to fixed codes. Anything else is rethrown. */
function mapDbError(err: unknown): never {
  const code = (err as { code?: unknown }).code;
  if (code === '23514' || code === '23503') throw new AdminError(EXIT_DATA, 'check_failed');
  if (code === '23505') throw new AdminError(EXIT_DATA, 'already_taken');
  throw err;
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    return mapDbError(err);
  }
}

// jsonb values go in as JSON text (as apply.ts does): pg would turn a JS array into an array literal.
const json = (v: unknown): string | null => (v === undefined || v === null ? null : JSON.stringify(v));

async function record(
  trx: Trx,
  c: { museumId: string; field: string; old: unknown; new: unknown; source?: Source; externalId?: string },
): Promise<void> {
  await trx
    .insertInto('museum_change')
    .values({
      museum_id: c.museumId,
      field: c.field,
      old: json(c.old),
      new: json(c.new),
      origin: 'admin',
      state: 'applied',
      source: c.source ?? null,
      external_id: c.externalId ?? null,
      decided_at: sql<Date>`now()`,
    })
    .execute();
}

// --- the match queue -----------------------------------------------------------------------------

export type SourceRef = { source: Source; externalId: string };

/** `wikidata:Q123` or `rce:<id>`, or undefined. */
export function parseSourceRef(text: string): SourceRef | undefined {
  const i = text.indexOf(':');
  const source = text.slice(0, i);
  const externalId = text.slice(i + 1);
  if (source === 'wikidata' && QID.test(externalId)) return { source, externalId };
  if (source === 'rce' && RCE_ID.test(externalId)) return { source, externalId };
  return undefined;
}

export type QueuedRow = {
  source: string;
  externalId: string;
  reason: string | null;
  name: string;
  postcode: string;
  place: string;
  candidates: string[];
};

export async function listMatchQueue(db: Db, filter: { source?: string; reason?: string }): Promise<QueuedRow[]> {
  if (filter.source !== undefined && !(SOURCES as readonly string[]).includes(filter.source))
    fail(EXIT_USAGE, 'bad_source');
  if (filter.reason !== undefined && !(MATCH_REASONS as readonly string[]).includes(filter.reason)) {
    fail(EXIT_USAGE, 'bad_reason');
  }
  return db.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom('museum_source_row')
      .select([
        'source',
        'external_id',
        'match_reason',
        'candidate_ids',
        sql<string>`coalesce(payload->>'name', '')`.as('name'),
        sql<string>`coalesce(payload->>'postcode', '')`.as('postcode'),
        sql<string>`coalesce(payload->>'place', '')`.as('place'),
      ])
      .where('match_state', 'in', ['new', 'ambiguous'])
      .where('gone_since_run_id', 'is', null);
    if (filter.source !== undefined) q = q.where('source', '=', filter.source);
    if (filter.reason !== undefined) q = q.where('match_reason', '=', filter.reason);
    const rows = await q.orderBy('source').orderBy('external_id').execute();
    const ids = [...new Set(rows.flatMap((r) => r.candidate_ids))];
    const slugs = new Map<string, string>();
    if (ids.length > 0) {
      for (const m of await trx.selectFrom('museum').select(['id', 'slug']).where('id', 'in', ids).execute()) {
        slugs.set(m.id, m.slug);
      }
    }
    return rows.map((r) => ({
      source: r.source,
      externalId: r.external_id,
      reason: r.match_reason,
      name: r.name,
      postcode: r.postcode,
      place: r.place,
      candidates: r.candidate_ids.map((id) => slugs.get(id) ?? '?'),
    }));
  });
}

// The payload came from our own parser but is stored data: it is checked again before it becomes a museum.
const text = (max: number) => z.string().min(1).max(max);
const opt = <T extends z.ZodType>(s: T) => z.union([z.null(), s]);
const lat = z.number().min(NL_BOX.latMin).max(NL_BOX.latMax);
const lon = z.number().min(NL_BOX.lonMin).max(NL_BOX.lonMax);
const pointOk = (r: { lat: number | null; lon: number | null }) => (r.lat === null) === (r.lon === null);

const wikidataPayload = z
  .strictObject({
    qid: z.string().regex(QID),
    name: text(LIMITS.label),
    nameEn: opt(text(LIMITS.label)),
    descriptionNl: opt(text(LIMITS.description)),
    descriptionEn: opt(text(LIMITS.description)),
    aliases: z.array(text(LIMITS.alias)).max(100),
    lat: opt(lat),
    lon: opt(lon),
    website: opt(
      z
        .string()
        .regex(/^https:\/\/\S+$/)
        .max(LIMITS.url),
    ),
    street: opt(text(LIMITS.street)),
    houseNumber: opt(text(LIMITS.houseNumber)),
    postcode: opt(z.string().regex(POSTCODE)),
    place: opt(text(LIMITS.place)),
    municipalityCode: opt(z.string().regex(CBS_CODE)),
    municipalityName: opt(text(LIMITS.municipalityName)),
    provinceCode: opt(z.string()),
    registered: z.boolean(),
    museumnlUrl: opt(z.string().refine((v) => museumnlUrl(v) !== undefined)),
    commonsFile: opt(text(LIMITS.commonsFile)),
    classes: z.array(z.string().regex(QID)),
    dissolvedOn: opt(z.string().refine((v) => parseDate(v) !== undefined)),
  })
  .refine(pointOk);

const rcePayload = z
  .strictObject({
    rceId: z.string().regex(RCE_ID),
    name: text(LIMITS.label),
    street: opt(text(LIMITS.street)),
    houseNumber: opt(text(LIMITS.houseNumber)),
    postcode: opt(z.string().regex(POSTCODE)),
    place: opt(text(LIMITS.place)),
    municipalityName: opt(text(LIMITS.municipalityName)),
    lat: opt(lat),
    lon: opt(lon),
  })
  .refine(pointOk);

export type ResolveAction =
  | { kind: 'museum'; museum: string; replaceQid: boolean }
  | { kind: 'new' }
  | { kind: 'ignore' };

export type ResolveResult = { slug: string | null; outcome: 'linked' | 'created' | 'ignored' };

export function resolveMatch(db: Db, ref: SourceRef, action: ResolveAction): Promise<ResolveResult> {
  return guarded(() =>
    db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('museum_source_row')
        .select(['payload', 'match_state', 'gone_since_run_id'])
        .where('source', '=', ref.source)
        .where('external_id', '=', ref.externalId)
        .forUpdate()
        .executeTakeFirst();
      if (row === undefined) return fail(EXIT_NOT_FOUND, 'row_not_found');
      if ((row.match_state !== 'new' && row.match_state !== 'ambiguous') || row.gone_since_run_id !== null) {
        return fail(EXIT_DATA, 'not_queued');
      }
      const link = (museumId: string) =>
        trx
          .updateTable('museum_source_row')
          .set({
            match_state: 'matched',
            match_rule: 'admin',
            matched_museum_id: museumId,
            candidate_ids: [],
            match_reason: null,
          })
          .where('source', '=', ref.source)
          .where('external_id', '=', ref.externalId)
          .execute();

      if (action.kind === 'ignore') {
        // The reason stays: the sync keeps an ignored row as it is, and the owner can still see why.
        await trx
          .updateTable('museum_source_row')
          .set({ match_state: 'ignored' })
          .where('source', '=', ref.source)
          .where('external_id', '=', ref.externalId)
          .execute();
        return { slug: null, outcome: 'ignored' };
      }

      if (action.kind === 'museum') {
        const m = await findMuseum(trx, action.museum);
        const keys = await trx.selectFrom('museum').select('rce_id').where('id', '=', m.id).executeTakeFirstOrThrow();
        if (ref.source === 'wikidata') {
          if (m.wikidata_qid !== ref.externalId) {
            if (m.wikidata_qid !== null && !action.replaceQid) return fail(EXIT_DATA, 'qid_conflict');
            await trx.updateTable('museum').set({ wikidata_qid: ref.externalId }).where('id', '=', m.id).execute();
            await record(trx, {
              museumId: m.id,
              field: 'qid_link',
              old: m.wikidata_qid,
              new: ref.externalId,
              source: 'wikidata',
              externalId: ref.externalId,
            });
          }
        } else if (keys.rce_id !== ref.externalId) {
          if (keys.rce_id !== null) return fail(EXIT_DATA, 'rce_conflict');
          await trx.updateTable('museum').set({ rce_id: ref.externalId }).where('id', '=', m.id).execute();
          await record(trx, {
            museumId: m.id,
            field: 'rce_id',
            old: null,
            new: ref.externalId,
            source: 'rce',
            externalId: ref.externalId,
          });
        }
        await link(m.id);
        return { slug: m.slug, outcome: 'linked' };
      }

      // --new
      const known = new Set((await trx.selectFrom('municipality').select('cbs_code').execute()).map((r) => r.cbs_code));
      const knownMunicipality = (code: string | null) => (code !== null && known.has(code) ? code : null);
      let fields: ReturnType<typeof fieldsFromSources>;
      let aliases: string[] = [];
      if (ref.source === 'wikidata') {
        const parsed = wikidataPayload.safeParse(row.payload);
        if (!parsed.success || parsed.data.qid !== ref.externalId) return fail(EXIT_DATA, 'bad_payload');
        const w = parsed.data as WikidataRow;
        fields = fieldsFromSources(w, undefined, knownMunicipality);
        aliases = [...new Set(w.aliases)].filter((a) => a !== w.name);
      } else {
        const parsed = rcePayload.safeParse(row.payload);
        if (!parsed.success || parsed.data.rceId !== ref.externalId) return fail(EXIT_DATA, 'bad_payload');
        fields = fieldsFromSources(undefined, parsed.data as RceRow, knownMunicipality);
      }
      // A new museum never takes a current slug or an old one (an old slug answers 301 for good).
      const taken = new Set([
        ...(await trx.selectFrom('museum').select('slug').execute()).map((r) => r.slug),
        ...(await trx.selectFrom('museum_slug_redirect').select('old_slug').execute()).map((r) => r.old_slug),
      ]);
      const slug = uniqueSlug(fields.name, fields.place, taken);
      const created = await trx
        .insertInto('museum')
        .values({ slug, ...fields })
        .returning('id')
        .executeTakeFirstOrThrow();
      if (aliases.length > 0) {
        await trx
          .insertInto('museum_alias')
          .values(aliases.map((alias) => ({ museum_id: created.id, alias, source: 'wikidata' })))
          .execute();
      }
      await link(created.id);
      await record(trx, {
        museumId: created.id,
        field: 'new_museum',
        old: null,
        new: { source: ref.source, external_id: ref.externalId },
        source: ref.source,
        externalId: ref.externalId,
      });
      return { slug, outcome: 'created' };
    }),
  );
}

// --- the change queue ----------------------------------------------------------------------------

export type PendingRow = { id: string; slug: string; field: string; old: unknown; new: unknown };

export async function listChanges(db: Db, filter: { field?: string; museum?: string }): Promise<PendingRow[]> {
  if (filter.field !== undefined && !(CHANGE_FIELDS as readonly string[]).includes(filter.field)) {
    fail(EXIT_USAGE, 'bad_field');
  }
  return db.transaction().execute(async (trx) => {
    let q = trx
      .selectFrom('museum_change as c')
      .innerJoin('museum as m', 'm.id', 'c.museum_id')
      .select(['c.id', 'm.slug', 'c.field', 'c.old', 'c.new'])
      .where('c.state', '=', 'pending');
    if (filter.field !== undefined) q = q.where('c.field', '=', filter.field);
    if (filter.museum !== undefined) q = q.where('c.museum_id', '=', (await findMuseum(trx, filter.museum)).id);
    return (await q.orderBy('c.id').execute()).map((r) => ({ ...r, old: r.old, new: r.new }));
  });
}

const date = z.string().refine((v) => parseDate(v) !== undefined);
/** The value a column accepts, per field. `coordinates` and `presence` are handled apart. */
const COLUMN_VALUE: Record<string, z.ZodType> = {
  rce_id: opt(z.string().regex(RCE_ID)),
  name: text(LIMITS.label),
  name_en: opt(text(LIMITS.label)),
  description_nl: opt(text(LIMITS.description)),
  description_en: opt(text(LIMITS.description)),
  website: opt(
    z
      .string()
      .regex(/^https:\/\/\S+$/)
      .max(LIMITS.url),
  ),
  street: opt(text(LIMITS.street)),
  house_number: opt(text(LIMITS.houseNumber)),
  postcode: opt(z.string().regex(POSTCODE)),
  place: opt(text(LIMITS.place)),
  municipality_code: opt(z.string().regex(CBS_CODE)),
  registered: z.boolean(),
  museumnl_url: opt(z.string().refine((v) => museumnlUrl(v) !== undefined)),
  categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length),
  closed_on: opt(date),
  commons_file: opt(text(LIMITS.commonsFile)),
};
const coordinates = opt(z.strictObject({ lat, lon }));

export type PresenceChoice = { keep?: boolean; hide?: boolean; close?: string };
export type ApplyResult = { slug: string; field: string; outcome: 'applied' | 'rejected' };

async function pendingChange(trx: Trx, id: string) {
  if (!UUID.test(id)) return fail(EXIT_NOT_FOUND, 'change_not_found');
  const c = await trx
    .selectFrom('museum_change')
    .select(['id', 'museum_id', 'field', 'new', 'state'])
    .where('id', '=', id)
    .forUpdate()
    .executeTakeFirst();
  if (c === undefined || c.museum_id === null) return fail(EXIT_NOT_FOUND, 'change_not_found');
  if (c.state !== 'pending') return fail(EXIT_DATA, 'not_pending');
  const m = await trx
    .selectFrom('museum')
    .selectAll()
    .where('id', '=', c.museum_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  return { id: c.id, field: c.field, value: c.new, museum: m };
}

const decide = (trx: Trx, id: string, state: 'applied' | 'rejected') =>
  trx.updateTable('museum_change').set({ state, decided_at: sql<Date>`now()` }).where('id', '=', id).execute();

export function applyChange(db: Db, id: string, choice: PresenceChoice): Promise<ApplyResult> {
  if (choice.close !== undefined && parseDate(choice.close) === undefined) fail(EXIT_USAGE, 'bad_date');
  return guarded(() =>
    db.transaction().execute(async (trx) => {
      const c = await pendingChange(trx, id);
      const m = c.museum;
      const chosen = [choice.keep, choice.hide, choice.close].filter((x) => x !== undefined).length;
      if (c.field === 'presence') {
        if (chosen !== 1) return fail(EXIT_USAGE, 'presence_needs_choice');
        if (choice.keep === true) {
          await decide(trx, c.id, 'rejected');
          return { slug: m.slug, field: c.field, outcome: 'rejected' };
        }
        if (choice.hide === true) {
          await trx.updateTable('museum').set({ hidden: true }).where('id', '=', m.id).execute();
          if (!m.hidden) await record(trx, { museumId: m.id, field: 'hidden', old: m.hidden, new: true });
        } else {
          const closedOn = choice.close as string;
          await trx.updateTable('museum').set({ closed_on: closedOn }).where('id', '=', m.id).execute();
          await record(trx, { museumId: m.id, field: 'closed_on', old: m.closed_on, new: closedOn });
        }
        await decide(trx, c.id, 'applied');
        return { slug: m.slug, field: c.field, outcome: 'applied' };
      }
      if (chosen > 0) return fail(EXIT_USAGE, 'choice_only_for_presence');

      if (c.field === 'coordinates') {
        const parsed = coordinates.safeParse(c.value);
        if (!parsed.success) return fail(EXIT_DATA, 'bad_value');
        const next = parsed.data;
        await trx
          .updateTable('museum')
          .set({ lat: next?.lat ?? null, lon: next?.lon ?? null })
          .where('id', '=', m.id)
          .execute();
      } else {
        const schema = Object.hasOwn(COLUMN_VALUE, c.field) ? COLUMN_VALUE[c.field] : undefined;
        if (schema === undefined) return fail(EXIT_DATA, 'unsupported_field');
        const parsed = schema.safeParse(c.value);
        if (!parsed.success) return fail(EXIT_DATA, 'bad_value');
        await trx
          .updateTable('museum')
          .set({ [c.field]: parsed.data } as never)
          .where('id', '=', m.id)
          .execute();
      }
      await decide(trx, c.id, 'applied');
      return { slug: m.slug, field: c.field, outcome: 'applied' };
    }),
  );
}

export function rejectChange(db: Db, id: string): Promise<ApplyResult> {
  return db.transaction().execute(async (trx) => {
    const c = await pendingChange(trx, id);
    await decide(trx, c.id, 'rejected');
    return { slug: c.museum.slug, field: c.field, outcome: 'rejected' };
  });
}
