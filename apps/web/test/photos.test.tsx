import { OwnPhoto, PublicPhoto } from '@mjk/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PhotoUploader, PolicyNote } from '../src/components/photos/PhotoUploader.tsx';
import { OwnPhotoView, Picture, photoAlt } from '../src/components/photos/Picture.tsx';
import { ReviewCard } from '../src/components/reviews/ReviewCard.tsx';
import { ConfigContext } from '../src/lib/config.ts';
import { RouterProvider } from '../src/lib/router.tsx';
import { errorHeadOf, Head } from '../src/lib/seo/head.tsx';
import { setLocale } from '../src/paraglide/runtime.js';
import { review } from './review-fixture.ts';

// P3b WP7: the photo markup. The origin comes from the config (the `mjk-media` meta), AVIF comes before WebP, the
// alt is generated when the member wrote none, and a hostile alt stays text.

const MEDIA = 'https://media.mjk.test';
const PUB = 'ab'.repeat(16);
const config = { brand: 'T', controller: 'T', contactEmail: 'a@b.nl', media: MEDIA };
const ID = '0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b';

const photo = (over: Record<string, unknown> = {}): PublicPhoto =>
  PublicPhoto.parse({
    id: ID,
    width: 1200,
    height: 800,
    alt_text: null,
    public_key: PUB,
    widths: [1200, 400],
    ...over,
  });

const html = (node: React.ReactNode) => {
  setLocale('nl', { reload: false });
  return renderToStaticMarkup(
    <ConfigContext value={config}>
      <RouterProvider initialPath="/">{node}</RouterProvider>
    </ConfigContext>,
  );
};

describe('PolicyNote', () => {
  setLocale('nl', { reload: false });
  it('warns prominently for forbidden, with a note role', () => {
    const out = renderToStaticMarkup(<PolicyNote policy="forbidden" />);
    expect(out).toContain('role="note"');
    expect(out).toContain('photo-warning');
    expect(out).toContain('niet toe');
  });
  it('gives a short note for no_flash and unknown, nothing for allowed', () => {
    expect(renderToStaticMarkup(<PolicyNote policy="no_flash" />)).toContain('flits');
    expect(renderToStaticMarkup(<PolicyNote policy="unknown" />)).toContain('weten niet');
    expect(renderToStaticMarkup(<PolicyNote policy="allowed" />)).toBe('');
  });
});

describe('PhotoUploader (server render)', () => {
  const out = html(
    <PhotoUploader museum={{ id: ID, photo_policy: 'forbidden' }} museumLabel="Museum" reviewId={undefined} />,
  );
  it('locks the file input until the three consents are ticked, and accepts the three types only', () => {
    expect(out.match(/type="checkbox"/g)).toHaveLength(3);
    expect(out).toMatch(/<input[^>]*type="file"[^>]*accept="image\/jpeg,image\/png,image\/webp"/);
    expect(out).toMatch(/<input[^>]*type="file"[^>]*disabled/);
    expect(out).toContain('Vink eerst alle drie');
  });
  it('still shows the house rule of a forbidden museum', () => {
    expect(out).toContain('photo-warning');
  });
});

describe('Picture', () => {
  const out = html(<Picture photo={photo()} alt="Zaal" />);
  it('names AVIF before WebP, from the media origin, smallest first, and the smallest WebP as the img', () => {
    expect(out.indexOf('image/avif')).toBeGreaterThan(-1);
    expect(out.indexOf('image/avif')).toBeLessThan(out.indexOf('image/webp'));
    expect(out).toContain(`srcSet="${MEDIA}/p/${PUB}/400.avif 400w, ${MEDIA}/p/${PUB}/1200.avif 1200w"`);
    expect(out).toContain(`srcSet="${MEDIA}/p/${PUB}/400.webp 400w, ${MEDIA}/p/${PUB}/1200.webp 1200w"`);
    expect(out).toContain(`src="${MEDIA}/p/${PUB}/400.webp"`);
    expect(out).toContain('width="1200"');
    expect(out).toContain('height="800"');
    expect(out).toContain('loading="lazy"');
    expect(out).toContain('decoding="async"');
    expect(out).toContain('alt="Zaal"');
    expect(out).not.toMatch(/style=/);
  });
  it('keeps a hostile alt as text', () => {
    const hostile = html(<Picture photo={photo()} alt={'"><script>x</script>'} />);
    expect(hostile).not.toContain('<script');
    expect(hostile).toContain('alt="&quot;&gt;&lt;script&gt;x&lt;/script&gt;"');
  });
});

describe('photoAlt', () => {
  setLocale('nl', { reload: false });
  it('uses the text, else generates one from the museum and the author', () => {
    expect(photoAlt({ alt_text: 'Een zaal' }, 'Museum', 'anna_b')).toBe('Een zaal');
    expect(photoAlt({ alt_text: null }, 'Museum', 'anna_b')).toBe('Foto bij Museum door anna_b');
    expect(photoAlt({ alt_text: null }, 'Museum', null)).toBe('Foto bij Museum');
  });
});

describe('photos on a review', () => {
  it('ReviewCard shows them with the generated alt', () => {
    const out = html(<ReviewCard review={review({ photos: [photo()] })} locale="nl" />);
    expect(out).toContain(`${MEDIA}/p/${PUB}/400.webp`);
    expect(out).toContain('alt="Foto bij Voorbeeldmuseum door anna_b"');
    expect(out).not.toMatch(/style=/);
  });
  it('a card without photos has no picture', () => {
    expect(html(<ReviewCard review={review()} locale="nl" />)).not.toContain('<picture');
  });
  it('the author sees a pending photo through the preview route with its label', () => {
    const own = OwnPhoto.parse({
      id: ID,
      state: 'pending_review',
      width: null,
      height: null,
      alt_text: null,
      public_key: null,
      widths: [],
    });
    const out = html(<OwnPhotoView photo={own} alt="x" />);
    expect(out).toContain(`src="/api/v1/uploads/${ID}/preview?w=400"`);
    expect(out).toContain('Wacht op controle');
    expect(out).not.toContain(MEDIA);
  });
});

describe('the media origin', () => {
  it('reaches the head as the mjk-media meta, from the domain the server knows', () => {
    setLocale('nl', { reload: false });
    const head = errorHeadOf('not_found', 'nl', {
      brand: 'T',
      domain: 'mjk.test',
      controller: 'T',
      contactEmail: 'a@b.nl',
    });
    expect(head.media).toBe(MEDIA);
    expect(renderToStaticMarkup(<Head head={head} />)).toContain(`<meta name="mjk-media" content="${MEDIA}"/>`);
  });
});
