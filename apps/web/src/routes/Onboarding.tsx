import { BULK_MAX, BulkResult, MuseumList, type MuseumListItem } from '@mjk/contracts';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { describeError, type Failure } from '../components/auth/errors.ts';
import { CheckField, FormError } from '../components/auth/fields.tsx';
import { PROVINCE_NAME } from '../components/museum/provinces.ts';
import { ImportFlow } from '../components/passport/ImportFlow.tsx';
import { LoadFailed, MemberPage } from '../components/passport/MemberPage.tsx';
import { getJson, sendJson } from '../lib/api.ts';
import { formatCount } from '../lib/format.ts';
import { museumName } from '../lib/names.ts';
import { Link } from '../lib/router.tsx';
import { type Locale, PROVINCE_SLUGS, pathOf, type Route } from '../lib/routes.ts';
import { m } from '../paraglide/messages.js';

// "Which museums have you already visited?" (P2c Q3; the `welcome` shell page): one list of the
// museums not yet in the passport, many ticks at once, one save. Ticks survive a new search or
// filter. No confirmation dialog, 44 px targets (the owner's phone check: 30 ticks in 2 minutes).

/** What `saveInBatches` did: the totals, how many ids were sent and accepted, and the first failure. */
export type BatchOutcome = { added: number; skipped: number; done: number; error: unknown };

/** Sends `ids` in batches of at most BULK_MAX, in order, stopping at the first failing batch. */
export async function saveInBatches(
  ids: readonly string[],
  send: (batch: string[]) => Promise<BulkResult>,
): Promise<BatchOutcome> {
  const out: BatchOutcome = { added: 0, skipped: 0, done: 0, error: null };
  for (let i = 0; i < ids.length; i += BULK_MAX) {
    const batch = ids.slice(i, i + BULK_MAX);
    try {
      const r = await send(batch);
      out.added += r.added;
      out.skipped += r.skipped;
      out.done += batch.length;
    } catch (error) {
      out.error = error;
      break;
    }
  }
  return out;
}

const PAGE = 50;

export function Onboarding({ route }: { route: Extract<Route, { page: 'shell' }> }) {
  return (
    <MemberPage route={route} title={m.welcome_h()}>
      <OnboardingBody locale={route.locale} />
    </MemberPage>
  );
}

function OnboardingBody({ locale }: { locale: Locale }) {
  const [draftQ, setDraftQ] = useState('');
  const [draftProvince, setDraftProvince] = useState('');
  const [applied, setApplied] = useState({ q: '', province: '' });
  const [round, setRound] = useState(0);
  const [items, setItems] = useState<MuseumListItem[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null);

  const load = useCallback(
    (cursor: string | null) => {
      const params = new URLSearchParams({ visited: 'no', sort: 'name', limit: String(PAGE) });
      if (applied.q !== '') params.set('q', applied.q);
      if (applied.province !== '') params.set('province', applied.province);
      if (cursor !== null) params.set('cursor', cursor);
      setFailed(false);
      setLoading(true);
      getJson(`/api/v1/me/museums?${params}`, MuseumList).then(
        (page) => {
          setItems((old) => (cursor === null ? page.items : [...(old ?? []), ...page.items]));
          setNext(page.next_cursor);
          setLoading(false);
        },
        () => {
          setFailed(true);
          setLoading(false);
        },
      );
    },
    [applied],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` re-fetches the first page after a save
  useEffect(() => load(null), [load, round]);

  const search = (event: FormEvent) => {
    event.preventDefault();
    setApplied({ q: draftQ.trim().slice(0, 100), province: draftProvince });
  };
  const toggle = (id: string, on: boolean) =>
    setSelected((old) => (on ? (old.includes(id) ? old : [...old, id]) : old.filter((x) => x !== id)));

  const save = async () => {
    setSaving(true);
    setFailure(null);
    setResult(null);
    const out = await saveInBatches(selected, (batch) =>
      sendJson('POST', '/api/v1/me/visits/bulk', { museum_ids: batch }, BulkResult),
    );
    // What was accepted leaves the selection; what was not sent stays ticked.
    const sent = new Set(selected.slice(0, out.done));
    setSelected((old) => old.filter((id) => !sent.has(id)));
    if (out.done > 0) setResult({ added: out.added, skipped: out.skipped });
    if (out.error !== null) setFailure(describeError(out.error, 'plain'));
    setSaving(false);
    setRound((n) => n + 1);
  };

  return (
    <>
      <p>{m.welcome_intro()}</p>
      <form method="post" className="filters" onSubmit={search}>
        <div className="field">
          <label htmlFor="ob-q">{m.field_q()}</label>
          <input
            id="ob-q"
            name="q"
            type="search"
            value={draftQ}
            maxLength={100}
            onChange={(e) => setDraftQ(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ob-province">{m.field_province()}</label>
          <select
            id="ob-province"
            name="province"
            value={draftProvince}
            onChange={(e) => setDraftProvince(e.target.value)}
          >
            <option value="">{m.option_all()}</option>
            {(Object.keys(PROVINCE_SLUGS) as (keyof typeof PROVINCE_SLUGS)[]).map((slug) => (
              <option key={slug} value={PROVINCE_SLUGS[slug]}>
                {PROVINCE_NAME[slug]()}
              </option>
            ))}
          </select>
        </div>
        <div className="cluster">
          <button type="submit" className="button">
            {m.action_filter()}
          </button>
        </div>
      </form>

      {items === undefined && !failed ? <p aria-live="polite">{m.loading()}</p> : null}
      {items?.length === 0 ? <p>{m.welcome_none()}</p> : null}
      {items === undefined ? null : (
        <ul className="plain-list">
          {items.map((museum) => (
            <li key={museum.id}>
              <CheckField
                name="museum"
                value={museum.id}
                checked={selected.includes(museum.id)}
                onChange={(e) => toggle(museum.id, e.target.checked)}
                label={
                  <span>
                    {museumName(museum, locale)}
                    {museum.place === null ? null : <span className="muted"> · {museum.place}</span>}
                  </span>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {failed ? <LoadFailed onRetry={() => load(items === undefined ? null : next)} /> : null}
      {next === null || failed ? null : (
        <button type="button" className="button button--quiet" disabled={loading} onClick={() => load(next)}>
          {m.passport_more()}
        </button>
      )}

      <div className="bulk-bar stack">
        <FormError failure={failure} />
        {result === null ? null : (
          <p role="status" className="notice">
            {m.welcome_saved({
              added: formatCount(result.added, locale),
              skipped: formatCount(result.skipped, locale),
            })}{' '}
            <Link href={pathOf({ page: 'shell', locale, app: 'passport' })}>{m.welcome_to_passport()}</Link>
          </p>
        )}
        <div className="cluster">
          <p role="status" className="bulk-bar__count">
            {m.welcome_selected({ n: formatCount(selected.length, locale) })}
          </p>
          <button type="button" className="button" disabled={saving || selected.length === 0} onClick={save}>
            {m.welcome_save()}
          </button>
        </div>
      </div>

      <ImportFlow locale={locale} />
    </>
  );
}
