<!--
One PR per agent-router session. This PR must address exactly one ROADMAP item and
target the `development` branch (never `main`). Fill in every section below; delete
the guidance comments before submitting.
-->

## ROADMAP item

<!-- The exact ROADMAP.md item this PR implements: number and title, e.g.
"1. Trim environment variable values". Exactly one item per PR. -->

## Spec tasks

<!-- For a spec-backed item: the tasks.md IDs from the item's linked
`.kiro/specs/<spec>/` that this PR addresses, e.g. `1.1`, `2.1`. These must match the
item's `tasks` line in ROADMAP.md. For a `BACKLOG.md § P<n>` item, cite the mini-spec
section instead (no tasks.md). -->

## Summary

<!-- What changed and why, in a few sentences. Reference the requirements.md/design.md
or the BACKLOG.md mini-spec decisions this implementation follows. -->

## Tests added

<!-- The tests added or updated and what they cover. Tier 1 tests are required;
a behavioral change to the daemon also requires a Tier 2 test. Note any browser
(Playwright) tests where the item calls for them. -->

## Tradeoffs / notes

<!-- Design tradeoffs, deferred work, known limitations, or anything a reviewer
should know. Write "None." if there are none. -->

## Checklist

- [ ] Read the linked `requirements.md` and `design.md` (or the `BACKLOG.md` mini-spec)
      before writing code.
- [ ] This PR addresses **exactly one** ROADMAP item.
- [ ] Ticked the ROADMAP.md checkbox for this item, recorded the PR number
      (`- [x] Complete · PR: #<n>`), and moved it to `## Completed`.
- [ ] Ticked the matching `tasks.md` sub-task checkboxes (spec-backed items only).
- [ ] Base branch is `development`, not `main`.
- [ ] `npm run typecheck` and `npm test` pass locally; Tier 2 added for behavioral changes.
- [ ] CI considered: pushed and waited for the posted-back CI report rather than
      polling; failures addressed before requesting merge.
- [ ] Docs the change justifies (README / BACKLOG status) are on this branch, not deferred.
