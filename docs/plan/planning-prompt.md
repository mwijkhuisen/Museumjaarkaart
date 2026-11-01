# Planning session: museum review site (Museumjaarkaart)

The request this plan was made from (2026-11-01), as F1 kept its planning prompt. The owner's words are quoted verbatim, typos included. This session was for planning only: no application code.

## Request

> Want to create a website for which museums you can visit in the Netherlands, you can create an account and rate the museum and add a review with possibilities to add photos and videos. The stack should be the same as waterheight/f1_timings.
> Ask me question to beter create the plan you are going to draft which should be created as issues/roadmap in this repo

## Follow-ups (in order)

1. > Also see if something like this also already exist, this can be a research through a sub agent
2. > Suggest some name candidates for the site
3. > Museumlog also free? But put on the short list muselog, musuemvink and then if free musuemlog
4. > Musuemlog that exist, is that for the Dutch market or general?

Answer to 4, for the record: **general, not Dutch.** museumlog.app is "Museum Log — Letterboxd, but for museums": an English-language iPhone logbook app by a London-based founder, pre-launch ("Notify me on launch"), domain registered 2026-05-04, with stamps for 130+ galleries worldwide. It is still a high conflict for the EN side of the site and for any app-store listing ([research/naming.md](research/naming.md)).

## How the session ran

1. **Reference stack.** Read F1_Timings (plan, ADRs, `CLAUDE.md`, issue and PR templates, `deploy/compose.yaml`) and Waterheight (`CLAUDE.md` gotchas and invariants; ADR-0006, 0011, 0014, 0016, 0021). Both read-only; neither repo was changed.
2. **Research by sub-agents** (summaries in [research/](research/)):
   - [museum data](research/museum-data.md): museum.nl and its terms, Wikidata SPARQL counts, RCE WFS, OSM taginfo, Museumregister, Google Places terms
   - [media](research/media.md): Cloudflare Free body cap and CDN terms, R2, sharp, ffmpeg, queue and S3-client options, abuse tooling
   - [legal](research/legal.md): GDPR, DSA, consumer-review rules, copyright and portrait rights, KvK, accessibility
   - [auth](research/auth.md): better-auth vs own code, passkeys, argon2 in `node:crypto`, bot protection under a strict CSP, EU email providers
   - [prior art](research/prior-art.md): about 70 products found; the closest checked one by one (verified report)
   - [naming](research/naming.md): candidates with domains checked by RDAP; the trademark registers could not be reached
3. **Interview.** Several rounds of questions to the owner, recommended option first, skipping what the request or the reference repos already answer: audience, languages, features, plan format, name, museum scope, media, login, moderation, deletion, hosting, profiles, ratings, revenue, email, timeline, review rules, phasing, video, extras, rendering, admin, code name, backups.
4. **Outputs:** `docs/plan/{README,ARCHITECTURE,PHASES,planning-prompt}.md`, `docs/plan/research/*.md`, `docs/adr/0001`–`0017`, `CLAUDE.md`, `README.md`, `.gitignore`. The roadmap issues (a `Roadmap` epic → one issue per milestone → the phase issues, PHASES §1) are opened after the owner approves the plan (PHASES §5 step 1). Issue and PR templates, CI, Dependabot and the licence are P0 deliverables.

## Decisions

All owner decisions of this session (D1–D24, owner, 2026-11-01), each with its reason and ADR, are in [ARCHITECTURE.md A§3](ARCHITECTURE.md#3-decisions). They are not repeated here.
