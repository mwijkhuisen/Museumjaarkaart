// Ratings and reviews (A§8 `review`, D13, ADR-0017, P3a). WP2 adds the request and answer schemas here.

/** The six optional aspect ratings of a review (owner, P3a Q1), in display order; each is 1–5 or null. */
export const ASPECTS = [
  'collection',
  'presentation',
  'kid_friendly',
  'accessibility',
  'facilities',
  'value_for_money',
] as const;
export type Aspect = (typeof ASPECTS)[number];
