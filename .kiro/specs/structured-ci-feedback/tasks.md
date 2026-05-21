# Implementation Plan: Structured CI Feedback

## Overview

This plan implements a structured CI reporting pipeline that posts machine-readable PR comments when CI checks fail (or pass). The implementation consolidates the existing two-job CI workflow into a single job, adds a bash report builder script, and wires up comment posting with feature flag gating. Property-based tests validate the report builder's correctness properties.

## Scope Decisions (carried from design)

- **Triggers:** PR events only. Push-to-branch, scheduled, and manual dispatch do not post comments.
- **Noise policy:** Post on every CI run. Multi-push PRs generate multiple comments. Accepted cost — agent sessions are PR-bound; redundant wakes are cheap (agent reads status, takes no action if already fixing).
- **Success metric:** Fraction of agent-opened PRs that self-correct after CI failure without human intervention. Baseline: ~0%. Target: >50% within 2 weeks of launch.

## Tasks

- [x] 1. Restructure CI workflow into a single job
  - [x] 1.1 Consolidate `typecheck` and `test-tier1-tier2` jobs into one job with sequential steps
    - Verify both existing jobs pass on main before starting (run `npm run typecheck` and `npm test` locally)
    - Replace the two separate jobs in `.github/workflows/ci.yml` with a single job
    - Add `permissions: pull-requests: write` to the job
    - Steps: checkout, setup-node, npm ci, typecheck, test, report, post-comment, fallback-summary
    - Typecheck step: `tsc --noEmit 2>&1 | tee typecheck-output.txt` with `NO_COLOR=1` env and `continue-on-error: true`
    - Test step: `vitest run --project tier1 --project tier2 --reporter=default --reporter=junit --outputFile=test-results.xml` with `continue-on-error: true`
    - Assign step IDs (`id: typecheck`, `id: test`) for outcome tracking
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 2.3, 8.1, 8.2_

  - [x] 1.2 Add report generation step
    - Add step that runs `bash scripts/ci-report.sh` with `if: always()` condition
    - Pass `--junit test-results.xml --typecheck typecheck-output.txt`
    - Pass `--run-link ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}`
    - Pass `--typecheck-outcome ${{ steps.typecheck.outcome }} --test-outcome ${{ steps.test.outcome }}`
    - Pass `--output report.md`
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 8.2_

  - [x] 1.3 Add comment posting step with feature flag gating
    - Add step with `if: always() && github.event_name == 'pull_request' && vars.ENABLE_PR_COMMENTS == 'true'`
    - Command: `gh pr comment ${{ github.event.pull_request.number }} --body-file report.md`
    - Set `continue-on-error: true`
    - Set `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` env
    - Assign step ID (`id: post-comment`)
    - Add YAML comment: "Note: when feature flag is off, this step is *skipped* (not failed). Fallback-summary only triggers on failure, not skip — intentional."
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 10.1, 10.2, 10.3_

  - [x] 1.4 Add fallback-to-step-summary mechanism
    - Add step that writes `report.md` to `$GITHUB_STEP_SUMMARY` if post-comment step failed
    - Condition: `if: always() && steps.post-comment.outcome == 'failure'`
    - Note: skipped outcome (feature flag off) does NOT trigger fallback — only actual posting failures
    - _Requirements: 9.2, 9.3_

