import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { z } from 'zod';
import { getJson } from '../../lib/api.ts';
import { useMe } from '../../lib/me.ts';
import { useRouter } from '../../lib/router.tsx';
import { pathOf, type Route } from '../../lib/routes.ts';
import { m } from '../../paraglide/messages.js';
import { Loading } from '../layout/Layout.tsx';

// The page frame of the member pages (A§15.1): the server render and the first client render are
// the heading and "Loading", the same for everyone; `children` mount once `GET /me` has answered
// with a member. A signed-out visitor is sent to sign-in (a replace: Back does not come here).

export function MemberPage({
  route,
  title,
  children,
}: {
  route: Extract<Route, { page: 'shell' }>;
  title: string;
  children: ReactNode;
}) {
  const { locale } = route;
  const { navigate } = useRouter();
  const { me, failed, reload } = useMe();
  const signedOut = me !== undefined && me.user === null;
  useEffect(() => {
    if (signedOut) navigate(pathOf({ page: 'shell', locale, app: 'signin' }), { replace: true });
  }, [signedOut, navigate, locale]);

  let body: ReactNode;
  if (failed) {
    body = (
      <>
        <p role="alert" className="form-error">
          {m.auth_me_failed()}
        </p>
        <button type="button" className="button" onClick={reload}>
          {m.auth_retry()}
        </button>
      </>
    );
  } else if (me === undefined || me.user === null) {
    body = <Loading />;
  } else {
    body = children;
  }
  return (
    <div className="stack">
      <h1>{title}</h1>
      {body}
    </div>
  );
}

/**
 * One member GET, parsed with its contract. `data` is undefined while loading; `failed` after a
 * non-2xx answer or a network error; `reload` fetches again. Not a TanStack key: private data is
 * never seeded or cached across pages.
 */
export function useJson<S extends z.ZodType>(path: string, schema: S) {
  const [data, setData] = useState<z.output<S> | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the retry trigger; the schema is a module constant
  useEffect(() => {
    let live = true;
    setFailed(false);
    getJson(path, schema).then(
      (value) => live && setData(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [path, round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { data, failed, reload };
}

/** The line under a failed load, with a retry. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <>
      <p role="alert" className="form-error">
        {m.passport_load_failed()}
      </p>
      <button type="button" className="button" onClick={onRetry}>
        {m.auth_retry()}
      </button>
    </>
  );
}
