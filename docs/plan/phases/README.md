# Phase build plans and prompts

One file per phase of [PHASES.md](../PHASES.md) §3, written before the phase starts and copied into its issue. Each binds only once the owner approves it.

- **P1a** has a full build plan: design, decisions, work packages, evidence and prompts.
- **P1b–P7** hold build prompts (drafted 2026-11-01). Each file has six sections:
  - §0: what must be merged and done before the build starts
  - §1: the questions the build lead puts to the owner in plan mode
  - §2: the design points the lead's plan settles
  - §3: the proposed work packages
  - §4: the evidence per acceptance criterion
  - §5: the build, code-review and security-review prompts

  The lead drafts the design in plan mode, and the owner approves it before any code.
- **Precedence:** where a merged phase has since changed ARCHITECTURE.md, PHASES.md, CLAUDE.md or an ADR, those win over these files.
- **Gaps:** each file's §1 and §2 name the gaps and contradictions found in the plan while drafting it.

| Phase | Issue | File | Build | Reviews (PHASES §3) |
|---|---|---|---|---|
| P1a | [#12](https://github.com/mwijkhuisen/Museumjaarkaart/issues/12) | [p1a-museum-sources.md](p1a-museum-sources.md) (full plan) | Opus 5.5 `high` | code (required) |
| P1b | [#13](https://github.com/mwijkhuisen/Museumjaarkaart/issues/13) | [p1b-catalogue-api.md](p1b-catalogue-api.md) | Opus 5.5 `high` | code (required) |
| P1c | [#14](https://github.com/mwijkhuisen/Museumjaarkaart/issues/14) | [p1c-web-shell.md](p1c-web-shell.md) | Opus 5.5 `high` | code (required) |
| P1d | [#15](https://github.com/mwijkhuisen/Museumjaarkaart/issues/15) | [p1d-map.md](p1d-map.md) | Sonnet 5.5 `high` | code (recommended) |
| P1e | [#16](https://github.com/mwijkhuisen/Museumjaarkaart/issues/16) | [p1e-deploy.md](p1e-deploy.md) | Opus 5.5 `xhigh` | security (required), code (recommended) |
| P2a | [#17](https://github.com/mwijkhuisen/Museumjaarkaart/issues/17) | [p2a-accounts.md](p2a-accounts.md) | Opus 5.5 `xhigh` | code and security (required) |
| P2b | [#18](https://github.com/mwijkhuisen/Museumjaarkaart/issues/18) | [p2b-passkeys.md](p2b-passkeys.md) | Opus 5.5 `xhigh` | security (required), code (recommended) |
| P2c | [#19](https://github.com/mwijkhuisen/Museumjaarkaart/issues/19) | [p2c-passport.md](p2c-passport.md) | Opus 5.5 `high` | code (required) |
| P3a | [#20](https://github.com/mwijkhuisen/Museumjaarkaart/issues/20) | [p3a-reviews.md](p3a-reviews.md) | Opus 5.5 `high` | code (required) |
| P3b | [#21](https://github.com/mwijkhuisen/Museumjaarkaart/issues/21) | [p3b-photos.md](p3b-photos.md) | Opus 5.5 `xhigh` | code and security (required) |
| P3c | [#22](https://github.com/mwijkhuisen/Museumjaarkaart/issues/22) | [p3c-moderation.md](p3c-moderation.md) (three PRs) | Opus 5.5 `xhigh` | code and security (required) |
| P3d | [#23](https://github.com/mwijkhuisen/Museumjaarkaart/issues/23) | [p3d-privacy-terms.md](p3d-privacy-terms.md) | Opus 5.5 `xhigh` | security (required), code (recommended) |
| P4 | [#24](https://github.com/mwijkhuisen/Museumjaarkaart/issues/24) | [p4-beta.md](p4-beta.md) (operations pack) | fixes Opus 5.5 `high`, triage Haiku 5.5 `low` | per the phase each fix touches |
| P5a | [#25](https://github.com/mwijkhuisen/Museumjaarkaart/issues/25) | [p5a-launch-readiness.md](p5a-launch-readiness.md) | Opus 5.5 `high` | security (required), code (recommended) |
| P5b | [#26](https://github.com/mwijkhuisen/Museumjaarkaart/issues/26) | [p5b-launch.md](p5b-launch.md) | Sonnet 5.5 `high` | code (optional) |
| P6a | [#27](https://github.com/mwijkhuisen/Museumjaarkaart/issues/27) | [p6a-votes-comments.md](p6a-votes-comments.md) | Sonnet 5.5 `high` | code (required) |
| P6b | [#28](https://github.com/mwijkhuisen/Museumjaarkaart/issues/28) | [p6b-follows.md](p6b-follows.md) | Sonnet 5.5 `high` | code (required) |
| P6c | [#29](https://github.com/mwijkhuisen/Museumjaarkaart/issues/29) | [p6c-feed.md](p6c-feed.md) | Sonnet 5.5 `high` | code (required) |
| P7 | [#30](https://github.com/mwijkhuisen/Museumjaarkaart/issues/30) | [p7-video.md](p7-video.md) (only after A12 = go) | Opus 5.5 `xhigh` | code and security (required) |
