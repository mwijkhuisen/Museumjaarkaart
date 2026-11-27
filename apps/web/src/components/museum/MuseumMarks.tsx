import { VISIT_NOTE_MAX, Visit, VisitCreate } from '@mjk/contracts';
import { type FormEvent, useState } from 'react';
import { ApiError, sendJson } from '../../lib/api.ts';
import { markVisited, setWishlisted, useMarks } from '../../lib/member.ts';
import { m } from '../../paraglide/messages.js';
import { describeError } from '../auth/errors.ts';
import { isClosed, offerReview, openReview, useReviewSignal } from '../reviews/signal.ts';
import { IconCheck } from '../ui/icons.tsx';

// A member's own marks on the public pages (A§15.1). The markup of a visitor and of a member is the
// same until the browser has the marks: the slot is empty on the server and in the first client
// render, and a fixed minimum height keeps the card from shifting when it fills.

export function MarkSlot({ museumId, name }: { museumId: string; name: string }) {
  const marks = useMarks();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const wanted = marks?.wishlist.has(museumId) === true;
  const toggle = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await setWishlisted(museumId, !wanted);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="marks-slot">
      {marks === undefined ? null : (
        <>
          {marks.visited.has(museumId) ? (
            <span className="badge badge--visited">
              <IconCheck /> {m.marks_visited()}
            </span>
          ) : null}
          <button
            type="button"
            className="button button--quiet"
            aria-pressed={wanted}
            aria-label={m.marks_wishlist_for({ name })}
            disabled={busy}
            onClick={() => void toggle()}
          >
            {wanted ? <IconCheck /> : null} {m.marks_wishlist()}
          </button>
          {failed ? (
            <span role="alert" className="form-error">
              {m.marks_failed()}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

const textOf = (error: unknown): string => {
  if (error instanceof ApiError && error.status === 409) return m.marks_visit_duplicate();
  if (error instanceof ApiError && error.status === 422) return m.marks_visit_future();
  return describeError(error, 'plain').text;
};

/** The member's own form, after hydration only: an empty fixed slot for a visitor (A§15.1). */
export function VisitForm({
  museumId,
  name,
  closedOn = null,
}: {
  museumId: string;
  name?: string;
  closedOn?: string | null;
}) {
  const marks = useMarks();
  const signal = useReviewSignal();
  const [logged, setLogged] = useState(false);
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  if (marks === undefined) return <div className="visit-slot" />;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = VisitCreate.safeParse({
      museum_id: museumId,
      visited_on: date === '' ? null : date,
      note: note.trim() === '' ? null : note.trim(),
    });
    if (!parsed.success) return setStatus({ ok: false, text: m.auth_err_bad_request() });
    setBusy(true);
    setStatus(null);
    try {
      const visit = await sendJson('POST', '/api/v1/me/visits', parsed.data, Visit);
      markVisited(museumId);
      offerReview(visit.id);
      setLogged(true);
      setDate('');
      setNote('');
      setStatus({ ok: true, text: m.marks_visit_saved() });
    } catch (error) {
      setLogged(false);
      setStatus({ ok: false, text: textOf(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="stack visit-slot" aria-labelledby="marks-visit-h">
      <h2 id="marks-visit-h">{m.marks_visit_h()}</h2>
      <form method="post" className="stack" onSubmit={(e) => void submit(e)} noValidate>
        <div className="field">
          <label htmlFor="visit-date">{m.marks_visit_date()}</label>
          <p id="visit-date-hint" className="field__hint">
            {m.marks_visit_date_hint()}
          </p>
          <input
            id="visit-date"
            type="date"
            value={date}
            max={new Date().toLocaleDateString('sv')}
            aria-describedby="visit-date-hint"
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="visit-note">{m.marks_visit_note()}</label>
          <textarea
            id="visit-note"
            rows={3}
            maxLength={VISIT_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {status === null ? null : status.ok ? (
          <p role="status" className="notice">
            {status.text}
          </p>
        ) : (
          <p role="alert" className="form-error">
            {status.text}
          </p>
        )}
        <button type="submit" className="button" disabled={busy}>
          {m.marks_visit_submit()}
        </button>
        {logged && name !== undefined && !signal.hasReview && !isClosed(closedOn) ? (
          <button type="button" className="button" onClick={openReview}>
            {m.review_mine_prompt({ name })}
          </button>
        ) : null}
      </form>
    </section>
  );
}
