import {
  isAltText,
  MediaAltPatch,
  type MuseumDetail,
  OwnPhoto,
  PHOTOS_PER_REVIEW,
  type UploadStatus,
} from '@mjk/contracts';
import { type ChangeEvent, useEffect, useId, useRef, useState } from 'react';
import { sendJson } from '../../lib/api.ts';
import { checkFile, UploadError, type UploadErrorCode, uploadPhoto } from '../../lib/upload.ts';
import { m } from '../../paraglide/messages.js';
import { OwnPhotoView, photoAlt } from './Picture.tsx';

// The photo section of the review form (P3b, A§12): three consents that unlock the file input, the museum's photo
// rule, one row per photo with its progress, its state, its description and a remove button. Files are checked
// (type, size) before any request. The CSP allows no blob: URL, so a photo is shown only from our own preview
// route or, once approved, from media.<domain>.
//
// A new review has no id yet: its photos upload unattached and their ids go to the form (`onChange`), which sends
// them as `media_ids`. A photo of an existing review uploads with `review_id`.

/** The museum's photography rule: `forbidden` warns, never blocks (owner decision Q4). */
export function PolicyNote({ policy }: { policy: MuseumDetail['photo_policy'] }) {
  switch (policy) {
    case 'forbidden':
      return (
        <p role="note" className="photo-warning">
          {m.photo_policy_forbidden()}
        </p>
      );
    case 'no_flash':
      return <p className="field__hint">{m.photo_policy_no_flash()}</p>;
    case 'unknown':
      return <p className="field__hint">{m.photo_policy_unknown()}</p>;
    case 'allowed':
      return null;
  }
}

export function uploadErrorText(code: UploadErrorCode | 'failed'): string {
  switch (code) {
    case 'type':
      return m.photo_err_type();
    case 'size':
      return m.photo_err_size();
    case 'photos':
      return m.photo_err_photos();
    case 'consents':
      return m.photo_err_consents();
    case 'rate_limited':
      return m.photo_err_rate_limited();
    case 'unavailable':
      return m.photo_err_unavailable();
    case 'network':
      return m.photo_err_network();
    case 'timeout':
      return m.photo_err_timeout();
    case 'rejected':
      return m.photo_err_rejected();
    case 'failed':
      return m.photo_err_failed();
    case 'other':
      return m.photo_err_other();
  }
}

type Item = {
  key: string;
  id: string | null;
  name: string;
  stage: 'sending' | 'waiting' | 'done' | 'error';
  sent: number;
  total: number;
  photo: OwnPhoto | null;
  error: UploadErrorCode | 'failed' | null;
  alt: string;
  altNote: 'saved' | 'invalid' | null;
  removeFailed: boolean;
};

const fromOwn = (p: OwnPhoto): Item => ({
  key: p.id,
  id: p.id,
  name: '',
  stage: 'done',
  sent: 0,
  total: 0,
  photo: p,
  error: null,
  alt: p.alt_text ?? '',
  altNote: null,
  removeFailed: false,
});

/** The OwnPhoto of a finished upload: approved photos carry their variant keys (`p/<key>/<w>.<ext>`). */
function photoOf(status: UploadStatus, alt: string): OwnPhoto {
  const parsed = status.keys.map((k) => /^p\/([0-9a-f]{32})\/([0-9]+)\.avif$/.exec(k));
  const widths = parsed.flatMap((r) => (r === null ? [] : [Number(r[2])]));
  const key = parsed.find((r) => r !== null)?.[1] ?? null;
  return {
    id: status.id,
    state: status.state,
    width: null,
    height: null,
    alt_text: alt === '' ? null : alt,
    public_key: key,
    widths,
  };
}

