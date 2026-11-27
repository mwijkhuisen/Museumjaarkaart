import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import nl from '../messages/nl.json' with { type: 'json' };
import { RatingFold } from '../src/components/reviews/RatingFold.tsx';
import { clearHint, syncFold } from '../src/lib/member.ts';

// P3a WP5: the server render of the fold is the same for everyone: never `data-open`, no `style=`.
// Whether the block is hidden is CSS's call (html[data-hide-ratings]); the open state is client only.

const ID = '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11';

describe('RatingFold (server render)', () => {
  it('stacks the body and the button, closed, with a focusable body', () => {
    const html = renderToStaticMarkup(
      <RatingFold museumId={ID}>
        <p>4,3</p>
      </RatingFold>,
    );
    expect(html).toBe(
      `<div class="fold"><div class="fold-body" tabindex="-1"><p>4,3</p></div><button type="button" class="fold-show">${nl.fold_show}</button></div>`,
    );
    expect(html).not.toContain('data-open');
    expect(html).not.toMatch(/style=/);
  });

  it('names the compact button in full and shows the short label', () => {
    const html = renderToStaticMarkup(
      <RatingFold museumId={ID} compact>
        <p>4,3</p>
      </RatingFold>,
    );
    expect(html).toContain(`aria-label="${nl.fold_show}"`);
    expect(html).toContain(`>${nl.fold_show_short}</button>`);
    expect(html).not.toContain('data-open');
    expect(html).not.toMatch(/style=/);
  });
});

describe('syncFold', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('writes or removes the key and the attribute, and clearHint clears both', () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    const attrs = new Set<string>();
    vi.stubGlobal('document', {
      documentElement: { toggleAttribute: (a: string, on: boolean) => void (on ? attrs.add(a) : attrs.delete(a)) },
    });
    syncFold(true);
    expect(data.get('mjk-hide-ratings')).toBe('1');
    expect(attrs.has('data-hide-ratings')).toBe(true);
    syncFold(false);
    expect(data.has('mjk-hide-ratings')).toBe(false);
    expect(attrs.has('data-hide-ratings')).toBe(false);
    syncFold(true);
    clearHint();
    expect(data.has('mjk-hide-ratings')).toBe(false);
    expect(attrs.has('data-hide-ratings')).toBe(false);
  });

  it('throws nothing when storage is blocked or there is no document', () => {
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
    expect(() => syncFold(true)).not.toThrow();
    expect(() => clearHint()).not.toThrow();
  });
});
