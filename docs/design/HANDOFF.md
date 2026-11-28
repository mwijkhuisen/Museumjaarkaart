# Design handoff: identity, design system and redesign

Design input (2026-11-28). The plan in `docs/plan/` stays binding: where this note asks for something the plan forbids, §4 names the decision that has to change first. Nothing in this folder is wired into the app yet.

- **Where the designs are:** the Muzelog design canvas (audit, brief, identity, components, 26 mock-ups, the final check) and the "Muzelog" design system in Claude. This folder holds what the build needs from them: this note, `TOKENS.md` and `assets/`.
- **How it was checked:** every mock-up and component was measured in Chromium at 390 px and 1280 px, light and dark. No text is below 4.5:1 (3:1 for large text), no tap target is under 44 px, nothing scrolls sideways. Not checked: Safari on a phone, a screen reader, keyboard focus order.
- **Sample data:** the mock-ups use real museum names with invented scores, prices, dates and reviews.

## 1. Tokens: `apps/web/src/styles.css`

`TOKENS.md` holds the proposed replacement for the `:root` block and the dark block. Every existing name keeps its name.

**Changed values**

| Token | Light: was → is | Dark: was → is |
|---|---|---|
| `--color-bg` | `#ffffff` → `#f6f1e6` | `#121212` → `#181714` |
| `--color-surface` | `#f4f4f0` → `#fffcf5` | `#1e1e1e` → `#22201c` |
| `--color-text` | `#1a1a1a` → `#1c1b19` | `#ececec` → `#ece7dc` |
| `--color-text-muted` | `#505050` → `#5a564e` | `#b4b4b4` → `#b5afa2` |
| `--color-link` | `#0a4aa6` → `#1f3f8f` | `#8ab4f8` → `#a9bef5` |
| `--color-border` | `#d2d2cc` → `#d6cdbb` | `#3a3a3a` → `#3b3832` |
| `--color-border-strong` | `#757575` → `#797264` | `#8c8c8c` → `#8d8678` |
| `--color-focus` | `#0a58ca` → `#1f3f8f` | `#8ab4f8` → `#a9bef5` |
| `--color-accent` | `#1d5a47` → `#1f3f8f` | `#7fd1a8` → `#a9bef5` |
| `--color-accent-text` | `#ffffff` (same) | `#0b1f16` → `#111a33` |
| `--color-mk-participating` | `#17693a` → `#1b6a45` | `#5fd08a` → `#72d09a` |
| `--color-mk-left`, `--color-danger` | `#b3261e` → `#a3321f` | `#ff8a80` → `#ff9f8c` |
| `--color-mk-unknown` | `#5f5f5f` → `#5a564e` | `#a6a6a6` → `#b5afa2` |
| `--font-sans` | the system stack → `"Atkinson Hyperlegible Next"`, then the system stack | |

`--color-surface` is now lighter than `--color-bg`. The header moves from `surface` to `bg`; the footer moves to the new `--color-surface-sunken`.

**New tokens**

- Colour: `--color-surface-sunken`, `--color-accent-soft`, `--color-star`, `--color-star-off`, and five stamp inks `--color-ink-red`, `-ochre`, `-green`, `-teal`, `-violet`.
- Shape and space: `--space-7`, `--radius-sm`, `--radius-lg`, `--radius-pill`, `--shadow-overlay`, `--header-height`.
- Type: `--font-size-xs` (13 px, the smallest size) and `--font-size-3xl`.

**Unchanged:** all `--color-map-*` tokens, the spacing scale, `--radius`, `--tap`, `--measure`, `--max-width`.

**Rules that follow from the tokens**

