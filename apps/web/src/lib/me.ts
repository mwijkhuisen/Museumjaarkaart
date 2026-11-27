import { Me } from '@mjk/contracts';
import { useCallback, useEffect, useState } from 'react';
import { getJson } from './api.ts';
import { clearHint, setHint } from './member.ts';

// `GET /api/v1/me` for the pages of the app shell (A§15.1). The shell is one static HTML for
// everyone, so nothing about the member is known during the server render or the first client
// render: `me` stays undefined until the effect's fetch answers. It is not a TanStack Query key on
// purpose: the answer is private and never seeded from `mjk-state`.

export type MeState = {
  /** undefined while loading; `{ user: null }` when signed out. */
  me: Me | undefined;
  /** The fetch failed (network or a non-2xx answer). */
  failed: boolean;
  setMe(me: Me): void;
  reload(): void;
};

/** The "signed in" hint of lib/member.ts follows every answer about the member. */
const syncHint = (me: Me) => (me.user === null ? clearHint() : setHint());

export function useMe(): MeState {
  const [me, setMeState] = useState<Me | undefined>(undefined);
  const setMe = useCallback((value: Me) => {
    syncHint(value);
    setMeState(value);
  }, []);
  const [failed, setFailed] = useState(false);
  const [round, setRound] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` is the retry trigger
  useEffect(() => {
    let live = true;
    setFailed(false);
    getJson('/api/v1/me', Me).then(
      (value) => live && setMe(value),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [round]);
  const reload = useCallback(() => setRound((n) => n + 1), []);
  return { me, failed, setMe, reload };
}
