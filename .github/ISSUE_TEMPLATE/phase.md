---
name: Phase
about: One phase of docs/plan/PHASES.md §3
title: 'P<N><x>: <name>'
labels: []
---

> [docs/plan/PHASES.md §3 P<N><x>](https://github.com/mwijkhuisen/Museumjaarkaart/blob/main/docs/plan/PHASES.md) · Milestone M<n> · Depends on: <phases> · Owner actions ([PHASES §4](https://github.com/mwijkhuisen/Museumjaarkaart/blob/main/docs/plan/PHASES.md#4-owner-actions)): <A#, or none> · Branch: `claude/p<N><x>-<slug>`

## Goal
<From PHASES §3.>

## Scope
**In**
- <item>

**Out**
- <item> → <phase>

## Acceptance criteria
Each criterion carries one tag: **[CI]** (a test or check in CI), **[box]** (a command on the VM) or **[owner]** (PHASES §2).
- [ ] [CI] <criterion>

## Models and effort
| Step | Model | Effort / command | Needed? |
|---|---|---|---|
| Build | `/model claude-opus-5-5` | `/effort xhigh`, plan mode first | yes |
| Code review | `/model claude-sonnet-5-5` (a different model from the build) | `/effort <level>`, then `/code-review <level> --comment <PR#>` | required / recommended / optional (PHASES §2) |
| Security review | `/model claude-opus-5-5` (fresh session) | `/effort xhigh`, then `/security-review` | required / recommended / optional (PHASES §2) |
| GitHub chores | `/model claude-haiku-5-5` | `/effort low` | as needed |

**Build with sub-agents** (PHASES §2): the lead plans work packages on the cheapest model and effort that can do each; right after the PR, the required reviews run as fresh sub-agents and an Opus fix sub-agent takes the PR to green.

**Why:** <one line>

**Escalation only:** Fable 5.1 (`/model claude-fable-5-1`) for one more review when a fix round still leaves a High or Critical finding, or a [CI]/[box] bar is still missed after one fix round. Never by default (cost and usage limits).

## Work packages
Small packages, disjoint files, one stand-alone brief each; the ladder is in PHASES §2 (Haiku for copies, templates, checks and GitHub chores; Sonnet for well-specified code; Opus for security boundaries and fixes).

| WP | Package | Owns (files) | Model · effort | Done-check |
|---|---|---|---|---|
| 1 | <package> | <paths> | Sonnet 5.5 · medium | <test or command> |
| R | Reviews (required ones: code / security) | none | per the table above | one PR comment each, with a verdict |
| F | Fix loop | what a finding or red job touches | Opus 5.5 · high | `ci` and `security` green, no open High or Critical |

## How to run this phase
1. Make sure the dependencies are merged and the owner actions are done.
2. **Build:** a fresh session on `main` with the Build model and effort, plan mode, paste the Build prompt, approve the plan; the lead splits the work into the work packages per PHASES §2, runs them as sub-agents, reviews each diff, commits, and opens the PR (branch `claude/p<N><x>-<slug>`, conventional commits, `.github/pull_request_template.md`).
3. **Reviews:** the required code and security reviews run as fresh sub-agents straight after the PR opens, each with its model; then the Opus fix sub-agent.
4. **Fix:** the fix sub-agent addresses every High and Critical finding and every red job until CI is green.
5. **Gate:** `ci` and `security` green, every [CI] criterion ticked with evidence, no open High or Critical finding. Agents never merge; the owner merges. An **[U]** fact proven or disproven here is written back into ARCHITECTURE.md in the same PR.

## Build prompt
```text
<Context and what to read first (CLAUDE.md, PHASES §2/§3, the A§ and ADR refs), the security invariants verbatim,
the goal, scope in/out, the work packages and their models (PHASES §2), the ordered tasks, the acceptance criteria,
the verification to show, the git and PR rules, what to do when reality differs from the plan,
"start in plan mode and wait for approval".>
```

## Code-review prompt
```text
<Review from main with gh pr diff first, what to read, the phase-specific checks, the always-checks (each [CI] criterion
has a test that fails without the change, [U] facts written back, no scope creep, dependency rules, no secret or
museum.nl, OSM or Google data), "post findings as PR review comments with a severity; do not push fixes; finish with a verdict".>
```

## Security-review prompt
```text
<Never on an untrusted branch, the threats specific to this PR, the CLAUDE.md invariants verbatim, "classify findings
Critical/High/Medium/Low with file:line, exploit scenario and fix; report the threat-picture delta; do not push fixes;
the verdict passes only with no open High or Critical".>
```
