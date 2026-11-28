import type { Visit } from '@mjk/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import nl from '../messages/nl.json' with { type: 'json' };
import { MyReviewSlot } from '../src/components/reviews/MyReviewSlot.tsx';
import { ReviewForm } from '../src/components/reviews/ReviewForm.tsx';

// P3a WP7: the server render of the member's review form (native radio groups, labels, counter, public-date notice,
// no inline style) and the empty slot every visitor gets (A§15.1).

const ID = '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11';
const museum = { id: ID, slug: 'm', name: 'Museum <b>', name_en: null, photo_policy: 'allowed' as const };
const visit = (id: string, visited_on: string | null): Visit => ({
  id,
  museum: { id: ID, slug: 'm', name: 'Museum', name_en: null, place: 'Utrecht' },
  visited_on,
  note: null,
  source: 'manual',
  created_at: '2026-09-12T10:00:00Z',
});
const visits = [
  visit('a0d0c3e5-5b2e-4f3a-8a53-0c2d5f9d1a11', '2026-09-12'),
  visit('b0d0c3e5-5b2e-4f3a-8a53-0c2d5f9d1a11', null),
];

describe('ReviewForm (server render)', () => {
  const html = renderToStaticMarkup(
    <ReviewForm museum={museum} locale="nl" visits={visits} onSaved={() => {}} onDeleted={() => {}} />,
  );

  it('has seven radio fieldsets and the photo consents with legends, native radios and a label on every input', () => {
    expect(html.match(/<fieldset/g)).toHaveLength(8);
    expect(html.match(/<legend>/g)).toHaveLength(8);
    // rating: 5 radios; six aspects: 6 each
    expect(html.match(/type="radio"/g)).toHaveLength(5 + 6 * 6);
    expect(html.match(/<label class="choice"><input type="radio"/g)).toHaveLength(5 + 6 * 6);
    expect(html).toContain('<label for=');
    expect(html).toContain('1 van 5');
    expect(html).toContain('>geen<');
  });

  it('has the counter, the public-date notice and the visit picker, escaped', () => {
    expect(html).toContain('0 / 5000');
    expect(html).toContain(nl.review_form_public_date.replace('{date}', '12 september 2026'));
    expect(html).toContain(nl.passport_date_unknown);
    expect(html).toContain('Museum &lt;b&gt;');
    expect(html).not.toMatch(/style=/);
  });
});

describe('MyReviewSlot (server render)', () => {
  it('renders nothing', () => {
    expect(renderToStaticMarkup(<MyReviewSlot museum={{ ...museum, closed_on: null } as never} locale="nl" />)).toBe(
      '',
    );
  });
});