- [x] 2. Implement report builder script
  - [x] 2.1 Create `scripts/ci-report.sh` with argument parsing and overall structure
    - Create the script at `scripts/ci-report.sh` with `#!/usr/bin/env bash` and `set -euo pipefail` (with trap to ensure exit 0)
    - Parse CLI arguments: `--junit`, `--typecheck`, `--run-link`, `--typecheck-outcome`, `--test-outcome`, `--output`
    - Determine overall status from outcomes (pass if both success, fail otherwise)
    - Route to success or failure report generation
    - Write output to file (if `--output` specified) or stdout
    - Ensure script always exits 0 (trap ERR to catch unexpected failures)
    - Add `command -v xmllint >/dev/null || echo "::warning::xmllint not found, falling back to grep-based parsing"` at top
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_

  - [x] 2.2 Implement success report generation
    - When both checks pass, emit single-line report: `## CI (test): ✅ All checks passed\n\n[Full run details](<run-link>)`
    - No verbose output, no test listings
    - _Requirements: 4.1, 4.2_

  - [x] 2.3 Implement typecheck error parsing and section generation
    - Read typecheck output file (handle missing/empty gracefully)
    - Strip ANSI escape sequences with `sed 's/\x1b\[[0-9;]*m//g'`
    - Format as `## Typecheck` section with status and error content
    - Cap typecheck section at 20,000 chars with "[N more errors omitted]" notice
    - _Requirements: 2.1, 2.2, 2.3, 3.4_

  - [x] 2.4 Implement JUnit XML parsing and test failure section generation
    - Parse JUnit XML using `xmllint --xpath` to extract failed test names, file paths, error messages
    - Handle default namespace in JUnit XML: use `local-name()` in XPath queries if namespace is declared (vitest may or may not declare one)
    - Fall back to grep-based extraction if `xmllint` fails or is unavailable
    - Build markdown table of failed tests: `| Test | File | Error |`
    - Extract stack traces for each failure
    - Wrap individual traces exceeding 5,000 chars in `<details>` elements
    - Handle missing/empty/malformed XML gracefully with appropriate notices
    - _Requirements: 1.3, 3.2, 3.3, 3.5, 9.1, 9.4_

  - [x] 2.5 Implement truncation algorithm
    - Apply priority-based truncation when total report exceeds 60,000 chars
    - Priority order: (1) status header + run link, (2) test summary table, (3) typecheck errors, (4) stack traces
    - Remove stack traces from bottom up first, then truncate typecheck, then truncate test table
    - Append truncation notice with run link when truncation occurs
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [x] 2.6 Implement structured header formatting and report assembly
    - Ensure first line is always `## CI (test): ✅ All checks passed` or `## CI (test): ❌ Checks failed`
    - Run link within first 5 lines
    - All sections delimited by `## ` headers (subsections use `###` and `####`)
    - Most actionable info (test names, errors, file locations) within first 30 lines
    - _Requirements: 3.1, 3.5, 3.6_

- [x] 3. Checkpoint: validate script against real vitest output
  - Run `vitest run --project tier1 --project tier2 --reporter=junit --outputFile=test-results.xml` locally
  - Run `tsc --noEmit 2>&1 | tee typecheck-output.txt` locally (introduce a deliberate type error first)
  - Run `bash scripts/ci-report.sh --junit test-results.xml --typecheck typecheck-output.txt --run-link https://github.com/test/test/actions/runs/12345 --typecheck-outcome failure --test-outcome success --output report.md`
  - Verify: report.md starts with `## CI (test): ❌ Checks failed`, run link in first 5 lines, typecheck errors present with file/line
  - Run again with both outcomes as `success` — verify one-line success format
  - Run again with no input files — verify minimal "no parseable output" report
  - Check in a fixture: `test/fixtures/ci-report/example-failure.md` (real output from the typecheck-failure run above)

- [ ] 4. Write property-based tests for report builder
  - [x] 4.1 Create test file with fast-check generators for JUnit XML and typecheck output
    - Create `test/tier1/ci-report.test.ts`
    - Implement `arbitraryJunitXml(opts)` generator: produces valid JUnit XML with configurable failure count, test count, trace lengths
    - Implement `arbitraryTypecheckOutput(opts)` generator: produces typecheck error lines with random file paths, line numbers, error codes
    - Implement `arbitraryRunLink()` generator: produces plausible GitHub Actions run URLs
    - Implement helper to invoke `scripts/ci-report.sh` as subprocess and capture output
    - Note: subprocess-per-iteration means ~800 spawns across all properties. Acceptable (~30-60s) but mark these tests with a longer timeout if needed.
    - _Requirements: 7.1, 7.2_

  - [ ]* 4.2 Write property test: Output size invariant (Property 1)
    - **Property 1: Output size invariant**
    - For any combination of JUnit XML and typecheck output (including arbitrarily large inputs), verify output ≤ 60,000 chars
    - Generate large inputs (many failures, long traces) to stress the truncation logic
    - **Validates: Requirements 6.1**

  - [ ]* 4.3 Write property test: Status and run link placement (Property 2)
    - **Property 2: Status and run link placement**
    - For any failure report, verify first 5 lines contain both a pass/fail indicator and the run link URL
    - **Validates: Requirements 3.1**

  - [ ]* 4.4 Write property test: Failed test extraction completeness (Property 3)
    - **Property 3: Failed test extraction completeness**
    - For any valid JUnit XML with `<failure>` elements, verify every failed test's name, file path, and error message appear in the output (subject to truncation — if truncation notice present, property is satisfied)
    - **Validates: Requirements 3.2**

  - [ ]* 4.5 Write property test: Typecheck error extraction completeness (Property 4)
    - **Property 4: Typecheck error extraction completeness**
    - For any typecheck output with error lines, verify every error's file path, line number, and message appear in output (or truncation notice is present)
    - **Validates: Requirements 3.4**

  - [ ]* 4.6 Write property test: Details wrapping threshold (Property 5)
    - **Property 5: Details wrapping threshold**
    - For any individual diagnostic section, if char count > 5,000 it is wrapped in `<details>`; if ≤ 5,000 it appears inline
    - Note: property matcher should check `<details>` presence per-trace, not globally
    - **Validates: Requirements 3.3, 6.4**

  - [ ]* 4.7 Write property test: Truncation preserves priority order (Property 6)
    - **Property 6: Truncation preserves priority order**
    - For any input producing a report > 60K chars before truncation, verify truncated output preserves status header, run link, failure summary table, and contains truncation notice
    - **Validates: Requirements 6.2, 6.3**

  - [ ]* 4.8 Write property test: Exit code invariant (Property 7)
    - **Property 7: Exit code invariant**
    - For any input (missing files, malformed XML, empty files, binary garbage), verify script exits with code 0
    - **Validates: Requirements 7.5**

  - [ ]* 4.9 Write property test: Structured section headers (Property 8)
    - **Property 8: Structured section headers**
    - For any failure report, verify all top-level sections are delimited by line-anchored `^## ` headers (not `###` or `####`), and at least one `## ` header exists
    - **Validates: Requirements 3.6**

