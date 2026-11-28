import {
  ASPECTS,
  type Aspect,
  codePoints,
  type MuseumDetail,
  OwnReview,
  REVIEW_BODY_MAX,
  ReviewCreate,
  ReviewPatch,
  type Visit,
} from '@mjk/contracts';
import { type FormEvent, useCallback, useId, useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import { formatDate } from '../../lib/format.ts';
import { museumName } from '../../lib/names.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import type { Failure } from '../auth/errors.ts';
import { FormError } from '../auth/fields.tsx';
import { PhotoUploader } from '../photos/PhotoUploader.tsx';
import { describeReviewError, reviewFields } from './errors.ts';

// The member's review form (A§11, owner N2, P3a): a visit picker, the overall rating and six aspects as native
// radio groups (the keyboard works without any script of ours), the text with a code-point counter, save, and in edit
// mode delete behind a confirm step. The schemas of @mjk/contracts validate before anything is sent; no text is
// stripped silently (a body the rule refuses gets its own message).

const ASPECT_LABEL: Record<Aspect, () => string> = {
  collection: () => m.review_form_aspect_collection(),
  presentation: () => m.review_form_aspect_presentation(),
  kid_friendly: () => m.review_form_aspect_kid_friendly(),
  accessibility: () => m.review_form_aspect_accessibility(),
  facilities: () => m.review_form_aspect_facilities(),
  value_for_money: () => m.review_form_aspect_value_for_money(),
};

const STARS = [1, 2, 3, 4, 5] as const;

function RadioGroup({
  legend,
  name,
  value,
  onChange,
  none,
  error,
}: {
  legend: string;
  name: string;
  value: number;
  onChange: (n: number) => void;
  none?: string;
  error?: string | undefined;
}) {
  const errorId = `${name}-error`;
  const options = none === undefined ? STARS : ([0, ...STARS] as const);
  return (
    <fieldset className="choice-group" aria-describedby={error ? errorId : undefined}>
      <legend>{legend}</legend>
      <div className="choice-row">
        {options.map((n) => (
          <label key={n} className="choice">
            <input type="radio" name={name} value={n} checked={value === n} onChange={() => onChange(n)} />
            <span>{n === 0 ? none : m.review_form_stars({ n: String(n) })}</span>
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} className="field__error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function ReviewForm({
  museum,
  locale,
  visits,
  review,
  visitId,
  onSaved,
  onDeleted,
  onCancel,
}: {
  museum: Pick<MuseumDetail, 'id' | 'name' | 'name_en' | 'photo_policy'>;
  locale: Locale;
  visits: readonly Visit[];
  review?: OwnReview | undefined;
  visitId?: string | undefined;
  onSaved: (review: OwnReview) => void;
  onDeleted: () => void;
  onCancel?: () => void;
}) {
  const uid = useId();
  const [visit, setVisit] = useState(review?.visit_id ?? visitId ?? visits[0]?.id ?? '');
  const [rating, setRating] = useState(review?.rating ?? 0);
  const [aspects, setAspects] = useState<Record<Aspect, number>>(
    () => Object.fromEntries(ASPECTS.map((a) => [a, review?.[a] ?? 0])) as Record<Aspect, number>,
  );
  const [body, setBody] = useState(review?.body ?? '');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  // A new review's photos are uploaded first and attached by id; the form waits for files still on their way.
  const [media, setMedia] = useState<{ ids: string[]; sending: boolean }>({ ids: [], sending: false });
  const onMedia = useCallback((ids: string[], sending: boolean) => setMedia({ ids, sending }), []);
  const n = codePoints(body);
  const field = (name: string) => failure?.fields[name];

  const run = async (fn: () => Promise<void>, ctx: 'create' | 'edit' | 'delete') => {
    setBusy(true);
    setFailure(null);
    try {
      await fn();
    } catch (error) {
      setFailure(describeReviewError(error, ctx));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const aspectValues = Object.fromEntries(ASPECTS.map((a) => [a, aspects[a] === 0 ? null : aspects[a]]));
    const parsed =
      review === undefined
        ? ReviewCreate.safeParse({
            museum_id: museum.id,
            visit_id: visit,
            rating: rating === 0 ? undefined : rating,
            ...Object.fromEntries(Object.entries(aspectValues).filter(([, v]) => v !== null)),
            body,
            ...(media.ids.length === 0 ? {} : { media_ids: media.ids }),
          })
        : ReviewPatch.safeParse({
            ...(visit === review.visit_id ? {} : { visit_id: visit }),
            rating: rating === 0 ? undefined : rating,
            ...aspectValues,
            body,
          });
    if (!parsed.success) {
      const names = parsed.error.issues.map((i) => String(i.path[0]));
      setFailure({ text: m.review_err_invalid(), fields: reviewFields(names) });
      return;
    }
    void run(
      async () => {
        const saved =
          review === undefined
            ? await sendJson('POST', '/api/v1/reviews', parsed.data, OwnReview)
            : await sendJson('PATCH', `/api/v1/reviews/${review.id}`, parsed.data, OwnReview);
        onSaved(saved);
      },
      review === undefined ? 'create' : 'edit',
    );
  };

  const remove = () =>
    review === undefined
      ? undefined
      : void run(async () => {
          await sendJson('DELETE', `/api/v1/reviews/${review.id}`);
          onDeleted();
        }, 'delete');

  const chosen = visits.find((v) => v.id === visit);
  const bodyError = field('body') ?? (n > REVIEW_BODY_MAX ? m.review_err_field_body() : undefined);
  return (
    <form method="post" className="stack review-form" onSubmit={submit} noValidate>
      <h3>{m.review_form_h({ name: museumName(museum, locale) })}</h3>
      <div className="field">
        <label htmlFor={`${uid}-visit`}>{m.review_form_visit()}</label>
        <select
          id={`${uid}-visit`}
          value={visit}
          aria-invalid={field('visit_id') ? true : undefined}
          onChange={(e) => setVisit(e.target.value)}
        >
          {visits.map((v) => (
            <option key={v.id} value={v.id}>
              {v.visited_on === null ? m.passport_date_unknown() : formatDate(v.visited_on, locale)}
            </option>
          ))}
        </select>
        {field('visit_id') ? <p className="field__error">{field('visit_id')}</p> : null}
        <p className="field__hint">
          {chosen?.visited_on == null
            ? m.review_form_public_date_unknown()
            : m.review_form_public_date({ date: formatDate(chosen.visited_on, locale) })}
        </p>
      </div>
      <RadioGroup
        legend={m.review_form_rating()}
        name={`${uid}-rating`}
        value={rating}
        onChange={setRating}
        error={field('rating')}
      />
      <h4>{m.review_form_aspects_h()}</h4>
      <p className="field__hint">{m.review_form_aspects_hint()}</p>
      {ASPECTS.map((a) => (
        <RadioGroup
          key={a}
          legend={ASPECT_LABEL[a]()}
          name={`${uid}-${a}`}
          value={aspects[a]}
          onChange={(v) => setAspects((old) => ({ ...old, [a]: v }))}
          none={m.review_form_none()}
          error={field(a)}
        />
      ))}
      <div className="field">
        <label htmlFor={`${uid}-body`}>{m.review_form_body()}</label>
        <textarea
          id={`${uid}-body`}
          rows={6}
          value={body}
          aria-invalid={bodyError ? true : undefined}
          aria-describedby={`${uid}-count`}
          onChange={(e) => setBody(e.target.value)}
        />
        <p id={`${uid}-count`} className="field__hint">
          {n} / {REVIEW_BODY_MAX}
        </p>
        {bodyError ? <p className="field__error">{bodyError}</p> : null}
      </div>
      <PhotoUploader
        museum={museum}
        museumLabel={museumName(museum, locale)}
        reviewId={review?.id}
        photos={review?.photos}
        onChange={onMedia}
      />
      <FormError failure={failure} />
      <div className="cluster">
        <button type="submit" className="button" disabled={busy || media.sending}>
          {m.action_save()}
        </button>
        {onCancel === undefined ? null : (
          <button type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>
            {m.action_cancel()}
          </button>
        )}
        {review === undefined ? null : asking ? (
          <>
            <button type="button" className="button" disabled={busy} onClick={remove}>
              {m.review_form_delete_sure()}
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
    </form>
  );
}
