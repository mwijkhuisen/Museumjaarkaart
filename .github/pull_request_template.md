<!-- Title "P<N><x>: <name>". Say "Closes #<issue>" (or "Part of #<issue>" when the phase has more PRs). -->

## Summary

## Evidence
One line per acceptance criterion of the phase issue (PHASES §2):
- [ ] [CI] <criterion> → test name or CI job
- [ ] [box] <criterion> → the command to run on the VM and its expected output
- [ ] [owner] <criterion> → what the owner does or checks

## Dependencies
One ADR-lite line per new dependency: why · licence · maintainer health · transitive count; exact pin, at least 7 days old (CLAUDE.md Workflow). Or "none".

## Checklist
- [ ] Work packages and their models listed (PHASES §2, building with sub-agents); the required reviews ran as sub-agents after the PR opened
- [ ] [U] facts proven or disproven, and written back into ARCHITECTURE.md, or "none"
- [ ] A new migration works with the previous image (expand now, contract later; A§17.5), or "no migration"
- [ ] CLAUDE.md, ARCHITECTURE.md, ADRs, runbooks and docs/legal/ updated where this PR changes them
- [ ] No secret, no personal data, no museum.nl or OpenStreetMap data, no Google data in the diff (CLAUDE.md)
- [ ] A diff under .github/, scripts/, deploy/, pnpm-workspace.yaml or .claude/ is flagged here for the owner's line-by-line read (A§16.3)
