import { useSyncExternalStore } from 'react';

// The one thing VisitForm and MyReviewSlot share on a museum page (P3a): a visit was just logged (`visitId`, so the
// slot fetches again), whether the member already has a review here (`hasReview`, so the prompt hides) and a request to
// open the review form (`open`). Client only: the server snapshot is the empty state, like useMarks.
// ponytail: one module-level store, one museum page at a time; a page change resets it through MyReviewSlot.

type State = { visitId: string | null; hasReview: boolean; open: number };
let state: State = { visitId: null, hasReview: false, open: 0 };
const listeners = new Set<() => void>();
const set = (next: Partial<State>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

export const offerReview = (visitId: string) => set({ visitId });
export const openReview = () => set({ open: state.open + 1 });
export const setHasReview = (hasReview: boolean) => set({ hasReview });
export const resetSignal = () => set({ visitId: null, hasReview: false });

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const empty: State = { visitId: null, hasReview: false, open: 0 };
export const useReviewSignal = (): State =>
  useSyncExternalStore(
    subscribe,
    () => state,
    () => empty,
  );

const ZONE = 'Europe/Amsterdam';
/** `closed_on` on or before today in the Netherlands: no new review, no edit (A§11). */
export const isClosed = (closedOn: string | null): boolean =>
  closedOn !== null && closedOn <= new Date().toLocaleDateString('sv', { timeZone: ZONE });
