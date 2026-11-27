import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewCard } from '../src/components/reviews/ReviewCard.tsx';
import { ReviewList } from '../src/components/reviews/ReviewList.tsx';
import { RouterProvider } from '../src/lib/router.tsx';
import type { Locale } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';
import { review, reviewList } from './review-fixture.ts';

// P3a criterion 3 (invariant 5), server side: a review body is user text. It reaches the page as ONE escaped text
// node in <p class="review-body" dir="auto">: no markup, no <br>, no style=, no markdown. Its line breaks are CSS's
// (white-space: pre-line), and the emoji is just text. The SPA path is e2e/hostile.spec.ts.

const HOSTILE = '</script><b>x</b> [x](y)\nTweede regel 🦊';
const ESCAPED = '&lt;/script&gt;&lt;b&gt;x&lt;/b&gt; [x](y)\nTweede regel 🦊';

function html(node: React.ReactNode, locale: Locale = 'nl'): string {
  setLocale(locale, { reload: false });
  return renderToStaticMarkup(<RouterProvider initialPath="/">{node}</RouterProvider>);
}

describe('a hostile review body', () => {
  const card = html(<ReviewCard review={review({ body: HOSTILE })} locale="nl" />);

  it('is one escaped text node inside the review-body paragraph, its newline intact', () => {
    expect(card).toContain(`<p class="review-body" dir="auto">${ESCAPED}</p>`);
  });

  it('creates no element from it', () => {
    expect(card).not.toContain('<b>');
    expect(card).not.toContain('</script>');
    expect(card).not.toContain('<br');
    expect(card).not.toContain('<a href="y"');
    expect(card).not.toMatch(/style=/);
    expect(card).not.toContain('<script');
    expect(card).not.toContain('dangerouslySetInnerHTML');
  });

  it('holds the same text in the list, in English too', () => {
    const list = html(
      <ReviewList first={reviewList([review({ body: HOSTILE })])} path="/api/v1/x/reviews" locale="en" />,
      'en',
    );
    expect(list).toContain(`<p class="review-body" dir="auto">${ESCAPED}</p>`);
    expect(list).not.toContain('<br');
  });

  it('keeps blank lines and long runs as they are, for the CSS to wrap', () => {
    const body = `een\n\ndrie ${'x'.repeat(200)}`;
    expect(html(<ReviewCard review={review({ body })} locale="nl" />)).toContain(
      `<p class="review-body" dir="auto">${body}</p>`,
    );
  });

  it('shows an escaped author name as text, linked only while the member is active', () => {
    const author = { handle: 'anna_b', display_name: '<i>Anna</i>', active: true, former_member: false };
    const linked = html(<ReviewCard review={review({ author })} locale="nl" />);
    expect(linked).toContain('<a href="/u/anna_b">&lt;i&gt;Anna&lt;/i&gt;</a>');
    const banned = html(<ReviewCard review={review({ author: { ...author, active: false } })} locale="nl" />);
    expect(banned).toContain('&lt;i&gt;Anna&lt;/i&gt;');
    expect(banned).not.toContain('/u/anna_b');
    const gone = html(
      <ReviewCard
        review={review({ author: { handle: null, display_name: null, active: false, former_member: true } })}
        locale="en"
      />,
      'en',
    );
    expect(gone).toContain('Former member');
    expect(gone).not.toContain('/u/');
  });
});

describe('a review card', () => {
  it('leaves the body out when there is none, and shows only the aspects that are set', () => {
    const card = html(<ReviewCard review={review({ body: null })} locale="nl" />);
    expect(card).not.toContain('review-body');
    expect(card).toContain('Collectie: ');
    expect(card).toContain('Toegankelijkheid: ');
    expect(card).not.toContain('Presentatie');
    expect(card).not.toContain('Prijs-kwaliteit');
  });

  it('gives the rating as text and hides the glyphs from assistive technology', () => {
    const card = html(<ReviewCard review={review({ rating: 4 })} locale="nl" />);
    expect(card).toContain('<span class="visually-hidden">4 van 5</span>');
    expect(card).toContain('<span aria-hidden="true">★★★★<span class="stars-off">★</span></span>');
    expect(html(<ReviewCard review={review({ rating: 4 })} locale="en" />, 'en')).toContain('4 out of 5');
  });

  it('says "Bezocht op <full date>", or only "Bezocht" without a date (N2, A§11), and when it was edited', () => {
    const dated = html(<ReviewCard review={review({ edited_at: '2026-10-05T08:00:00.000Z' })} locale="nl" />);
    expect(dated).toContain('Bezocht op 12 september 2026');
    expect(dated).toContain('Geschreven op 1 oktober 2026');
    expect(dated).toContain('bewerkt op 5 oktober 2026');
    const undated = html(<ReviewCard review={review({ visited_on: null })} locale="nl" />);
    expect(undated).toContain('Bezocht ·');
    expect(undated).not.toContain('Bezocht op');
    expect(undated).not.toContain('bewerkt');
    expect(html(<ReviewCard review={review()} locale="en" />, 'en')).toContain('Visited on 12 September 2026');
  });

  it('sits in a fold of its own museum, links to its page, and names the museum only where asked', () => {
    const card = html(<ReviewCard review={review()} locale="nl" />);
    expect(card.match(/class="fold"/g)).toHaveLength(1);
    expect(card).toContain('href="/reviews/0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"');
    expect(card).not.toContain('<h3>');
    const named = html(<ReviewCard review={review()} locale="en" showMuseum />, 'en');
    expect(named).toContain('<h3><a href="/en/museums/voorbeeld-museum">Example Museum</a></h3>');
    expect(named).toContain('href="/en/reviews/0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b"');
  });
});
