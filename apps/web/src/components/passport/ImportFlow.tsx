import {
  type ImportConfirm,
  type ImportFormat,
  ImportPreview,
  ImportRequest,
  ImportResult,
  type ImportRow,
  type ImportRowError,
  MuseumList,
  type VisitMuseum,
} from '@mjk/contracts';
import { type FormEvent, useId, useState } from 'react';
import { ApiError, getJson, sendJson } from '../../lib/api.ts';
import { formatCount, formatDate } from '../../lib/format.ts';
import { museumName } from '../../lib/names.ts';
import { Link } from '../../lib/router.tsx';
import { type Locale, pathOf } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { describeError } from '../auth/errors.ts';
import { CheckField, Field } from '../auth/fields.tsx';

// Import (A§10, P2c Q8): a CSV or an export file of our own, read in the browser, matched by the
// server, shown as a preview and applied once the member has confirmed. Matched rows apply unless
// unticked; an ambiguous or unmatched row applies only when the member picked a museum for it.

/** The request body cap (A§14); a bigger file is refused before it is sent. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/** `.json` is our own export format (`mjk`); anything else is read as CSV. */
export const formatOf = (fileName: string): ImportFormat => (fileName.toLowerCase().endsWith('.json') ? 'mjk' : 'csv');

/** The confirm body: the picks for rows that need one, and the matched rows the member unticked. */
export function confirmBody(
  preview: ImportPreview,
  skip: ReadonlySet<number>,
  chosen: ReadonlyMap<number, string>,
): ImportConfirm {
  const status = new Map(preview.rows.map((r) => [r.row, r.status]));
  return {
    choose: [...chosen]
      .filter(([row]) => {
        const s = status.get(row);
        return s === 'ambiguous' || s === 'unmatched';
      })
      .map(([row, museum_id]) => ({ row, museum_id })),
    skip: [...skip].filter((row) => status.get(row) === 'matched'),
  };
}

/** One text for what a failed upload or confirm means (A§14: 413 too big, 422 unreadable, 409 done already). */
export function importErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413) return m.import_err_too_big();
    if (error.status === 422) return m.import_err_unreadable();
    if (error.status === 409) return m.import_err_done();
  }
  return describeError(error, 'plain').text;
}

function rowErrorText(error: ImportRowError | null): string {
  switch (error) {
    case 'bad_date':
      return m.import_row_bad_date();
    case 'future_date':
      return m.import_row_future_date();
    case 'no_museum':
      return m.import_row_no_museum();
    case 'too_long':
      return m.import_row_too_long();
    case 'bad_text':
      return m.import_row_bad_text();
    default:
      return m.import_row_invalid();
  }
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'preview'; preview: ImportPreview }
  | { kind: 'done'; result: ImportResult };

