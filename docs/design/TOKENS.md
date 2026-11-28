# Proposed tokens for `apps/web/src/styles.css`

Design handoff, 2026-11-28. This block replaces the `:root` block and the dark block of `styles.css`. It is kept as Markdown so no tool treats it as source. See `HANDOFF.md`.

```css

/* The typeface: Atkinson Hyperlegible Next, OFL 1.1, self-hosted (needs the ADR named in HANDOFF.md §4).
   Vite hashes the two files; font-src 'self' is already in the CSP. */
@font-face {
  font-family: "Atkinson Hyperlegible Next";
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url("./assets/fonts/atkinson-hyperlegible-next-latin-ext-wght.woff2") format("woff2");
  unicode-range: U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329,
    U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
@font-face {
  font-family: "Atkinson Hyperlegible Next";
  font-style: normal;
  font-weight: 200 800;
  font-display: swap;
  src: url("./assets/fonts/atkinson-hyperlegible-next-latin-wght.woff2") format("woff2");
  unicode-range: U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329,
    U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}

:root {
  color-scheme: light dark;
  --color-bg: #f6f1e6; /* was #ffffff */
  --color-surface: #fffcf5; /* was #f4f4f0; now lighter than bg: cards, fields, the menu */
  --color-surface-sunken: #ece5d6; /* NEW: footer, bar tracks, image wells */
  --color-text: #1c1b19; /* was #1a1a1a */
  --color-text-muted: #5a564e; /* was #505050 */
  --color-link: #1f3f8f; /* was #0a4aa6 */
  --color-border: #d6cdbb; /* was #d2d2cc; decorative only */
  --color-border-strong: #797264; /* was #757575 */
  --color-focus: #1f3f8f; /* was #0a58ca */
  --color-accent: #1f3f8f; /* was #1d5a47: Delft blue is the one brand colour */
  --color-accent-text: #ffffff;
  --color-accent-soft: #e3e8f6; /* NEW: pressed and selected fills */
  --color-mk-participating: #1b6a45; /* was #17693a; the only green */
  --color-mk-left: #a3321f; /* was #b3261e */
  --color-mk-unknown: #5a564e; /* was #5f5f5f */
  --color-danger: #a3321f; /* was #b3261e */
  --color-star: #8f5d08; /* NEW: filled stars, score bars (were the accent) */
  --color-star-off: #797264; /* NEW: empty stars (was border-strong) */
  --color-ink-red: #a8382c; /* NEW: stamp ink, art */
  --color-ink-ochre: #8a5a0a; /* NEW: stamp ink, history */
  --color-ink-green: #23694a; /* NEW: stamp ink, natural history */
  --color-ink-teal: #0f6672; /* NEW: stamp ink, science and technology */
  --color-ink-violet: #6b3f8c; /* NEW: stamp ink, ethnology */
  /* Map markers: unchanged. Checked on 2026-11-28 against all 24 fills of style-nl.json: 3.9:1 or more. */
  --color-map-mk: #9a3d00;
  --color-map-other: #2b4c8c;
  --color-map-visited: #17693a;
  --color-map-wishlist: #7a2e8e;
  --color-map-cluster: #1f3a6e;
  --color-map-outline: #ffffff;

  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2.5rem;
  --space-7: 4rem; /* NEW */
  --radius-sm: 0.25rem; /* NEW */
  --radius: 0.5rem;
  --radius-lg: 0.75rem; /* NEW: cards, the map card */
  --radius-pill: 999px; /* NEW: the Museumkaart pill, chips */
  --shadow-overlay: 0 4px 16px rgb(28 27 25 / 0.22); /* NEW: the open menu and the map card only */
  --font-sans: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; /* was the system stack */
  --font-size-xs: 0.8125rem; /* NEW: 13 px, the smallest size */
  --font-size-sm: 0.875rem;
  --font-size-base: 1rem;
  --font-size-lg: 1.25rem;
  --font-size-xl: 1.625rem;
  --font-size-2xl: 2rem;
  --font-size-3xl: 2.5rem; /* NEW: the promise on the home page */
  --line-height: 1.6;
  --line-height-tight: 1.25;
  --max-width: 72rem;
  --measure: 70ch;
  --tap: 2.75rem;
  --header-height: 3.5rem; /* NEW: the one-row header; scroll-padding-top becomes 4.5rem */
}

@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #181714; /* was #121212 */
    --color-surface: #22201c; /* was #1e1e1e */
    --color-surface-sunken: #100f0d;
    --color-text: #ece7dc; /* was #ececec */
    --color-text-muted: #b5afa2; /* was #b4b4b4 */
    --color-link: #a9bef5; /* was #8ab4f8 */
    --color-border: #3b3832; /* was #3a3a3a */
    --color-border-strong: #8d8678; /* was #8c8c8c */
    --color-focus: #a9bef5; /* was #8ab4f8 */
    --color-accent: #a9bef5; /* was #7fd1a8 */
    --color-accent-text: #111a33; /* was #0b1f16 */
    --color-accent-soft: #262c40;
    --color-mk-participating: #72d09a; /* was #5fd08a */
    --color-mk-left: #ff9f8c; /* was #ff8a80 */
    --color-mk-unknown: #b5afa2; /* was #a6a6a6 */
    --color-danger: #ff9f8c; /* was #ff8a80 */
    --color-star: #e2b24f;
    --color-star-off: #8d8678;
    --color-ink-red: #f2a093;
    --color-ink-ochre: #e2b24f;
    --color-ink-green: #86d3a6;
    --color-ink-teal: #7fd0da;
    --color-ink-violet: #cfa9ea;
  }
}
```
