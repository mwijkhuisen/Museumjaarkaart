import { PublicReview, ReviewList } from '@mjk/contracts';

// One public review as the API answers it (P3a), for the page and component tests. The body is whatever the
// test passes: a hostile one stays text.

export const REVIEW_ID = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';

export const review = (over: Record<string, unknown> = {}): PublicReview =>
  PublicReview.parse({
    id: REVIEW_ID,
    museum: {
      id: '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11',
      slug: 'voorbeeld-museum',
      name: 'Voorbeeldmuseum',
      name_en: 'Example Museum',
    },
    author: { handle: 'anna_b', display_name: 'Anna de Vries', active: true, former_member: false },
    visited_on: '2026-09-12',
    rating: 4,
    collection: 5,
    presentation: null,
    kid_friendly: null,
    accessibility: 3,
    facilities: null,
    value_for_money: null,
    body: 'Mooie collectie.',
    created_at: '2026-10-01T10:00:00.000Z',
    edited_at: null,
    photos: [],
    ...over,
  });

export const reviewList = (items: PublicReview[] = [review()], next: string | null = null): ReviewList =>
  ReviewList.parse({ items, next_cursor: next });