- [x] 5. Write unit tests for specific scenarios
  - [x] 5.1 Write unit tests for success and edge cases
    - Test: success report is one line with status + run link (Req 4.1, 4.2)
    - Test: missing JUnit XML produces notice in report (Req 1.3, 7.6)
    - Test: missing typecheck output produces notice (Req 9.1)
    - Test: both files missing produces minimal report with run link (Req 9.1)
    - Test: malformed XML falls back gracefully (Req 9.4)
    - Test: script accepts `--output` flag and writes to file (Req 7.4)
    - Test: script accepts file paths as arguments (Req 7.2)
    - Test: run link appears in output (Req 7.3)
    - Test: ANSI escapes in typecheck output are stripped (design: ANSI handling)
    - Test: feature flag off path — verify script still produces report (script is flag-agnostic; flag is workflow-level)
    - _Requirements: 1.3, 4.1, 4.2, 7.2, 7.3, 7.4, 9.1, 9.4_

- [x] 6. Final validation
  - [x] 6.1 Run full test suite
    - Run `npm test` — all tier1 and tier2 tests must pass
    - Run `npm run typecheck` — no type errors
    - Verify `scripts/ci-report.sh` is executable (`chmod +x`)
  - [x] 6.2 Validate CI workflow YAML
    - Verify YAML is syntactically valid (no tabs, correct indentation)
    - Verify step IDs are referenced correctly in `if:` conditions
    - Verify `permissions: pull-requests: write` is present
    - Verify trigger is `pull_request` (not `pull_request_target`)

- [ ]* 7. Post-merge manual E2E validation
  - [ ]* 7.1 Set `vars.ENABLE_PR_COMMENTS = "true"` in GitHub repo settings → Variables
  - [ ]* 7.2 Push a commit with a deliberate type error → verify structured comment appears with typecheck errors, file paths, line numbers
  - [ ]* 7.3 Push a commit with a deliberate test failure → verify comment appears with test name, file, error message, stack trace
  - [ ]* 7.4 Push a commit where everything passes → verify one-line success comment with run link
  - [ ]* 7.5 Set `vars.ENABLE_PR_COMMENTS = "false"` → push a commit → verify no comment is posted
  - [ ]* 7.6 Verify agent-router daemon logs show `issue_comment.created` classified as Tier 1 trust when comment lands

## Notes

- Tasks marked with `*` are optional for initial merge but should be completed within 1 week
- Property tests (4.2–4.9) are deferred to a follow-up PR — tracked as a backlog item after merge
- Task 5.1 (unit tests) is REQUIRED for merge — basic correctness coverage is MVP
- Task 7 (E2E validation) happens post-merge by definition but is tracked here for completeness
- The report builder is a bash script — tests invoke it as a subprocess via `child_process.execFileSync`
- Subprocess-per-iteration in property tests means ~30-60s total runtime; acceptable for tier1

