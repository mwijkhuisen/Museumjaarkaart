import {
  type MemberMuseum,
  MemberMuseum as MemberMuseumSchema,
  VISIT_NOTE_MAX,
  type Visit,
  VisitList,
  VisitPatch,
} from '@mjk/contracts';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { ApiError, getJson, sendJson } from '../../lib/api.ts';
import { formatDate } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { fieldsOf, useAction } from '../auth/errors.ts';
import { Field, FormError } from '../auth/fields.tsx';
import { describeReviewError } from '../reviews/errors.ts';
import { LoadFailed } from './MemberPage.tsx';
import { MuseumRef } from './Savings.tsx';

// The visit log (A§10): newest first, 20 a page, edit the date and the note in place, delete. The
// member's own museum may be hidden later (`slug: null`): it is named without a link. A change tells
// the page (`onChanged`) so progress and € saved are fetched again.

const PAGE = 20;

export function VisitLog({ locale, onChanged }: { locale: Locale; onChanged: () => void }) {
  const [items, setItems] = useState<Visit[] | undefined>(undefined);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback((cursor: string | null) => {
    setFailed(false);
    setBusy(true);
    const query = `limit=${PAGE}${cursor === null ? '' : `&cursor=${cursor}`}`;
    getJson(`/api/v1/me/visits?${query}`, VisitList).then(
      (page) => {
        setItems((old) => (cursor === null ? page.items : [...(old ?? []), ...page.items]));
        setNext(page.next);
        setBusy(false);
      },
      () => {
        setFailed(true);
        setBusy(false);
      },
    );
  }, []);
  useEffect(() => load(null), [load]);

  return (
    <section className="stack" aria-labelledby="passport-visits">
      <h2 id="passport-visits">{m.passport_h_visits()}</h2>
      {items === undefined && !failed ? <p aria-live="polite">{m.loading()}</p> : null}
      {items?.length === 0 ? <p>{m.passport_visits_none()}</p> : null}
      {items === undefined ? null : (
        <ul className="plain-list stack">
          {items.map((visit) => (
            <VisitRow
              key={visit.id}
              visit={visit}
              locale={locale}
              onSaved={(v) => {
                setItems((old) => old?.map((x) => (x.id === v.id ? v : x)));
                onChanged();
              }}
              onDeleted={() => {
                setItems((old) => old?.filter((x) => x.id !== visit.id));
                onChanged();
              }}
            />
          ))}
        </ul>
      )}
      {failed ? <LoadFailed onRetry={() => load(items === undefined ? null : next)} /> : null}
      {next === null || failed ? null : (
        <button type="button" className="button button--quiet" disabled={busy} onClick={() => load(next)}>
          {m.passport_more()}
        </button>
      )}
    </section>
  );
}

