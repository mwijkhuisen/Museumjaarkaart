import { Marks } from '@mjk/contracts';
import { useEffect, useSyncExternalStore } from 'react';
import { ApiFailure, getJson, sendJson } from './api.ts';

// The member's own marks on the public pages (A§15.1). Public HTML is one document for everyone, so
// nothing about the member exists during the server render or the first client render. After
// hydration `useMarks()` asks `GET /api/v1/me/marks`, but only when this browser holds the "signed
// in" hint: one `localStorage` key that says "this browser has had a member session". An anonymous
// visitor has no hint and makes no `/api/v1` request. The hint is a convenience, never an
// authority: the session cookie decides, and a `{ marks: null }` or 401 answer removes the hint.
// Marks are never a TanStack Query key: they are private and never seeded from `mjk-state`.

const KEY = 'mjk-member';

/** Every access is guarded: a private window or blocked site data throws, and the server has no storage. */
function guarded<T>(fn: (storage: Storage) => T): T | undefined {
  try {
    return fn(localStorage);
  } catch {
    return undefined;
  }
}

export const hasHint = (): boolean => guarded((s) => s.getItem(KEY) === '1') === true;

/** The member's session was seen (`GET /me` answered a user). */
export function setHint(): void {
  if (hasHint()) return;
  guarded((s) => s.setItem(KEY, '1'));
  resetMarks();
}

/** `GET /me` or `GET /me/marks` answered "signed out". */
export function clearHint(): void {
  guarded((s) => s.removeItem(KEY));
  resetMarks();
}

export type MarkSets = { visited: ReadonlySet<string>; wishlist: ReadonlySet<string> };

// ponytail: one module-level store, one load per page load. A second tab's change shows after a reload.
let snapshot: MarkSets | undefined;
let loading: Promise<void> | null = null;
let epoch = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

function resetMarks(): void {
  epoch++;
  snapshot = undefined;
  loading = null;
  emit();
}

/** The one `GET /me/marks` of this page load; resolves at once, with no request, when there is no hint. */
export function loadMarks(): Promise<void> {
  if (loading !== null) return loading;
  if (!hasHint()) return Promise.resolve();
  const mine = epoch;
  loading = getJson('/api/v1/me/marks', Marks).then(
    ({ marks }) => {
      if (mine !== epoch) return;
      if (marks === null) return clearHint();
      snapshot = { visited: new Set(marks.visited), wishlist: new Set(marks.wishlist) };
      emit();
    },
    (error: unknown) => {
      if (mine !== epoch) return;
      // Any other failure shows no marks and is not retried before the next page load.
      if (error instanceof ApiFailure && error.status === 401) clearHint();
    },
  );
  return loading;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const getSnapshot = () => snapshot;
const getServerSnapshot = (): undefined => undefined;

/** undefined for an anonymous visitor, on the server, in the first client render and until the marks arrive. */
export function useMarks(): MarkSets | undefined {
  useEffect(() => {
    void loadMarks();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

const add = (set: ReadonlySet<string>, id: string) => new Set(set).add(id);
const without = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set);
  next.delete(id);
  return next;
};

/** PUT or DELETE the wishlist entry, then show it. A throw (ApiError) leaves the marks as they were. */
export async function setWishlisted(museumId: string, wanted: boolean): Promise<void> {
  const mine = epoch;
  await sendJson(wanted ? 'PUT' : 'DELETE', `/api/v1/me/wishlist/${museumId}`);
  if (mine !== epoch || snapshot === undefined) return;
  snapshot = { ...snapshot, wishlist: (wanted ? add : without)(snapshot.wishlist, museumId) };
  emit();
}

/** After `POST /me/visits` answered: the museum is visited now. */
export function markVisited(museumId: string): void {
  if (snapshot === undefined) return;
  snapshot = { ...snapshot, visited: add(snapshot.visited, museumId) };
  emit();
}
