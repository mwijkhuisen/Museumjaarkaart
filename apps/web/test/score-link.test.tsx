import { MuseumDetail } from '@mjk/contracts';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import en from '../messages/en.json' with { type: 'json' };
import nl from '../messages/nl.json' with { type: 'json' };
import { CardScore } from '../src/components/reviews/CardScore.tsx';
import { ReviewCard } from '../src/components/reviews/ReviewCard.tsx';
import { ScoreSummary } from '../src/components/reviews/ScoreSummary.tsx';
import { createQueryClient } from '../src/lib/api.ts';
import { ConfigContext } from '../src/lib/config.ts';
import { RouterProvider } from '../src/lib/router.tsx';
import type { Locale } from '../src/lib/routes.ts';
import { apiPath } from '../src/lib/routes.ts';
import { setLocale } from '../src/paraglide/runtime.js';
import { Legal } from '../src/routes/Legal.tsx';
import { MuseumReviews } from '../src/routes/MuseumReviews.tsx';
import { review, reviewList } from './review-fixture.ts';

// P3a criterion 8: every place that shows a score has the "Hoe wij reviews controleren" link beside it, and
// that page says plainly that visits are self-declared.

const ID = '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11';
const ASPECTS = {
  collection: { mean: 4.5, count: 6 },
  presentation: { mean: null, count: 2 },
  kid_friendly: { mean: null, count: 0 },
  accessibility: { mean: 3.8, count: 4 },
  facilities: { mean: null, count: 0 },
  value_for_money: { mean: null, count: 0 },
};
const rated = { id: ID, rating_count: 12, rating_mean: 4.3, aspects: ASPECTS };
const unrated = { id: ID, rating_count: 0, rating_mean: null, aspects: { ...ASPECTS } };

const html = (node: React.ReactNode, locale: Locale = 'nl') => {
  setLocale(locale, { reload: false });
  return renderToStaticMarkup(<RouterProvider initialPath="/">{node}</RouterProvider>);
};
const HREF = { nl: '/hoe-wij-reviews-controleren', en: '/en/how-we-check-reviews' } as const;

describe('the how-we-check link', () => {
  it.each(['nl', 'en'] as const)('ScoreSummary has it, outside the fold, with a score or without (%s)', (locale) => {
    const text = (locale === 'nl' ? nl : en).page_reviews;
    for (const museum of [rated, unrated]) {
      const out = html(<ScoreSummary museum={museum} locale={locale} />, locale);
      expect(out).toContain(`<a href="${HREF[locale]}" class="howcheck">${text}</a>`);
      // After the fold's closing tag: never inside the folded block.
      expect(out.indexOf('class="howcheck"')).toBeGreaterThan(out.indexOf('fold-show'));
    }
  });

  it.each(['nl', 'en'] as const)('CardScore has it as an info link named in full, outside the fold (%s)', (locale) => {
    const text = (locale === 'nl' ? nl : en).page_reviews;
    const out = html(<CardScore museum={rated} locale={locale} />, locale);
    expect(out).toContain(`href="${HREF[locale]}" class="howcheck howcheck--icon" aria-label="${text}"`);
    expect(out.indexOf('howcheck')).toBeGreaterThan(out.indexOf('fold-show'));
  });

  it('CardScore shows nothing at all for a museum without a rating', () => {
    expect(html(<CardScore museum={unrated} locale="nl" />)).toBe('');
  });

  it('ReviewCard has it', () => {
    expect(html(<ReviewCard review={review()} locale="nl" />)).toContain(`href="${HREF.nl}" class="howcheck"`);
    expect(html(<ReviewCard review={review()} locale="en" />, 'en')).toContain(`href="${HREF.en}" class="howcheck"`);
  });

  it("the museum's review list page has it (the list's summary), and each review in it has its own", () => {
    const museum = MuseumDetail.parse({
      id: ID,
      slug: 'voorbeeld-museum',
      name: 'Voorbeeldmuseum',
      name_en: null,
      place: null,
      municipality_code: null,
      municipality_name: null,
      province_code: null,
      lat: null,
      lon: null,
      categories: [],
      museumkaart_status: 'unknown',
      registered: false,
      closed_on: null,
      temp_closed: false,
      rating_count: 12,
      rating_mean: 4.3,
      description_nl: null,
      description_en: null,
      street: null,
      house_number: null,
      postcode: null,
      website: null,
      museumnl_url: null,
      mk_since: null,
      mk_until: null,
      mk_last_verified_at: null,
      admission_adult_cents: null,
      price_verified_at: null,
      photo_policy: 'unknown',
      temp_closed_until: null,
      image: null,
      mk_list: null,
      aspects: ASPECTS,
    });
    const queryClient = createQueryClient();
    queryClient.setQueryData([apiPath.museum('voorbeeld-museum')], museum);
    queryClient.setQueryData([apiPath.museumReviews('voorbeeld-museum')], reviewList([review(), review({ id: ID })]));
    setLocale('nl', { reload: false });
    const out = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <ConfigContext
          value={{ brand: 'Testmerk', controller: 'Test', contactEmail: 'a@b.nl', media: 'https://media.mjk.test' }}
        >
          <RouterProvider initialPath="/musea/voorbeeld-museum/reviews">
            <MuseumReviews route={{ page: 'museum-reviews', locale: 'nl', slug: 'voorbeeld-museum' }} />
          </RouterProvider>
        </ConfigContext>
      </QueryClientProvider>,
    );
    expect(out.match(/class="howcheck"/g)).toHaveLength(3); // the summary and the two reviews
  });
});

