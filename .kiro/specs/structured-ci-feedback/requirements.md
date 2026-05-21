# Requirements Document

## Introduction

Structured CI Feedback adds GitHub Actions workflow steps and a reporting script to the agent-router repository so that CI posts structured pass/fail summaries as PR comments. The agent-router daemon already routes `github-actions[bot]` comments as Tier 1 trust, so the receiving side of the closed loop works. This feature completes the sending side: when the agent opens a PR on agent-router itself, CI emits a structured comment the agent can parse and act on without fetching external context.

## Current CI Surface

The repository has two workflows today:

- **`.github/workflows/ci.yml`** — Triggered on push (all branches) and pull_request (main). Runs two separate jobs: `typecheck` (`tsc --noEmit`) and `test-tier1-tier2` (`npm test` = vitest tier1 + tier2). Neither job captures structured output or posts comments.
- **`.github/workflows/tier3-nightly.yml`** — Scheduled nightly + manual dispatch. Runs Tier 3 integration tests against real GitHub/Kiro. Requires secrets from a protected environment. Not triggered on PRs.

**MVP scope**: This feature targets `ci.yml` only (typecheck + tier1/tier2 tests on PRs). Tier 3 nightly is out of scope — it doesn't run on PRs and has different reporting needs.

## Success Metric

**Primary metric**: Fraction of agent-opened PRs on agent-router that reach merge without human intervention on CI failures. Baseline today is ~0% (agent cannot read CI output). Target: agent can self-correct on at least the first CI failure cycle without human help.

**Tracking**: Compare agent PR iteration count (pushes per PR) and human-intervention rate before vs after this feature ships.

## Glossary

- **CI_Workflow**: The GitHub Actions workflow (`.github/workflows/ci.yml`) that runs typecheck and tests on pull requests.
- **Report_Builder**: A bash script (`scripts/ci-report.sh`) that takes JUnit XML and typecheck output as inputs and produces a structured markdown report.
- **PR_Comment**: A GitHub pull request comment posted by `github-actions[bot]` via `gh pr comment`.
- **JUnit_XML**: The XML test results file emitted by vitest with `--reporter=junit`.
- **Run_Link**: A URL pointing to the specific GitHub Actions workflow run (constructed from `$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID`).
- **Structured_Report**: The markdown document produced by the Report_Builder, formatted with machine-parseable headers and sections for agent consumption.
- **Feature_Flag**: A GitHub Actions variable (`vars.ENABLE_PR_COMMENTS`) that gates comment posting.

## MVP Scope

**In scope (this spec)**:
- PR-triggered CI only (pull_request events on ci.yml)
- Typecheck output + Tier 1/Tier 2 test results (JUnit XML)
- Single structured comment per workflow run
- New comment per run (not edit-last)
- Feature flag to disable comment posting
- Truncation to 60K chars

**Out of scope (vNext)**:
- Tier 3 nightly reporting
- Edit-last / comment deduplication
- Performance test results
- Push-to-branch reporting (non-PR)
- Lint output (no linter configured today)
- `comment.edited` routing in agent-router

## Requirements

### Requirement 1: JUnit XML Test Output

**User Story:** As a CI pipeline, I want vitest to emit JUnit XML results, so that downstream steps can parse individual test outcomes.

#### Acceptance Criteria

1. WHEN the CI_Workflow runs tests on a pull request, THE CI_Workflow SHALL execute vitest with `--reporter=junit --outputFile=test-results.xml` in addition to the default reporter.
2. WHEN vitest completes (pass or fail), THE CI_Workflow SHALL preserve the `test-results.xml` file for subsequent workflow steps.
3. IF vitest crashes or fails to produce XML output, THEN THE CI_Workflow SHALL proceed to the reporting step; the Report_Builder handles missing input gracefully.

### Requirement 2: Typecheck Output Capture

**User Story:** As a CI pipeline, I want to capture typecheck output in a structured format, so that type errors can be included in the PR comment.

#### Acceptance Criteria

1. WHEN the CI_Workflow runs `tsc --noEmit` on a pull request, THE CI_Workflow SHALL capture stdout and stderr to a file (`typecheck-output.txt`).
2. WHEN typecheck succeeds with no errors, THE CI_Workflow SHALL produce an empty or zero-length output file.
3. WHEN typecheck fails, THE CI_Workflow SHALL capture the full error output including file paths and line numbers.

### Requirement 3: Report Generation on Failure

**User Story:** As an agent reading CI feedback, I want a structured markdown report with failure diagnostics near the top, so that I can identify what failed without fetching external context.

#### Acceptance Criteria

1. WHEN any CI check fails (tests or typecheck), THE Report_Builder SHALL produce a Structured_Report containing a pass/fail status line and the Run_Link within the first 5 lines.
2. WHEN tests fail, THE Report_Builder SHALL include a test results summary section listing failed test names, file paths, and error messages parsed from JUnit_XML.
3. WHEN tests fail, THE Report_Builder SHALL include failure stack traces inline (not hidden in collapsed sections) unless they exceed the per-section size budget.
4. WHEN typecheck fails, THE Report_Builder SHALL include type errors with file path, line number, and error message.
5. THE Report_Builder SHALL place the most actionable failure information (test names, error messages, file locations) within the first 30 lines of the report.
6. THE Report_Builder SHALL use structured markdown headers (`## Section`) to delimit report sections for machine parsing.

### Requirement 4: Report Generation on Success

**User Story:** As an agent reading CI feedback, I want a brief confirmation on success so that I know CI passed without wading through noise.

