# Agent-Router Prompt — `gspivey/agent-router`

> The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD",
> "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be
> interpreted as described in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

This is the session-driver prompt for the [agent-router](https://github.com/gspivey/agent-router)
daemon **running against its own repository** — agent-router building agent-router. It tells
the agent how to advance the [`ROADMAP.md`](../ROADMAP.md) work queue by exactly one item per
session: branch, implement, test, open one PR, react to CI posted back as PR comments and
`check_run` events, then squash-merge to `development`.

Repo: `https://github.com/gspivey/agent-router`

---

## 1. Setup

The agent MUST create a persistent working directory **outside of `/tmp`** so the clone and
build artifacts survive across CI cycles within the session:

```bash
mkdir -p "$HOME/agent-runs"
WORKDIR="$HOME/agent-runs/$(date +%Y%m%d-%H%M%S)-agent-router"
mkdir -p "$WORKDIR" && cd "$WORKDIR"
git clone https://github.com/gspivey/agent-router.git
cd agent-router
git checkout development
npm install
```

The agent MUST read [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md) in the
repository root **before writing any code**. These define the project's conventions, the
branch model, the post-back CI contract, the three error classes, the dependency-injection
and atomic-write rules, and the three-tier test layout the agent must respect.

---

## 2. Roadmap Selection

The agent MUST select the **first** entry in `ROADMAP.md` whose completion checkbox is
unchecked (`- [ ] Complete`). The agent MUST implement exactly that one item and open exactly
one PR in this session. The agent MUST NOT begin a second item.

Each ROADMAP item carries a `Spec:` line. There are two forms and the agent MUST read the
referenced material before writing any code:

- **`Spec: .kiro/specs/<feature>/ · tasks N.N, …`** — read **all** of that spec's
  `requirements.md`, `design.md`, and `tasks.md`, and implement only the cited sub-tasks.
- **`Spec: BACKLOG.md § P<n>`** — read that mini-spec section of `BACKLOG.md` in full; it is
  the complete contract for the item. There is no `tasks.md` for these.

---

## 3. Implementation

1. The agent MUST create a feature branch off the latest `development`:
   `git checkout -b agent/<short-slug>`. The slug MUST be short and descriptive of the item.
2. Tests are REQUIRED. The agent MUST add tests that exercise the acceptance criteria from the
   spec/mini-spec. Per `AGENTS.md`: pure logic gets **Tier 1** tests (`test/tier1/`, including
   `fast-check` property tests where appropriate); any behavioral change to the daemon
   additionally REQUIRES a **Tier 2** test (`test/tier2/`) against the fake backends. The agent
   SHOULD commit tests before implementation code.
3. The agent MUST run the project's checks locally and MUST fix every failure before
   proceeding:

   ```bash
   npm run typecheck   # tsc --noEmit — strict, no `any`, no stray `as`
   npm test            # vitest: Tier 1 + Tier 2
   ```

   For an item that touches the web UI (`src/web-ui.ts`) or the browser test harness, the agent
   MUST also run `npm run test:browser` once that script exists. The agent MUST NOT push code
   that fails `typecheck` or `npm test`.
4. Once local checks pass the agent MUST push the branch:
   `git push -u origin agent/<short-slug>`. This first push precedes opening the PR; subsequent
   pushes within the iteration loop use `git push`.
5. The agent MUST open exactly one PR via `gh pr create` targeting `development`. The PR title
   MUST match the selected ROADMAP item name. The agent MUST fill out every section of
   `.github/PULL_REQUEST_TEMPLATE.md` (ROADMAP item, spec tasks, summary, tests added,
   tradeoffs) rather than leave placeholders.
6. Immediately after the PR is created the agent MUST call the agent-router MCP `register_pr`
   tool with the new PR number. This binds the session to the PR so every subsequent CI event
   routes back to this same conversation. The agent MUST NOT push additional commits until
   registration is confirmed.

---

## 4. CI Iteration

After any `git push` to a PR-bound branch — that is, once the PR is open and registered per
3.5–3.6 — the agent MUST **stop and wait**.

The agent MUST NOT poll for CI results. It MUST NOT run `gh run view`, `gh run watch`,
`gh run list`, or any equivalent in a loop, and MUST NOT sleep-and-recheck.

CI runs in GitHub Actions (`.github/workflows/ci.yml`: `npm run typecheck` + `npm test`) and
**posts results back** to the PR — as a comment from `github-actions[bot]` (a Tier-1 author)
and as a `check_run` completion event. Agent-router delivers either as an event that wakes this
session. When a result arrives the agent MUST act on it:

- If the checks failed, the agent MUST read the posted report comment (or the `check_run`
  output), fix the cause, commit, and push — then stop and wait again.
- If the checks are green, the agent MUST proceed to the next step.

The agent MUST react only to delivered events. It MUST NOT assume an outcome it has not been
told about.

---

## 5. Extended Tests (OPTIONAL)

This repository has a **Tier 3** suite (`test/tier3/`, `npm run test:integration`) that drives
real GitHub and real Kiro. It consumes API quota and requires real secrets, so per `AGENTS.md`
it MUST NOT run on every change and the agent MUST NOT run it locally as part of an ordinary
item. Unless the selected ROADMAP item explicitly calls for Tier 3 coverage, the agent MUST
skip this section and rely on the Tier 1 + Tier 2 results posted back per §4.

The browser-test-harness items (14–18) introduce `npm run test:browser` (Playwright/Chromium);
for those items the agent runs that suite **locally** as part of §3.3 verification — it is not
a posted-back CI gate.

---

## 6. Finalize

Once standard CI is green, the agent MUST commit the following to the feature branch **before**
requesting merge:

1. An update to `ROADMAP.md`: change the selected item's completion line from
   `- [ ] Complete · PR: —` to `- [x] Complete · PR: #<number>`, using the PR number from §3.6,
   and move the item from `## Active Roadmap` into `## Completed`.
2. For a spec-backed item only, an update to the cited `tasks.md`: tick the sub-task checkboxes
   listed on the item's `tasks` line (e.g. `1.1`, `2.1`) from `- [ ]` to `- [x]`.
3. Any documentation the change justifies (README, mini-spec status in `BACKLOG.md`) — per the
   `AGENTS.md` rule that **docs land on the feature branch before merge, never as a post-merge
   fixup**.

All of these MUST be present on the feature branch, pushed, and reflected by green CI before
merge.

---

## 7. Merge

When standard CI is green and the feature branch contains the `ROADMAP.md` (and, for
spec-backed items, `tasks.md`) updates, the agent MUST **squash-merge** the PR to
`development`:

```bash
gh pr merge <number> --squash --delete-branch
```

The session is then **complete**. The agent MUST NOT start a second ROADMAP item, open a second
PR, or continue working in the same session.

---

## 8. Constraints

- **One PR per session.** The agent MUST NOT open additional PRs or select a second ROADMAP
  item in this session.
- **Target `development`, never `main`.** The agent MUST NOT open a PR against `main` or push
  to `main`. Promotion of `development` → `main` is a human operator step.
- **Missing toolchain.** If `npm install`, `npm run typecheck`, or `npm test` fails because
  Node, a system library, or (for harness items) the Playwright browser download is absent, the
  agent MUST stop and report the missing dependency in a PR comment or session message. The
  agent MUST NOT attempt to bootstrap a toolchain via brew, snap, conda, or any other package
  manager, and MUST NOT add an npm dependency the item's spec does not call for.
- **Auth failures.** If `git push`, `gh pr create`, or any `gh` call fails with an
  authentication error, the agent MUST stop and report it. The agent MUST NOT attempt to fix or
  rotate credentials.
- **CI divergence.** If the agent cannot get CI green after a reasonable number of cycles, it
  MUST post a PR comment summarizing the blocker and stop. It MUST NOT thrash with speculative
  pushes.
- **No root.** The agent MUST NOT run `sudo`. If a task genuinely requires root, the agent MUST
  report it and stop.
