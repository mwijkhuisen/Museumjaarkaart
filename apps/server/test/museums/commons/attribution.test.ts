import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { attributionRequired, attributionText } from '../../../src/museums/commons/attribution.ts';
import { FIXTURE_DIR } from '../sources/golden.ts';

const BAD = /[\p{Cc}\u{2028}\u{2029}\u{202A}-\u{202E}\u{2066}-\u{2069}]/u;

describe('attributionText', () => {
  it('reduces a normal Commons credit to text', () => {
    expect(
      attributionText(
        '<a href="//commons.wikimedia.org/wiki/User:X" title="User:X">Jan de  Vries</a> &amp; <span>Piet</span>',
      ),
    ).toBe('Jan de Vries & Piet');
  });

  it.each([
    null,
    undefined,
    '',
    '  ',
    '<b></b>',
    '<script>alert(1)</script>',
    '<style>a{}</style>',
    '<template>x</template>',
  ])('%j is null', (html) => {
    expect(attributionText(html)).toBeNull();
  });

  it('drops script, style and template with their content, any case', () => {
    expect(
      attributionText('a<SCRIPT type="x">alert(1)</Script >b<style>x{}</style>c<template><b>t</b></template>d'),
    ).toBe('abcd');
  });

  it('drops a javascript: link but keeps its text', () => {
    expect(attributionText('<a href="javascript:alert(1)" onclick="x()">x</a>')).toBe('x');
  });

  it('survives broken and nested tags', () => {
    expect(attributionText('</script>after')).toBe('after');
    expect(attributionText('<b><i>bold</b> text</i>')).toBe('bold text');
    expect(attributionText('x <script>never closed')).toBe('x');
    expect(attributionText('x <b never closed')).toBe('x');
    expect(attributionText('a < b and 3 <4')).toBe('a < b and 3 <4');
    expect(attributionText('<<b>>x')).toBe('<>x');
  });

  it('decodes entities once: an escaped tag stays literal text', () => {
    expect(attributionText('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('<script>alert(1)</script>');
    expect(attributionText('&amp;lt;')).toBe('&lt;');
    expect(attributionText('a&nbsp;b &#65;&#x42; &quot;q&quot; &apos;s&apos; &copy; &unknown;')).toBe(
      `a b AB "q" 's' &copy; &unknown;`,
    );
  });

  it('leaves an invalid numeric reference as written and drops decoded controls', () => {
    expect(attributionText('&#0; &#xD800; &#1114112; x')).toBe('&#0; &#xD800; &#1114112; x');
    expect(attributionText('a&#1;b&#x202E;c&#x85;d')).toBe('abcd');
  });

  it('removes controls and bidi characters, and collapses whitespace', () => {
    const text = attributionText(`\u{202E}ev\u{2066}il\u{1}\u{0}\n\t  x\u{2028}y\u{7F}`);
    expect(text).toBe('evil x y');
    expect(text).not.toMatch(BAD);
  });

  it('cuts at 200 code points on a code-point boundary', () => {
    const text = attributionText('😀'.repeat(300));
    expect(Array.from(text ?? '')).toHaveLength(200);
    expect(text).not.toMatch(/[\u{D800}-\u{DFFF}]/u);
    expect(attributionText(`${'a'.repeat(199)} b`)).toBe('a'.repeat(199));
  });

  it('handles 10,000 characters, and hostile long runs, in linear time', () => {
    const start = performance.now();
    expect(attributionText('x'.repeat(10_000))).toHaveLength(200);
    for (const html of [
      '<'.repeat(100_000),
      '<a '.repeat(30_000),
      '<script>'.repeat(30_000),
      '&'.repeat(100_000),
      '<b>'.repeat(30_000),
    ]) {
      attributionText(html);
    }
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('reduces the synthetic hostile Artist to safe text', () => {
    const json = JSON.parse(readFileSync(`${FIXTURE_DIR}commons/synthetic.json`, 'utf8')) as {
      query: { pages: { title: string; imageinfo?: { extmetadata: { Artist?: { value: string } } }[] }[] };
    };
    const html = json.query.pages.find((p) => p.title === 'File:Hostile.jpg')?.imageinfo?.[0]?.extmetadata.Artist
      ?.value;
    const text = attributionText(html);
    expect(text).toBe('Jan & Piet <script>x</script> evil bold');
    expect(text).not.toMatch(BAD);
  });
});

describe('attributionRequired', () => {
  it.each([
    ['cc-by-4.0', true],
    ['cc-by-sa-3.0-nl', true],
    ['cc0', false],
    ['pd', false],
  ])('%s: %s', (code, required) => {
    expect(attributionRequired(code)).toBe(required);
  });
});