#### Acceptance Criteria

1. WHEN all CI checks pass, THE Report_Builder SHALL produce a one-line report containing the pass status and the Run_Link.
2. WHEN all CI checks pass, THE Report_Builder SHALL NOT include verbose test output or full success listings.

### Requirement 5: Comment Posting

**User Story:** As a CI pipeline, I want to post the structured report as a PR comment, so that the agent receives it via the existing webhook routing.

#### Acceptance Criteria

1. WHEN the CI_Workflow is triggered by a pull_request event AND the Feature_Flag is enabled, THE CI_Workflow SHALL post the Structured_Report as a comment on the triggering PR using `gh pr comment`.
2. WHEN the CI_Workflow is triggered by a push event (not a PR), THE CI_Workflow SHALL NOT attempt to post a comment.
3. WHEN the Feature_Flag (`vars.ENABLE_PR_COMMENTS`) is not set or set to a falsy value, THE CI_Workflow SHALL skip comment posting.
4. THE CI_Workflow SHALL have `permissions: pull-requests: write` configured to authorize comment posting.
5. WHEN posting the comment, THE CI_Workflow SHALL post a new comment (not edit a previous one) so that each run produces a `comment.created` webhook event that agent-router routes as Tier 1.

#### Rationale for new-comment-per-run

agent-router routes `issue_comment.created` events. Editing a previous comment fires `issue_comment.edited`, which agent-router does not currently route. New comment per run is the only option compatible with existing routing.

### Requirement 6: Comment Size Management

**User Story:** As a CI pipeline, I want to ensure the comment stays within GitHub's size limits, so that posting never fails due to payload size.

#### Acceptance Criteria

1. THE Report_Builder SHALL truncate the Structured_Report to a maximum of 60,000 characters.
2. WHEN truncation occurs, THE Report_Builder SHALL append a notice indicating truncation occurred and directing the reader to the full run artifacts via the Run_Link.
3. THE Report_Builder SHALL apply truncation in priority order: (1) preserve status header and Run_Link, (2) preserve failure summary with test names and file locations, (3) include top-N stack traces up to budget, (4) truncate remaining verbose content first.
4. WHEN individual diagnostic sections (stack traces, type errors) exceed 5,000 characters each, THE Report_Builder SHALL wrap them in collapsible `<details>` elements to keep the comment scannable while preserving the content.

### Requirement 7: Report Builder Reusability

**User Story:** As a maintainer, I want the report-building logic in a standalone script, so that it can be reused across workflows (e.g., tier3-nightly).

#### Acceptance Criteria

1. THE Report_Builder SHALL be a standalone bash script located at `scripts/ci-report.sh`.
2. THE Report_Builder SHALL accept input file paths as arguments (JUnit XML path, typecheck output path) rather than hardcoding paths.
3. THE Report_Builder SHALL accept the Run_Link as an argument or environment variable.
4. THE Report_Builder SHALL write the final markdown report to stdout or a specified output file.
5. THE Report_Builder SHALL exit with code 0 regardless of whether the CI checks passed or failed (report generation itself must not fail the workflow).
6. IF an expected input file is missing, THEN THE Report_Builder SHALL note the missing input in the report rather than failing.

### Requirement 8: Workflow Structure

**User Story:** As a maintainer, I want the CI workflow to run all checks before reporting, so that a single comment captures the full picture.

#### Acceptance Criteria

1. THE CI_Workflow SHALL run typecheck and tests as steps that both execute regardless of individual step failures (using `continue-on-error` or `if: always()` patterns).
2. THE CI_Workflow SHALL run the report generation and comment posting steps after both typecheck and test steps complete.
3. THE CI_Workflow SHALL post a single comment per workflow run covering all check results, not one comment per check.
4. WHEN the workflow is re-run on the same PR (e.g., after a force-push), THE CI_Workflow SHALL post a new comment for the new run.

### Requirement 9: Failure Modes and Resilience

**User Story:** As a maintainer, I want CI to degrade gracefully when reporting fails, so that a broken report never blocks the development workflow.

#### Acceptance Criteria

1. IF the Report_Builder receives no input files (neither JUnit XML nor typecheck output exists), THEN it SHALL produce a minimal report stating "CI ran but produced no parseable output" with the Run_Link.
2. IF `gh pr comment` fails (permissions error, rate limit, GitHub outage), THEN THE CI_Workflow SHALL NOT fail the overall workflow run — the comment posting step SHALL be non-blocking.
3. IF comment posting fails, THE CI_Workflow SHALL write the report to the workflow run's step summary (`$GITHUB_STEP_SUMMARY`) as a fallback so the report is still accessible via the Run_Link.
4. IF JUnit XML is malformed or unparseable, THE Report_Builder SHALL include a notice about the parse failure and fall back to reporting raw test exit code only.

### Requirement 10: Feature Flag and Disable Mechanism

**User Story:** As a maintainer, I want to disable PR comments instantly without modifying workflow files, so that noisy or broken comments can be stopped immediately.

#### Acceptance Criteria

1. THE CI_Workflow SHALL check the GitHub Actions variable `vars.ENABLE_PR_COMMENTS` before posting.
2. WHEN `vars.ENABLE_PR_COMMENTS` is unset, empty, or `"false"`, THE CI_Workflow SHALL skip comment posting entirely.
3. WHEN `vars.ENABLE_PR_COMMENTS` is `"true"`, THE CI_Workflow SHALL proceed with comment posting.
4. THE Feature_Flag SHALL be settable via GitHub repository settings without requiring a code change or deployment.