- One brand colour. Links and primary buttons share Delft blue; green means only "Museumkaart geldig". `.stars` moves from `--color-accent` to `--color-star`, `.badge--visited` and `.badge--current` stop using green.
- `scroll-padding-top` and `scroll-margin-top` go from `6rem` to `4.5rem`, with the header at `--header-height`.
- Counts and euros get `font-variant-numeric: tabular-nums`.
- The header comment of `styles.css` ("no @import, url() or fonts") changes with the font decision.
- `apps/web/test/contrast.test.ts` needs the new tokens: text tokens on `bg`, `surface` and `surface-sunken`; `star`, `star-off` and the inks at 3:1.

## 2. Components and routes

Markup stays semantic and server-rendered; no `style` attribute anywhere. Data-driven visuals are done as follows:

- Progress and score bars: `<progress>` or `<meter>`, styled in CSS.
- Part-filled stars: an SVG clip path whose `width` is an attribute.
- A stamp's turn: the `transform` attribute on its SVG group; its ink: a class per category.
- The place graphic's dot: `cx` and `cy` attributes. Lettering on a stamp's arc: an SVG `textPath`.

**Layout and shared parts**

| File | Change |
|---|---|
| `components/layout/Layout.tsx` | One-row header (56 px): logo, search button, menu button. The menu is a `<details>` panel: Musea, Kaart, Paspoort, Verlanglijst, then Inloggen or the account, then the language link. From 64rem the links sit in the bar. Footer on `surface-sunken` with three promises, the two legal lines, and a link to a new "Over" page. |
| `components/ui/icons.tsx` | Stroke 2 instead of 2.5. New icons: menu, close, locate, filter, sort, bookmark, stamp, card, building, calendar, user, flag, up, comment, photo, list, map, passport, edit, trash, plus, alert, left, down. The check icon no longer means three things: card = Museumkaart, stamp = visited, building = registered. |
| new `components/brand/Logo.tsx` | Inline SVG from `assets/logo/`. The accessible name comes from the configured brand name, never from the file (see §4, ADR-0006). |
| new `components/museum/CategoryTile.tsx`, `PlaceGraphic.tsx` | The six category drawings and the province outline with the museum's dot. The fallback whenever a museum has no photo. |
| new `components/passport/VisitStamp.tsx`, `Badge.tsx` | The visit stamp (province on the arc, date in the band, ink by category) and the scalloped badge. Both are decoration: everything they say is repeated as text. |
| `src/prefs.ts` | Also set an attribute on `<html>` from the local "signed in" hint, so CSS can collapse `.marks-filter-slot` and `.marks-legend` for visitors and switch the menu label between "Inloggen" and the account. |

**Museum list, cards, filters**

| File | Change |
|---|---|
| `components/museum/MuseumCard.tsx` | A thumbnail (photo, place graphic or category tile), the name as `h2` on list pages and `h3` under a section heading with a 44 px hit area, place with province, status, score, closure line, and the wishlist as an icon toggle. "Plaats niet bekend" when there is no place. |
| `components/museum/MuseumkaartStatus.tsx` | Only `participating` is a pill, with the card icon. `left` is a line with a cross. `unknown` is a quiet line of muted text. |
| `components/museum/MuseumFilters.tsx` | On a phone the form sits in a `<details>` behind "Filters · n"; active filters show as removable chips (links that drop one parameter). From 64rem it is a side column. |
| `components/museum/MuseumResults.tsx` | Count and a sort control on one line (`sort` is already an accepted parameter). The pager says where you are ("21–40 van 1.336") and has a previous link. |
| `routes/Search.tsx`, `routes/Province.tsx` | Both show the same filter bar as the list: search with `q` set, province with the province preset. Search fields use `GET /museums/suggest`. |
| `routes/Home.tsx` | Visitor: one line that says what the site is, the search field, "near me" and "on the map", a passport preview with the beta notice, recent reviews, provinces as a two-column list (four from 64rem). Hide the "Museumkaart geldig" shortcut while no list is published. Member: progress, last stamps, the next museum on the wishlist. |

**Museum page and reviews**

