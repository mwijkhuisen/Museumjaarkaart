import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkSlot, VisitForm } from '../src/components/museum/MuseumMarks.tsx';
import { clearHint, hasHint, loadMarks, setHint, setWishlisted, useMarks } from '../src/lib/member.ts';

// The member hint and the marks store (A§15.1). `localStorage` is a stub (Vitest turns Web Storage
// off) and `fetch` a spy, so a request that must not happen is a failed assertion.

const A = '7b0d0c3e-5b2e-4f3a-8a53-0c2d5f9d1a11';
const B = '8c1e1d4f-6c3f-4a4b-9b64-1d3e6a0e2b22';

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  });
  return data;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A throwaway component reads the store through the hook, as the server render does.
let read: ReturnType<typeof useMarks>;
function Probe() {
  read = useMarks();
  return null;
}
const render = () => {
  renderToStaticMarkup(<Probe />);
  return read;
};

beforeEach(() => {
  clearHint(); // resets the module's marks and its one-load promise
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the hint', () => {
  it('is one localStorage key, set for a member and removed on sign-out', () => {
    const data = stubStorage();
    expect(hasHint()).toBe(false);
    setHint();
    expect(hasHint()).toBe(true);
    expect([...data.entries()]).toEqual([['mjk-member', '1']]);
    clearHint();
    expect(hasHint()).toBe(false);
    expect(data.size).toBe(0);
  });

  it('survives a storage that throws on every access (a private window) and with no storage at all', () => {
    const boom = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom, removeItem: boom });
    expect(() => setHint()).not.toThrow();
    expect(() => clearHint()).not.toThrow();
    expect(hasHint()).toBe(false);
    vi.unstubAllGlobals();
    expect(hasHint()).toBe(false);
    expect(() => setHint()).not.toThrow();
  });
});

describe('loadMarks and useMarks', () => {
  it('makes no request without the hint', async () => {
    stubStorage();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await loadMarks();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(render()).toBeUndefined();
  });

  it('asks once for the marks with the hint, however many components ask', async () => {
    stubStorage({ 'mjk-member': '1' });
    const fetchSpy = vi.fn(async () => json({ marks: { visited: [A], wishlist: [B] } }));
    vi.stubGlobal('fetch', fetchSpy);
    await Promise.all([loadMarks(), loadMarks()]);
    await loadMarks();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]).toEqual(['/api/v1/me/marks', { headers: { accept: 'application/json' } }]);
    // A server render and the first client render never see them (getServerSnapshot).
    expect(render()).toBeUndefined();
  });

  it('clears the hint on { marks: null } and on 401', async () => {
    const data = stubStorage({ 'mjk-member': '1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ marks: null })),
    );
    await loadMarks();
    expect(data.size).toBe(0);

    data.set('mjk-member', '1');
    clearHint();
    data.set('mjk-member', '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'unauthorized' }, 401)),
    );
    await loadMarks();
    expect(data.size).toBe(0);
  });

  it('keeps the hint on another failure and on an answer that breaks the contract', async () => {
    const data = stubStorage({ 'mjk-member': '1' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: 'internal' }, 500)),
    );
    await loadMarks();
    expect(data.size).toBe(1);

    clearHint();
    data.set('mjk-member', '1');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ marks: { visited: ['nope'], wishlist: [] } })),
    );
    await loadMarks();
    expect(data.size).toBe(1);
  });
});

describe('the wishlist button', () => {
  it('PUTs and DELETEs the entry, and a failed call throws', async () => {
    stubStorage({ 'mjk-member': '1' });
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url === '/api/v1/me/marks') return json({ marks: { visited: [], wishlist: [] } });
        return init?.method === 'PUT' && url.endsWith(B)
          ? json({ error: 'internal' }, 500)
          : new Response(null, { status: 204 });
      }),
    );
    await loadMarks();
    await setWishlisted(A, true);
    await setWishlisted(A, false);
    await expect(setWishlisted(B, true)).rejects.toThrow();
    expect(calls).toEqual([
      'GET /api/v1/me/marks',
      `PUT /api/v1/me/wishlist/${A}`,
      `DELETE /api/v1/me/wishlist/${A}`,
      `PUT /api/v1/me/wishlist/${B}`,
    ]);
  });
});

describe('the markup is the same for everyone', () => {
  it('renders an empty slot and no form until the marks are there', () => {
    stubStorage({ 'mjk-member': '1' });
    expect(renderToStaticMarkup(<MarkSlot museumId={A} name="Een museum" />)).toBe('<div class="marks-slot"></div>');
    expect(renderToStaticMarkup(<VisitForm museumId={A} />)).toBe('');
  });
});
