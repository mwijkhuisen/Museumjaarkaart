import { useState } from 'react';
import type { z } from 'zod';
import { getJson } from '../../lib/api.ts';
import { m } from '../../paraglide/messages.js';

// "Meer" on a public list (the profile's visits, wishlist and reviews, a museum's reviews): the server-rendered
// first page stays, the next ones are fetched in the browser only, with the page's own contract.

type Page<T> = { items: T[]; next: string | null };

/** The inline first page plus whatever "meer" has fetched since; the browser only. */
export function useMore<T>(first: Page<T>, path: string, schema: z.ZodType<Page<T>>) {
  const [items, setItems] = useState<T[]>(first.items);
  const [next, setNext] = useState<string | null>(first.next);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const more = () => {
    if (next === null || busy) return;
    setBusy(true);
    setFailed(false);
    getJson(`${path}?cursor=${next}`, schema).then(
      (page) => {
        setItems((all) => [...all, ...page.items]);
        setNext(page.next);
        setBusy(false);
      },
      () => {
        setFailed(true);
        setBusy(false);
      },
    );
  };
  return { items, next, busy, failed, more };
}

export function More({
  next,
  busy,
  failed,
  more,
}: {
  next: string | null;
  busy: boolean;
  failed: boolean;
  more: () => void;
}) {
  return (
    <>
      {failed ? (
        <p role="alert" className="form-error">
          {m.profile_more_failed()}
        </p>
      ) : null}
      {next === null ? null : (
        <p>
          <button type="button" className="button button--quiet" disabled={busy} onClick={more}>
            {m.profile_more()}
          </button>
        </p>
      )}
    </>
  );
}
