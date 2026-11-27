import { ApiError } from '../../lib/api.ts';
import { m } from '../../paraglide/messages.js';
import { describeError, type Failure } from '../auth/errors.ts';

// The review calls' error texts (A§14, P3a): the same status means something else here than in the auth forms
// (a 409 is "closed" or "already reviewed", never "verify"). Chosen by name, never by a computed key.

export type ReviewCtx = 'create' | 'edit' | 'delete' | 'visit_delete';

export function reviewFieldText(name: string): string {
  switch (name) {
    case 'rating':
      return m.review_err_field_rating();
    case 'body':
      return m.review_err_field_body();
    case 'visit_id':
      return m.review_err_field_visit();
    case 'collection':
    case 'presentation':
    case 'kid_friendly':
    case 'accessibility':
    case 'facilities':
    case 'value_for_money':
      return m.review_err_field_aspect();
    default:
      return m.auth_err_field_generic();
  }
}

export const reviewFields = (names: readonly string[]): Record<string, string> =>
  Object.fromEntries(names.map((n) => [n, reviewFieldText(n)]));

export function describeReviewError(error: unknown, ctx: ReviewCtx): Failure {
  if (error instanceof ApiError) {
    const fields = reviewFields(error.fields);
    switch (error.code) {
      case 'conflict':
        if (ctx === 'visit_delete') return { text: m.review_err_visit_cited(), fields };
        return { text: ctx === 'create' ? m.review_err_conflict_create() : m.review_err_conflict_edit(), fields };
      case 'terms_required':
        return { text: m.review_err_terms(), fields };
      case 'invalid':
        return { text: m.review_err_invalid(), fields };
      case 'rate_limited':
        return { text: m.review_err_rate_limited(), fields };
      case 'not_found':
        return { text: m.review_err_gone(), fields };
    }
  }
  return describeError(error, 'plain');
}