export function ImportFlow({ locale }: { locale: Locale }) {
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [fileKey, setFileKey] = useState(0);

  const pick = async (file: File | undefined) => {
    if (file === undefined) return;
    setError(null);
    if (file.size > IMPORT_MAX_BYTES) {
      setError(m.import_err_too_big());
      return;
    }
    setStage({ kind: 'busy' });
    try {
      const body = ImportRequest.safeParse({ format: formatOf(file.name), content: await file.text() });
      if (!body.success) throw new ApiError(422, 'unprocessable', [], null);
      setStage({ kind: 'preview', preview: await sendJson('POST', '/api/v1/me/imports', body.data, ImportPreview) });
    } catch (e) {
      setError(importErrorText(e));
      setStage({ kind: 'idle' });
      setFileKey((n) => n + 1);
    }
  };

  const reset = () => {
    setStage({ kind: 'idle' });
    setError(null);
    setFileKey((n) => n + 1);
  };

  return (
    <section id="import" className="stack" aria-labelledby="import-h">
      <h2 id="import-h">{m.import_h()}</h2>
      <p>{m.import_intro()}</p>
      {stage.kind === 'done' ? (
        <>
          <p role="status" className="notice">
            {m.import_result({
              visits: formatCount(stage.result.visits, locale),
              wishlist: formatCount(stage.result.wishlist, locale),
              skipped: formatCount(stage.result.skipped, locale),
            })}{' '}
            <Link href={pathOf({ page: 'shell', locale, app: 'passport' })}>{m.welcome_to_passport()}</Link>
          </p>
          <button type="button" className="button button--quiet" onClick={reset}>
            {m.import_another()}
          </button>
        </>
      ) : stage.kind === 'preview' ? (
        <Preview
          preview={stage.preview}
          locale={locale}
          onDone={(result) => setStage({ kind: 'done', result })}
          onCancel={reset}
        />
      ) : (
        <Field
          key={fileKey}
          label={m.import_file()}
          hint={m.import_file_hint()}
          name="import_file"
          type="file"
          accept=".csv,.json,text/csv,application/json"
          disabled={stage.kind === 'busy'}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      )}
      {stage.kind === 'busy' ? <p aria-live="polite">{m.loading()}</p> : null}
      {error === null ? null : (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </section>
  );
}

const rowLabel = (row: ImportRow, locale: Locale): string =>
  [
    row.name ?? '',
    row.place,
    row.visited_on === null ? null : formatDate(row.visited_on, locale),
    row.kind === 'wishlist' ? m.import_kind_wishlist() : null,
  ]
    .filter((x): x is string => x !== null && x !== '')
    .join(' · ');

export function Preview({
  preview,
  locale,
  onDone,
  onCancel,
}: {
  preview: ImportPreview;
  locale: Locale;
  onDone: (result: ImportResult) => void;
  onCancel: () => void;
}) {
  const [skip, setSkip] = useState<ReadonlySet<number>>(new Set());
  const [chosen, setChosen] = useState<ReadonlyMap<number, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const by = (status: ImportRow['status']) => preview.rows.filter((r) => r.status === status);
  const matched = by('matched');
  const ambiguous = by('ambiguous');
  const unmatched = by('unmatched');
  const invalid = by('invalid');
  const applying = matched.filter((r) => !skip.has(r.row)).length + confirmBody(preview, skip, chosen).choose.length;

  const pickFor = (row: number, museumId: string) =>
    setChosen((old) => {
      const next = new Map(old);
      if (museumId === '') next.delete(row);
      else next.set(row, museumId);
      return next;
    });
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await sendJson(
          'POST',
          `/api/v1/me/imports/${preview.id}/confirm`,
          confirmBody(preview, skip, chosen),
          ImportResult,
        ),
      );
    } catch (e) {
      setError(importErrorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <p>
        {m.import_counts({
          matched: formatCount(preview.counts.matched, locale),
          ambiguous: formatCount(preview.counts.ambiguous, locale),
          unmatched: formatCount(preview.counts.unmatched, locale),
          invalid: formatCount(preview.counts.invalid, locale),
        })}
      </p>
      {matched.length === 0 ? null : (
        <div className="stack">
          <h3>{m.import_h_matched()}</h3>
          <ul className="plain-list">
            {matched.map((row) => (
              <li key={row.row}>
                <CheckField
                  name={`row-${row.row}`}
                  checked={!skip.has(row.row)}
                  onChange={(e) =>
                    setSkip((old) => {
                      const next = new Set(old);
                      if (e.target.checked) next.delete(row.row);
                      else next.add(row.row);
                      return next;
                    })
                  }
                  label={
                    <span>
                      {row.museum === null ? rowLabel(row, locale) : museumName(row.museum, locale)}
                      <span className="muted"> · {rowLabel(row, locale)}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {ambiguous.length === 0 ? null : (
        <div className="stack">
          <h3>{m.import_h_ambiguous()}</h3>
          {ambiguous.map((row) => (
            <ChooseRow key={row.row} row={row} locale={locale} searchable={false} onPick={pickFor} />
          ))}
        </div>
      )}
      {unmatched.length === 0 ? null : (
        <div className="stack">
          <h3>{m.import_h_unmatched()}</h3>
          {unmatched.map((row) => (
            <ChooseRow key={row.row} row={row} locale={locale} searchable onPick={pickFor} />
          ))}
        </div>
      )}
      {invalid.length === 0 ? null : (
        <div className="stack">
          <h3>{m.import_h_invalid()}</h3>
          <ul>
            {invalid.map((row) => (
              <li key={row.row}>
                {m.import_row_n({ n: formatCount(row.row, locale) })}: {rowErrorText(row.error)}
                <span className="muted"> ({rowLabel(row, locale)})</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error === null ? null : (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="cluster">
        <button type="button" className="button" disabled={busy || applying === 0} onClick={() => void confirm()}>
          {m.import_confirm({ n: formatCount(applying, locale) })}
        </button>
        <button type="button" className="button button--quiet" disabled={busy} onClick={onCancel}>
          {m.action_cancel()}
        </button>
      </div>
    </div>
  );
}

/** An ambiguous (pick one of the candidates) or an unmatched row (search the catalogue, then pick). */
function ChooseRow({
  row,
  locale,
  searchable,
  onPick,
}: {
  row: ImportRow;
  locale: Locale;
  searchable: boolean;
  onPick: (row: number, museumId: string) => void;
}) {
  const [options, setOptions] = useState<readonly VisitMuseum[]>(row.candidates);
  const [q, setQ] = useState('');
  const [searching, setSearching] = useState(false);
  const [failed, setFailed] = useState(false);
  const selectId = useId();

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const term = q.trim().slice(0, 100);
    if (term === '') return;
    setSearching(true);
    setFailed(false);
    try {
      const found = await getJson(`/api/v1/museums?${new URLSearchParams({ q: term, limit: '5' })}`, MuseumList);
      setOptions((old) => [...old, ...found.items.filter((f) => !old.some((o) => o.id === f.id))]);
    } catch {
      setFailed(true);
    }
    setSearching(false);
  };

  return (
    <div className="card stack">
      <p>{rowLabel(row, locale)}</p>
      {searchable ? (
        <form method="post" className="cluster" onSubmit={(e) => void search(e)} noValidate>
          <Field
            label={m.import_search()}
            name="q"
            type="search"
            value={q}
            maxLength={100}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="button button--quiet" disabled={searching}>
            {m.action_search()}
          </button>
        </form>
      ) : null}
      {failed ? (
        <p role="alert" className="form-error">
          {m.import_search_failed()}
        </p>
      ) : null}
      {options.length === 0 ? null : (
        <div className="field">
          <label htmlFor={selectId}>{m.import_pick()}</label>
          <select id={selectId} defaultValue="" onChange={(e) => onPick(row.row, e.target.value)}>
            <option value="">{m.import_pick_none()}</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {museumName(o, locale)}
                {o.place === null ? '' : ` · ${o.place}`}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
