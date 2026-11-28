import {
  ASPECTS,
  type Aspect,
  type MemberMuseum,
  MemberMuseum as MemberMuseumSchema,
  type MuseumDetail,
} from '@mjk/contracts';
import { useCallback, useEffect, useState } from 'react';
import { getJson, sendJson } from '../../lib/api.ts';
import { formatDate } from '../../lib/format.ts';
import { useMarks } from '../../lib/member.ts';
import { museumName } from '../../lib/names.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { OwnPhotoView, photoAlt } from '../photos/Picture.tsx';
import { ReviewForm } from './ReviewForm.tsx';
import { isClosed, resetSignal, setHasReview, useReviewSignal } from './signal.ts';

// The member's own review of this museum on its page (P3a): "Beoordeel <museum>" or their review with edit and
// delete, read from GET /me/museums/:slug once the marks say a member is signed in. Empty on the server and in the
// first client render, like MarkSlot (A§15.1). A closed museum is read-only: no create, no edit; delete stays.

const ASPECT_LABEL: Record<Aspect, () => string> = {
  collection: () => m.review_form_aspect_collection(),
  presentation: () => m.review_form_aspect_presentation(),
  kid_friendly: () => m.review_form_aspect_kid_friendly(),
  accessibility: () => m.review_form_aspect_accessibility(),
  facilities: () => m.review_form_aspect_facilities(),
  value_for_money: () => m.review_form_aspect_value_for_money(),
};

export function MyReviewSlot({ museum, locale }: { museum: MuseumDetail; locale: Locale }) {
  const marks = useMarks();
  const signal = useReviewSignal();
  const [mine, setMine] = useState<MemberMuseum | undefined>(undefined);
  const [mode, setMode] = useState<'view' | 'create' | 'edit'>('view');
  const [failed, setFailed] = useState(false);
  const signedIn = marks !== undefined;
  const closed = isClosed(museum.closed_on);

  const load = useCallback(() => {
    getJson(`/api/v1/me/museums/${museum.slug}`, MemberMuseumSchema).then(
      (data) => {
        setMine(data);
        setHasReview(data.review !== null);
      },
      () => setFailed(true),
    );
  }, [museum.slug]);
  // A new visit (signal.visitId) is fetched again so the picker lists it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: visitId is the trigger
  useEffect(() => {
    if (signedIn) load();
  }, [signedIn, load, signal.visitId]);
  useEffect(() => () => resetSignal(), []);
  // The prompt in VisitForm asks for the form.
  useEffect(() => {
    if (signal.open > 0 && !closed) setMode('create');
  }, [signal.open, closed]);

  if (!signedIn) return null;
  const name = museumName(museum, locale);
  if (failed) return <p className="form-error">{m.review_mine_failed()}</p>;
  if (mine === undefined) return null;
  const { review, visits } = mine;
  const done = () => {
    setMode('view');
    load();
  };

  return (
    <section className="stack my-review" aria-labelledby="my-review-h">
      <h2 id="my-review-h">{m.review_mine_h()}</h2>
      {mode !== 'view' && signal.visitId !== null && !visits.some((v) => v.id === signal.visitId) ? (
        <p aria-live="polite">{m.loading()}</p> // the fetch that lists the just-logged visit is still on its way
      ) : mode !== 'view' ? (
        <ReviewForm
          museum={museum}
          locale={locale}
          visits={visits}
          review={mode === 'edit' ? (review ?? undefined) : undefined}
          visitId={signal.visitId ?? undefined}
          onSaved={done}
          onDeleted={done}
          onCancel={() => setMode('view')}
        />
      ) : review !== null ? (
        <div className="card stack">
          <p>
            <strong>{m.review_form_stars({ n: String(review.rating) })}</strong>
            {review.visited_on === null
              ? null
              : ` · ${m.review_mine_visited_on({ date: formatDate(review.visited_on, locale) })}`}
            {review.edited_at === null ? null : ` · ${m.review_mine_edited()}`}
          </p>
          <ul className="plain-list">
            {ASPECTS.map((a) =>
              review[a] === null ? null : (
                <li key={a}>
                  {ASPECT_LABEL[a]()}: {m.review_form_stars({ n: String(review[a]) })}
                </li>
              ),
            )}
          </ul>
          {review.body === null ? null : (
            <p className="review-body" dir="auto">
              {review.body}
            </p>
          )}
          {review.photos.length === 0 ? null : (
            <ul className="photo-grid plain-list">
              {review.photos.map((p) => (
                <li key={p.id}>
                  <OwnPhotoView photo={p} alt={photoAlt(p, name, null)} />
                </li>
              ))}
            </ul>
          )}
          <div className="cluster">
            {closed ? (
              <p className="field__hint">{m.review_mine_closed()}</p>
            ) : (
              <button type="button" className="button button--quiet" onClick={() => setMode('edit')}>
                {m.passport_edit()}
              </button>
            )}
            <DeleteReview id={review.id} onDone={done} />
          </div>
        </div>
      ) : visits.length === 0 ? (
        <p>{m.review_mine_needs_visit()}</p>
      ) : closed ? (
        <p>{m.review_mine_closed()}</p>
      ) : signal.visitId !== null ? null : ( // VisitForm's prompt owns the button after a visit was just logged
        <button type="button" className="button" onClick={() => setMode('create')}>
          {m.review_mine_prompt({ name })}
        </button>
      )}
    </section>
  );
}

function DeleteReview({ id, onDone }: { id: string; onDone: () => void }) {
  // The delete of a closed museum's review has no form to hold it: its own confirm step, same call as the form's.
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await sendJson('DELETE', `/api/v1/reviews/${id}`);
      onDone();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  return asking ? (
    <>
      <button type="button" className="button" disabled={busy} onClick={() => void remove()}>
        {m.review_form_delete_sure()}
      </button>
      <button type="button" className="button button--quiet" onClick={() => setAsking(false)}>
        {m.action_cancel()}
      </button>
      {failed ? (
        <span role="alert" className="form-error">
          {m.review_err_gone()}
        </span>
      ) : null}
    </>
  ) : (
    <button type="button" className="button button--quiet" onClick={() => setAsking(true)}>
      {m.passport_delete()}
    </button>
  );
}