| File | Change |
|---|---|
| `routes/Museum.tsx` | Order: image or fallback, name, place, status, then the two actions, the closure notice, the description, "Praktisch" (address, adult admission from `admission_adult_cents` with its check date, category, website, map link), the score, two reviews, then the remaining facts. Leave out a description that only repeats the place. The admission price is a plain fact, never called a saving. |
| `components/museum/MuseumMarks.tsx` | "Ik ben hier geweest" logs the visit in one step. After that a panel shows the new stamp, "Geef een beoordeling", and a link to add a date or a note. The date and note form moves behind that link. |
| `components/reviews/Stars.tsx`, `CardScore.tsx`, `ScoreSummary.tsx` | Stars are SVG and always beside their number as visible text. The summary shows the mean large, then each aspect as a labelled bar with its number and count. |
| `components/reviews/ReviewForm.tsx` | The radio groups stay native but are drawn as five 48 px stars with "4 van 5" beside them. The six aspects sit in a `<details>`. A rating alone can be saved. |
| `components/reviews/ReviewCard.tsx` | Initials, name, visit month, stars with number, text, aspects as small labelled scores, and a footer row with room for votes, comments and "Meld". |

**Map**

| File | Change |
|---|---|
| `routes/MapPage.tsx` | Order on a phone: heading, filter bar, map, legend, near-me results, then the list. From 64rem the list sits beside the map. |
| `components/map/MuseumMap.tsx` | The card of a selected museum overlays the bottom edge of the map and has "Bekijk het museum" as its button and an icon button to close. The legend is always shown and draws each shape with its word, including the cluster disc. The first view fits the Netherlands. A tap within 22 px of a marker selects it. |
| `components/near-me/NearMe.tsx` | The button also sits on the map as a control. |
| `routes/Museum.tsx` → map | "Bekijk op de kaart" opens the map centred on that museum. This needs a parameter on the map route (see §4). |

**Passport, wishlist, profile**

| File | Change |
|---|---|
| `routes/Passport.tsx`, `components/passport/ProgressSummary.tsx` | Progress first: the count large, a bar, the list date, three small figures. Then provinces as a grid of bars, the last stamps, badges, the saving, the visit log, and last the import and export links. |
| `components/passport/Savings.tsx` | One net figure per year with its breakdown and the estimate note. When the net is negative: how much is left until the card has paid for itself. |
| `components/account/PassportSettings.tsx` | A new switch: show my saving on my public profile, off by default (see §4). |
| `routes/Wishlist.tsx` | Museum cards, each with "Ik ben hier geweest"; an empty state with a next step. |
| `routes/Profile.tsx` | The same progress block, badges, last stamps, reviews, visits by month. |

Badges need no new data: milestones come from `all_time`, a completed province from `list.provinces`, "all twelve provinces" from the same list.

**Sign-in, errors, legal**

| File | Change |
|---|---|
| `routes/SignIn.tsx`, `components/auth/SignInMethods.tsx` | One card: the passkey button, then one e-mail field with "Stuur een code", then a link that reveals the password field. A second card explains the beta and leads to sign-up. The recovery advice moves to the account page. After signing in, go to the passport. |
| `components/auth/SignUpForm.tsx` | Starts with the beta notice. |
| `routes/ErrorPage.tsx` | The empty-state pattern: a drawing, one sentence, and a next step (a search field on the 404, a retry on an error). |
| `routes/Legal.tsx` | Short sections and lists with a summary on top; the text itself is the owner's. A new "Over" page. |

**Copy:** new and changed strings are in the mock-ups. Two to note: "Bezochte musea toevoegen of importeren" wraps in a button at 390 px and becomes "Bezoeken toevoegen of importeren"; the wishlist button on the museum page reads "Op mijn verlanglijst".

## 3. Asset files

All in `docs/design/assets/`. Suggested places in `apps/web`:

