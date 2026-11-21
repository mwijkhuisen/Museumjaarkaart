// The two data blocks (A§15.1, invariant 5): `<script type="application/json" id="mjk-state">` and
// `<script type="application/ld+json">`. Their text is JSON in which every character that could end
// the element or start markup is a JSON escape: `<` and `>` (so `</script>` and `<!--` cannot
// appear), `&`, and U+2028 and U+2029 (line terminators in older JavaScript). JSON.parse reads the
// escapes back as the same characters, so the data is unchanged. Nothing else may write a <script>
// body, and none of this goes through dangerouslySetInnerHTML.

const UNSAFE = /[<>&\u{2028}\u{2029}]/gu;

/**
 * JSON for a data block's body. Throws on a value JSON cannot hold (undefined, a function). Each
 * unsafe character becomes its six-character escape: a backslash, `u` and four hex digits (all
 * five are in the Basic Multilingual Plane). Inside JSON they can only occur in strings, where the
 * escape means the same character.
 */
export function jsonForScript(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('no JSON for this value');
  return json.replace(UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