export function PhotoUploader({
  museum,
  museumLabel,
  reviewId,
  photos = [],
  onChange,
}: {
  museum: Pick<MuseumDetail, 'id' | 'photo_policy'>;
  /** The museum's name in the page's language, for the generated alt text. */
  museumLabel: string;
  /** The saved review's id; undefined for a review that does not exist yet. */
  reviewId?: string | undefined;
  photos?: readonly OwnPhoto[] | undefined;
  /** The ids that may be sent as `media_ids`, and whether a file is still on its way to the server. */
  onChange?: (ids: string[], sending: boolean) => void;
}) {
  const uid = useId();
  const [consents, setConsents] = useState({ own: false, people: false, artwork: false });
  const [items, setItems] = useState<Item[]>(() => photos.map(fromOwn));
  const [pickError, setPickError] = useState<UploadErrorCode | null>(null);
  const counter = useRef(0);
  const ready = consents.own && consents.people && consents.artwork;
  const live = items.filter((i) => i.error === null).length;
  const full = live >= PHOTOS_PER_REVIEW;

  useEffect(() => {
    onChange?.(
      items.flatMap((i) => (i.id !== null && i.error === null && i.stage !== 'sending' ? [i.id] : [])),
      items.some((i) => i.stage === 'sending'),
    );
  }, [items, onChange]);

  const patch = (key: string, over: Partial<Item>) =>
    setItems((old) => old.map((i) => (i.key === key ? { ...i, ...over } : i)));

  const pick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file === undefined) return;
    const problem = checkFile(file);
    setPickError(problem);
    if (problem !== null) return;
    const key = `u${++counter.current}`;
    setItems((old) => [
      ...old,
      {
        key,
        id: null,
        name: file.name,
        stage: 'sending',
        sent: 0,
        total: file.size,
        photo: null,
        error: null,
        alt: '',
        altNote: null,
        removeFailed: false,
      },
    ]);
    uploadPhoto(file, {
      museumId: museum.id,
      reviewId,
      onProgress: (sent) => patch(key, { sent }),
      onUploaded: (id) => patch(key, { id, stage: 'waiting' }),
    }).then(
      (status) =>
        setItems((old) =>
          old.map((i) => {
            if (i.key !== key) return i;
            if (status.state === 'failed' || status.state === 'removed')
              return { ...i, id: status.id, stage: 'error', error: 'failed' };
            return { ...i, id: status.id, stage: 'done', photo: photoOf(status, i.alt) };
          }),
        ),
      (error: unknown) => patch(key, { stage: 'error', error: error instanceof UploadError ? error.code : 'other' }),
    );
  };

  const saveAlt = async (item: Item) => {
    const text = item.alt.trim();
    if (item.id === null || (text !== '' && !isAltText(text))) return patch(item.key, { altNote: 'invalid' });
    try {
      const saved = await sendJson(
        'PATCH',
        `/api/v1/media/${item.id}`,
        MediaAltPatch.parse({ alt_text: text === '' ? null : text }),
        OwnPhoto,
      );
      patch(item.key, {
        altNote: 'saved',
        photo: item.photo === null ? null : { ...item.photo, alt_text: saved.alt_text },
      });
    } catch {
      patch(item.key, { altNote: 'invalid' });
    }
  };

  const remove = async (item: Item) => {
    try {
      await sendJson('DELETE', `/api/v1/media/${item.id}`);
      setItems((old) => old.filter((i) => i.key !== item.key));
    } catch {
      patch(item.key, { removeFailed: true });
    }
  };

  const dismiss = (key: string) => setItems((old) => old.filter((i) => i.key !== key));
  const hintId = `${uid}-hint`;
  const errorId = `${uid}-error`;
  return (
    <section className="stack photo-section" aria-labelledby={`${uid}-h`}>
      <h4 id={`${uid}-h`}>{m.photo_h()}</h4>
      <PolicyNote policy={museum.photo_policy} />
      <fieldset className="choice-group">
        <legend>{m.photo_consents_legend()}</legend>
        <label className="choice">
          <input
            type="checkbox"
            checked={consents.own}
            onChange={(e) => setConsents((c) => ({ ...c, own: e.target.checked }))}
          />
          <span>{m.photo_consent_own()}</span>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={consents.people}
            onChange={(e) => setConsents((c) => ({ ...c, people: e.target.checked }))}
          />
          <span>{m.photo_consent_people()}</span>
        </label>
        <label className="choice">
          <input
            type="checkbox"
            checked={consents.artwork}
            onChange={(e) => setConsents((c) => ({ ...c, artwork: e.target.checked }))}
          />
          <span>{m.photo_consent_artwork()}</span>
        </label>
      </fieldset>
      <div className="field">
        <label htmlFor={`${uid}-file`}>{m.photo_file()}</label>
        <input
          id={`${uid}-file`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={!ready || full}
          aria-describedby={`${hintId}${pickError === null ? '' : ` ${errorId}`}`}
          aria-invalid={pickError === null ? undefined : true}
          onChange={pick}
        />
        <p id={hintId} className="field__hint">
          {ready ? m.photo_hint({ n: String(PHOTOS_PER_REVIEW) }) : m.photo_consents_needed()}
        </p>
        {pickError === null ? null : (
          <p id={errorId} className="field__error" role="alert">
            {uploadErrorText(pickError)}
          </p>
        )}
      </div>
      {items.length === 0 ? null : (
        <ul className="photo-list plain-list">
          {items.map((item) => {
            const alt = photoAlt({ alt_text: item.photo?.alt_text ?? null }, museumLabel, null);
            const altId = `${uid}-alt-${item.key}`;
            const noteId = `${altId}-note`;
            return (
              <li key={item.key} className="card stack">
                {item.name === '' ? null : <p className="muted">{item.name}</p>}
                {item.stage === 'sending' ? (
                  <progress value={item.sent} max={item.total} aria-label={m.photo_sending({ name: item.name })} />
                ) : item.stage === 'waiting' ? (
                  <p role="status">{m.photo_processing()}</p>
                ) : item.stage === 'error' ? (
                  <p role="alert" className="field__error">
                    {uploadErrorText(item.error ?? 'other')}
                  </p>
                ) : item.photo !== null ? (
                  <OwnPhotoView photo={item.photo} alt={alt} />
                ) : null}
                {item.id !== null && item.stage !== 'error' && item.photo?.state !== 'rejected' ? (
                  <div className="field">
                    <label htmlFor={altId}>{m.photo_alt_label()}</label>
                    <input
                      id={altId}
                      type="text"
                      value={item.alt}
                      maxLength={1000}
                      aria-describedby={item.altNote === null ? undefined : noteId}
                      aria-invalid={item.altNote === 'invalid' ? true : undefined}
                      onChange={(e) => patch(item.key, { alt: e.target.value, altNote: null })}
                      onKeyDown={(e) => {
                        // Enter saves the description, never the whole review form around it.
                        if (e.key !== 'Enter') return;
                        e.preventDefault();
                        void saveAlt(item);
                      }}
                    />
                    {item.altNote === null ? null : (
                      <p
                        id={noteId}
                        role={item.altNote === 'invalid' ? 'alert' : 'status'}
                        className={item.altNote === 'invalid' ? 'field__error' : 'field__hint'}
                      >
                        {item.altNote === 'invalid' ? m.photo_err_alt() : m.photo_alt_saved()}
                      </p>
                    )}
                    <button type="button" className="button button--quiet" onClick={() => void saveAlt(item)}>
                      {m.photo_alt_save()}
                    </button>
                  </div>
                ) : null}
                {item.removeFailed ? (
                  <p role="alert" className="field__error">
                    {m.photo_err_remove()}
                  </p>
                ) : null}
                {item.stage === 'sending' ? null : item.stage === 'error' || item.id === null ? (
                  <button type="button" className="button button--quiet" onClick={() => dismiss(item.key)}>
                    {m.photo_dismiss()}
                  </button>
                ) : (
                  <button type="button" className="button button--quiet" onClick={() => void remove(item)}>
                    {m.photo_remove()}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