| File | For | Suggested place |
|---|---|---|
| `logo/muzelog-logo.svg`, `-reversed`, `-mono`, `-mono-reversed` | The full logo | Inline in `Logo.tsx` |
| `logo/muzelog-symbol*.svg`, `logo/muzelog-wordmark*.svg` | Stamp and word apart | Inline where needed |
| `icons/favicon.svg`, `favicon-32.png`, `favicon-48.png` | Favicon; the simple form of the stamp | `apps/web/public/` |
| `icons/apple-touch-icon-180.png` | iOS home screen | `apps/web/public/` |
| `icons/app-icon-192.png`, `app-icon-512.png`, `app-icon-maskable-512.png` (and their SVG sources) | The PWA manifest (P5a) | `apps/web/public/` |
| `share/og-image.png` (source `og-image.svg`) | Open Graph, 1200 × 630 | `apps/web/public/`; SSR adds `og:image` |
| `fonts/atkinson-hyperlegible-next-latin-wght.woff2` (34 KB), `-latin-ext-wght.woff2` (19 KB), `OFL.txt` | The typeface, variable weight 200 to 800 | `apps/web/src/assets/fonts/`, referenced from `styles.css` |

Not in this folder, to be made in the build:

- The six category drawings and the icons, as React components (their paths are on the canvas boards "Imagery" and "Foundations").
- The province outlines for the place graphic. The designs used an npm package under CC BY 4.0 that must not ship. Use the administrative boundaries from PDOK, simplified to a few hundred points per province; confirm its licence and add the attribution it asks for.

The logo files carry the brand name as outlines and as `aria-label` and `<title>`. `test/brand-names.test.ts` will fail on those two under `apps/`: strip them in the component and take the label from the configured brand name.

## 4. Plan decisions that have to change

| Where | Today | Needed |
|---|---|---|
| A§15.5, `styles.css` header | "No font or icon files: the system font stack" | A self-hosted typeface, 53 KB in two woff2 files, `font-display: swap`. Needs an ADR. The CSP already has `font-src 'self'`; `build.test.ts` and the e2e guard must accept the two font requests. |
| ADR-0006, A§1 | The brand is read from `MJK_BRAND_NAME`; the trademark check (A1) is still open | A logo fixes the name in a drawing. Finish A1 before the logo ships, and record that the logo assets are the one place the name is not configurable. |
| A§15.2 | The route table and the kept query parameters | A new page `/over` · `/en/about`. A parameter on the map route that centres on one museum (for example `museum=<slug>` in `KEPT.map`). `/zoeken` keeps its URL and gains the list's filters. |
| A§15.3 | Map card, legend and first view | The card overlays the map with a primary button; the legend is always visible and includes the cluster; the first view fits the Netherlands; a 22 px hit tolerance. Marker shapes and colours stay. |
| A§10, `docs/legal/` | The saving is private | A member setting to show the net saving on the public profile, off by default. It touches the profile contract, `pub_profile` and the privacy text. |
| A§10 (new) | No badges | Badges are derived from progress and never stored. Decide the set: 10, 25, 50, 100 museums, each completed province, all twelve provinces. No streaks. |
| A§14, museum list | The default order follows the rank; with no ratings it is alphabetical with punctuation and digits first | A default order that works before there are ratings (for example registered museums first, names sorted without a leading "'t"), and a visible sort control. |
| A§14 (new) | No endpoint for recent reviews | The home page shows recent reviews, as A§15.2 already says. It needs a public read. |
| A§7 | Sources are Wikidata and RCE | The province outlines are a new source (PDOK); add a line for it and its licence. |
| A§15.4 (P5a) | Icons to be made | The icon files are ready in `assets/icons/`. |
| PHASES | No phase for this | A phase for the redesign before the invite beta (P4), so the first members meet the new design. |

## 5. Suggested order

1. The ADR for the typeface, then the tokens and the header and footer. This alone fixes the 176 px header.
2. Museum card, status, filters and pager.
3. Museum page with the one-step visit and the review flow.
4. Passport with stamps and badges, then the profile.
5. Map card, legend and first view.
6. Home, sign-in, empty and error states.