function VisitRow({
  visit,
  locale,
  onSaved,
  onDeleted,
}: {
  visit: Visit;
  locale: Locale;
  onSaved: (visit: Visit) => void;
  onDeleted: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [date, setDate] = useState(visit.visited_on ?? '');
  const [note, setNote] = useState(visit.note ?? '');
  const noteId = useId();
  const { busy, failure, setFailure, run } = useAction('plain');

  useEffect(() => {
    if (!editing) return;
    setDate(visit.visited_on ?? '');
    setNote(visit.note ?? '');
  }, [editing, visit.visited_on, visit.note]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const parsed = VisitPatch.safeParse({
      visited_on: date === '' ? null : date,
      note: note.trim() === '' ? null : note,
    });
    if (!parsed.success) {
      setFailure({ text: m.auth_err_bad_request(), fields: fieldsOf(parsed.error) });
      return;
    }
    void run(async () => {
      await sendJson('PATCH', `/api/v1/me/visits/${visit.id}`, parsed.data);
      onSaved({ ...visit, visited_on: parsed.data.visited_on ?? null, note: parsed.data.note ?? null });
      setEditing(false);
    });
  };
  // A visit that a review cites answers 409 (A§11): the member picks another visit for the review or deletes it.
  const [cited, setCited] = useState<MemberMuseum | null>(null);
  const remove = () =>
    void run(async () => {
      try {
        await sendJson('DELETE', `/api/v1/me/visits/${visit.id}`);
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 409 && visit.museum.slug !== null)) throw error;
        const mine = await getJson(`/api/v1/me/museums/${visit.museum.slug}`, MemberMuseumSchema);
        if (mine.review === null) throw error;
        setCited(mine);
        return;
      }
      onDeleted();
    });

  return (
    <li className="card stack">
      <h3>
        <MuseumRef museum={visit.museum} locale={locale} />
      </h3>
      {editing ? (
        <form method="post" className="stack" onSubmit={save} noValidate>
          <Field
            label={m.passport_visit_date()}
            error={failure?.fields.visited_on}
            name="visited_on"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <div className="field">
            <label htmlFor={noteId}>{m.passport_visit_note()}</label>
            <textarea
              id={noteId}
              name="note"
              rows={3}
              maxLength={VISIT_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <FormError failure={failure} />
          <div className="cluster">
            <button type="submit" className="button" disabled={busy}>
              {m.action_save()}
            </button>
            <button type="button" className="button button--quiet" disabled={busy} onClick={() => setEditing(false)}>
              {m.action_cancel()}
            </button>
          </div>
        </form>
      ) : (
        <>
          <p>{visit.visited_on === null ? m.passport_date_unknown() : formatDate(visit.visited_on, locale)}</p>
          {visit.note === null ? null : <p className="note">{visit.note}</p>}
          <FormError failure={failure} />
          {cited?.review ? (
            <CitedVisit
              visit={visit}
              mine={cited}
              review={cited.review}
              locale={locale}
              onCancel={() => setCited(null)}
              onDone={onDeleted}
            />
          ) : null}
          <div className="cluster">
            <button type="button" className="button button--quiet" onClick={() => setEditing(true)}>
              {m.passport_edit()}
            </button>
            {asking ? (
              <>
                <button type="button" className="button" disabled={busy} onClick={remove}>
                  {m.passport_delete_sure()}
                </button>
                <button type="button" className="button button--quiet" onClick={() => setAsking(false)}>
                  {m.action_cancel()}
                </button>
              </>
            ) : (
              <button type="button" className="button button--quiet" onClick={() => setAsking(true)}>
                {m.passport_delete()}
              </button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

/** The two ways out of a 409: the review cites another visit of this museum, or the review goes first. */
function CitedVisit({
  visit,
  mine,
  review,
  locale,
  onCancel,
  onDone,
}: {
  visit: Visit;
  mine: MemberMuseum;
  review: NonNullable<MemberMuseum['review']>;
  locale: Locale;
  onCancel: () => void;
  onDone: () => void;
}) {
  const others = mine.visits.filter((v) => v.id !== visit.id);
  const [other, setOther] = useState(others[0]?.id ?? '');
  const selectId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async (steps: () => Promise<void>, ctx: 'edit' | 'delete') => {
    setBusy(true);
    setError(null);
    try {
      await steps();
      await sendJson('DELETE', `/api/v1/me/visits/${visit.id}`);
      onDone();
    } catch (e) {
      setError(describeReviewError(e, ctx).text);
      setBusy(false);
    }
  };
  return (
    <fieldset className="stack notice">
      <legend>{m.review_cited_h()}</legend>
      <p>{m.review_cited_intro()}</p>
      {others.length === 0 ? null : (
        <div className="field">
          <label htmlFor={selectId}>{m.review_cited_other()}</label>
          <select id={selectId} value={other} onChange={(e) => setOther(e.target.value)}>
            {others.map((v) => (
              <option key={v.id} value={v.id}>
                {v.visited_on === null ? m.passport_date_unknown() : formatDate(v.visited_on, locale)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() =>
              void go(() => sendJson('PATCH', `/api/v1/reviews/${review.id}`, { visit_id: other }), 'edit')
            }
          >
            {m.review_cited_move()}
          </button>
        </div>
      )}
      <div className="cluster">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => void go(() => sendJson('DELETE', `/api/v1/reviews/${review.id}`), 'delete')}
        >
          {m.review_cited_delete()}
        </button>
        <button type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>
          {m.action_cancel()}
        </button>
      </div>
      {error === null ? null : (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
