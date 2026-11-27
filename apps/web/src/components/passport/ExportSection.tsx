import { type ExportItem, ExportList } from '@mjk/contracts';
import { useState } from 'react';
import { ApiError, sendJson } from '../../lib/api.ts';
import { formatDateTime } from '../../lib/format.ts';
import type { Locale } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { describeError, useAction } from '../auth/errors.ts';
import { FormError } from '../auth/fields.tsx';
import { LoadFailed, useJson } from './MemberPage.tsx';

// "Download my data" (A§10, D10): a button that queues an export, and the member's exports with
// their links while they last. Mounted inside the account page, so the member is known.

/** 409: one is already being made; 429: three a day (A§14). Anything else is the common text. */
export function exportErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return m.export_err_busy();
    if (error.status === 429) return m.export_err_limit();
  }
  return describeError(error, 'plain').text;
}

const STATE = {
  queued: m.export_state_queued,
  ready: m.export_state_ready,
  failed: m.export_state_failed,
} as const satisfies Record<ExportItem['state'], () => string>;

export function ExportSection({ locale }: { locale: Locale }) {
  const { data, failed, reload } = useJson('/api/v1/me/exports', ExportList);
  const { busy, failure, setFailure, run } = useAction('plain');
  const [started, setStarted] = useState(false);

  const start = () => {
    setStarted(false);
    void run(async () => {
      try {
        await sendJson('POST', '/api/v1/me/exports');
      } catch (error) {
        setFailure({ text: exportErrorText(error), fields: {} });
        return;
      }
      setStarted(true);
      reload();
    });
  };

  return (
    <section className="stack" aria-labelledby="account-export">
      <h2 id="account-export">{m.export_h()}</h2>
      <p>{m.export_intro()}</p>
      <div className="cluster">
        <button type="button" className="button" disabled={busy} onClick={start}>
          {m.export_start()}
        </button>
        <button type="button" className="button button--quiet" onClick={reload}>
          {m.export_refresh()}
        </button>
      </div>
      <FormError failure={failure} />
      <p role="status" className="notice">
        {started ? m.export_started() : ''}
      </p>
      {failed ? <LoadFailed onRetry={reload} /> : null}
      {data === undefined || data.items.length === 0 ? null : (
        <ul className="plain-list stack">
          {data.items.map((item) => (
            <li key={item.id} className="card stack">
              <p>
                {formatDateTime(item.created_at, locale)} · {STATE[item.state]()}
              </p>
              {item.files.length === 0 ? null : (
                <>
                  {item.expires_at === null ? null : (
                    <p className="muted">{m.export_expires({ at: formatDateTime(item.expires_at, locale) })}</p>
                  )}
                  <ul className="plain-list cluster">
                    {item.files.map((file) => (
                      <li key={file}>
                        <a className="button button--quiet" href={`/api/v1/me/exports/${item.id}/${file}`} download>
                          {file}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
