import { describe, expect, it } from 'vitest';
import { isStorable, StorableText } from '../src/index.ts';

describe('StorableText', () => {
  it('takes any well-formed text and refuses a lone surrogate or a NUL', () => {
    for (const ok of ['', 'Rijksmuseum', 'café 🎨', '\u{2028}']) expect(isStorable(ok), ok).toBe(true);
    for (const bad of ['\u{d800}', 'a\u{dfff}b', 'x\u{0}y'])
      expect(StorableText.safeParse(bad).success, bad).toBe(false);
  });
});