describe('the score summary', () => {
  it('shows the mean with a decimal comma or point, the count and each aspect (or "te weinig")', () => {
    const out = html(<ScoreSummary museum={rated} locale="nl" readSlug="voorbeeld-museum" />);
    expect(out).toContain('<strong>4,3 van 5</strong>');
    expect(out).toContain('12 beoordelingen');
    expect(out).toContain('Collectie');
    expect(out).toContain('4,5 van 5');
    expect(out).toContain('te weinig beoordelingen');
    expect(out).toContain('href="/musea/voorbeeld-museum/reviews"');
    expect(out).toContain('Lees de reviews (12)');
    const english = html(<ScoreSummary museum={rated} locale="en" readSlug="voorbeeld-museum" />, 'en');
    expect(english).toContain('<strong>4.3 out of 5</strong>');
    expect(english).toContain('href="/en/museums/voorbeeld-museum/reviews"');
    expect(english).toContain('too few ratings');
  });

  it('says there is nothing yet, with no fold and no reviews link', () => {
    const out = html(<ScoreSummary museum={unrated} locale="nl" readSlug="voorbeeld-museum" />);
    expect(out).toContain('Nog geen beoordelingen');
    expect(out).not.toContain('class="fold"');
    expect(out).not.toContain('Lees de reviews');
    expect(html(<ScoreSummary museum={{ ...rated, rating_count: 1, rating_mean: 5 }} locale="nl" />)).toContain(
      '1 beoordeling<',
    );
  });

  it('puts the scores and the reviews link in the fold, and has no inline style', () => {
    const out = html(<ScoreSummary museum={rated} locale="nl" readSlug="voorbeeld-museum" />);
    const fold = out.slice(out.indexOf('class="fold"'), out.indexOf('fold-show'));
    expect(fold).toContain('4,3 van 5');
    expect(fold).toContain('Lees de reviews (12)');
    expect(out).not.toMatch(/style=/);
  });
});

describe('the how-we-check page', () => {
  it.each(['nl', 'en'] as const)(
    'says visits are self-declared and not checked, and is marked a draft (%s)',
    (locale) => {
      const messages = locale === 'nl' ? nl : en;
      const out = html(
        <ConfigContext
          value={{ brand: 'Testmerk', controller: 'Test', contactEmail: 'a@b.nl', media: 'https://media.mjk.test' }}
        >
          <Legal route={{ page: 'legal', locale, doc: 'reviews' }} />
        </ConfigContext>,
        locale,
      );
      const plain = out.replaceAll('&quot;', '"').replaceAll('&#x27;', "'");
      expect(plain).toContain(`<h1>${messages.page_reviews}</h1>`);
      expect(plain).toContain(messages.howcheck_visits);
      expect(plain).toContain(messages.howcheck_draft);
      for (const key of ['howcheck_negative', 'howcheck_moderation', 'howcheck_staff', 'howcheck_aspects']) {
        expect(plain).toContain(messages[key as keyof typeof messages]);
      }
      expect(plain).toContain('(C × m + Σ) / (C + n)');
      expect(plain).toContain(`href="${locale === 'nl' ? '/contact' : '/en/contact'}"`);
      expect(plain).not.toMatch(/style=/);
    },
  );

  it('says it in words: "zelf opgegeven" and "self-declared"', () => {
    expect(nl.howcheck_h_visits.toLowerCase()).toContain('zelf opgegeven');
    expect(nl.howcheck_visits).toContain('wij controleren niet');
    expect(en.howcheck_h_visits.toLowerCase()).toContain('self-declared');
    expect(en.howcheck_visits).toContain('we do not check');
  });
});
