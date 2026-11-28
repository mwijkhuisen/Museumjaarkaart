// Commons' `Artist` / `Attribution` fields are HTML. We keep plain text only (invariant 5): it reaches
// React text nodes, never an HTML sink. A linear scanner, not a regex over the whole input.

const MAX_CODE_POINTS = 200;
const SKIP_CONTENT = ['script', 'style', 'template'];
// C0 and C1 controls except whitespace, and the bidi controls the review text rule refuses (U+202A-202E, U+2066-2069).
const CONTROLS = /[\p{Cc}\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu;
const ENTITY = /&(?:#([0-9]{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const NAMED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u{A0}' };

function stripTags(html: string): string {
  const lower = html.toLowerCase();
  let out = '';
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return out + html.slice(i);
    out += html.slice(i, lt);
    // `<` not followed by a tag-like start is plain text ("a < b").
    if (!/[a-zA-Z/!?]/.test(html[lt + 1] ?? '')) {
      out += '<';
      i = lt + 1;
      continue;
    }
    const gt = html.indexOf('>', lt);
    if (gt === -1) return out; // an unterminated tag: drop the rest, as a browser would swallow it
    const name = /^<([a-z]+)/.exec(lower.slice(lt, lt + 12))?.[1];
    i = gt + 1;
    if (name !== undefined && SKIP_CONTENT.includes(name)) {
      const close = lower.indexOf(`</${name}`, i);
      if (close === -1) return out;
      const closeEnd = html.indexOf('>', close);
      if (closeEnd === -1) return out;
      i = closeEnd + 1;
    }
  }
  return out;
}

function decode(text: string): string {
  return text.replace(ENTITY, (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined) return NAMED[name] ?? whole;
    const cp = dec !== undefined ? Number(dec) : Number.parseInt(hex ?? '', 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : whole;
  });
}

/** Plain text of an HTML attribution (at most 200 code points), or null when nothing is left. */
export function attributionText(html: string | null | undefined): string | null {
  if (html === null || html === undefined) return null;
  // ponytail: a longer input is cut before scanning; Commons credits are far shorter.
  const text = decode(stripTags(html.slice(0, 20_000)))
    .replace(/\s+/gu, ' ')
    .replace(CONTROLS, '')
    .replace(/\s+/gu, ' ')
    .trim();
  const cut = Array.from(text).slice(0, MAX_CODE_POINTS).join('').trim();
  return cut === '' ? null : cut;
}

/** CC BY and CC BY-SA need the author named; the other allowed licences do not. */
export function attributionRequired(licence: string): boolean {
  return licence.startsWith('cc-by');
}
