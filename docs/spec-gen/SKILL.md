---
name: spec-gen
description: Generate a software spec via Kiro spec mode with Claude review loops, then serialize to ROADMAP and cut a PR. Reviews use claude-opus-5-5.
triggers: generate spec, write spec, spec generation, new feature spec, create spec, kiro spec, spec out, design spec
source: crystallize
version: 2.0
---

# spec-gen

Human-in-the-loop spec generation pipeline. Takes a brief from the user,
enriches it through clarifying questions, generates a formal spec via Kiro's
spec mode, reviews it with Claude opus-5.5 ultrathink, validates against context
files, then cuts a PR adding the spec to the target repo's ROADMAP.

## When to use

User says "generate a spec for X", "write a spec", "create a spec", "I want
to add a feature", "spec out X before we build it", or "design a spec".

---

## Session State

Each spec-gen run maintains state in a workspace file for resumability:

```bash
STATE_FILE="$HOME/.kiro/crew/workspace/spec-gen-state-<slug>.json"
```

State schema:
```json
{
  "slug": "libby-mcp",
  "workdir": "/tmp/spec-gen-20260808-1200-libby-mcp",
  "repo": "gspivey/libby-mcp",
  "base_branch": "main",
  "kiro_session_id": "91ee84ce-f443-42c2-bbf6-022cc711adb7",
  "phase": "review",
  "review_round": 3,
  "review_history": [
    {"round": 1, "verdict": "NEEDS_REVISION", "critical": 2, "high": 5},
    {"round": 2, "verdict": "NEEDS_REVISION", "critical": 0, "high": 3},
    {"round": 3, "verdict": "SHIPPABLE", "critical": 0, "high": 0}
  ],
  "open_issues": [],
  "closed_issues": ["CRITICAL-1", "CRITICAL-2", "HIGH-1", "HIGH-2", "HIGH-3"],
  "pr_url": null
}
```

**Resume a session**: Check for existing state file at start. If found, ask
user whether to resume or start fresh.

---

## Phase 1: Brief Enrichment

1. Receive the user's brief (1-3 sentences is fine).
2. Ask up to 10 clarifying questions covering:
   - Target repo and base branch
   - Feature slug (kebab-case, used as directory name)
   - User stories / who benefits
   - Hard constraints (performance, security, API compatibility)
   - What's explicitly out of scope
   - Acceptance criteria — how do we know it works?
   - Dependencies on other specs or features
   - **Context files** — any existing code, API specs, or reference material
3. Write enriched brief to `$WORKDIR/BRIEF.md`.
4. Show brief to user. Loop until user approves.
5. **Save state**: `phase: "brief_approved"`

---

## Phase 2: Spec Generation (Kiro CLI)

1. Set up working directory:
   ```bash
   WORKDIR="/tmp/spec-gen-$(date +%Y%m%d-%H%M%S)-<slug>"
   mkdir -p "$WORKDIR"
   cd "$WORKDIR"
   # If targeting an existing repo:
   gh repo clone <owner>/<repo> . -- -b <base-branch>
  # NOTE: do NOT use --depth=1. Shallow clones have no shared history with
  # remote branches, causing every file to conflict as add/add during rebase.
   ```

2. Copy any context files the user provided to `.kiro/specs/<slug>/context/`.

3. Run Kiro spec mode:
   ```bash
   nohup kiro-cli chat --v3 --mode spec --no-interactive --trust-all-tools \
     "$(cat BRIEF.md)
      
      Feature slug: <slug>
      Write files to .kiro/specs/<slug>/requirements.md, design.md, tasks.md
      
      Context files are in .kiro/specs/<slug>/context/ — reference them for
      API details, existing patterns, and constraints." > /tmp/kiro-spec.log 2>&1 &
   ```

4. **Capture session ID** (Kiro doesn't print it):
   ```bash
   # Wait for kiro to create session, then:
   KIRO_SESSION_ID=$(ls -t ~/.kiro/sessions/cli/ | head -1)
   ```

5. **Save state**: `phase: "spec_generated"`, `kiro_session_id: <id>`

6. Read the generated files and show to user.

7. Feedback loop:
   - If user has feedback: use `KIRO_FIX_TEMPLATE` (below)
   - If user approves: proceed to Phase 3

### KIRO_FIX_TEMPLATE

Use this template to push fixes to Kiro. **Always resume the same session**:

```bash
kiro-cli chat --v3 --resume-id "$KIRO_SESSION_ID" --no-interactive --trust-all-tools \
"Fix these issues in the spec at .kiro/specs/<slug>/:

<ISSUE_LIST>

For each issue:
1. Identify which file(s) need changes
2. Make the fix
3. Verify no contradictions introduced

After fixing, confirm what changed."
```

---

## Phase 3: UltraReview (Claude opus-5)

### Pre-Review: EARS Validator (deterministic, run first)

Before running Claude, run the deterministic EARS validator. It catches vague
language and untestable ACs without burning tokens:

```bash
SKILL_DIR="${KIROCREW_HOME:-$HOME/.kiro/crew}/skills/spec-gen"
python3 "$SKILL_DIR/scripts/ears_validator.py" "$SPEC_DIR/requirements.md"
```

Exit codes:
- `0` — pass (or warnings only) → proceed to Claude review
- `1` — errors found → push fixes to Kiro first, then re-run validator, then Claude
- `2` — usage/env error

**Common findings and fixes:**
| Finding | Fix |
|---------|-----|
| `SHOULD_IN_REQUIREMENT` | Change `should` → `shall` or `must` in NFR/FR/AC lines |
| `VAGUE_LANGUAGE` | Replace vague term with measurable value (a number, HTTP code, boolean) |
| `UNMEASURABLE_AC` | Add a concrete outcome to the AC (e.g., "returns HTTP 200", "≤ 500ms") |
| `INCOMPLETE_REQUIREMENT` | Replace TBD/TODO with actual requirement text |

The validator is in `$SKILL_DIR/scripts/ears_validator.py`. It is deterministic
(regex-based) and runs in <1s — no LLM cost.

### Review Loop Protocol

**Cap: 5 rounds maximum.** After that, ship — tests catch real issues.

For each round:

1. **Run review** using `CLAUDE_REVIEW_TEMPLATE`
2. **Parse verdict**: SHIPPABLE or NEEDS_REVISION
3. **Track issues**: Add new issues to `open_issues`, move fixed ones to `closed_issues`
4. **If NEEDS_REVISION with CRITICAL/HIGH**:
   - Push fixes to Kiro using `KIRO_FIX_TEMPLATE`
   - Increment `review_round`
   - Re-run review
5. **If SHIPPABLE or round > 5**: Proceed to Phase 4
6. **Save state** after each round

### CLAUDE_REVIEW_TEMPLATE

```bash
SPEC_DIR=".kiro/specs/<slug>"

# Concatenate spec files for review
cat > /tmp/spec-review-input.txt << 'EOF'
=== REQUIREMENTS.MD ===
EOF
cat "$SPEC_DIR/requirements.md" >> /tmp/spec-review-input.txt

cat >> /tmp/spec-review-input.txt << 'EOF'

=== DESIGN.MD ===
EOF
cat "$SPEC_DIR/design.md" >> /tmp/spec-review-input.txt

cat >> /tmp/spec-review-input.txt << 'EOF'

=== TASKS.MD ===
EOF
cat "$SPEC_DIR/tasks.md" >> /tmp/spec-review-input.txt

# Add context files if they exist
if [ -d "$SPEC_DIR/context" ]; then
  for f in "$SPEC_DIR/context"/*; do
    echo -e "\n=== CONTEXT: $(basename "$f") ===" >> /tmp/spec-review-input.txt
    cat "$f" >> /tmp/spec-review-input.txt
  done
fi

# Run review
cat /tmp/spec-review-input.txt | claude -p --model claude-opus-5-5 \
"ultrathink: Review round <N> for <slug> spec.

Previous issues fixed: <CLOSED_ISSUES or 'None - first review'>
Known open issues: <OPEN_ISSUES or 'None'>

## Review Checklist

### 1. Requirements ↔ Design Traceability
- Every FR and NFR has corresponding design coverage
- No orphaned requirements without design decisions

### 2. Design ↔ Tasks Traceability
- Every design component has implementation tasks
- File paths and directory structures are consistent across files

### 3. Cross-File Consistency
- Technology choices consistent (language version, frameworks, configs)
- Error handling approaches match across all three files
- API endpoint paths, response shapes, field names consistent

### 4. Context File Validation (if context files provided)
- API endpoints match OpenAPI/reference docs
- Data types are consistent with schemas
- Error codes referenced actually exist
- No hardcoded values that should come from config

### 5. Internal Contradictions
- Any place where one file says X and another says Y
- Any self-contradictions within a single file
- Acceptance criteria that conflict with each other

### 6. EARS/Testability
- Requirements use measurable acceptance criteria
- No vague terms like 'should', 'reasonable', 'appropriate'
- Each AC can be verified by a test or observation

### 7. Completeness
- Edge cases covered
- Error paths defined
- All parameters documented

## Output Format

VERDICT: SHIPPABLE | NEEDS_REVISION

ISSUES:
CRITICAL-N: <one-line description> → <one-line fix>
HIGH-N: <one-line description> → <one-line fix>
MEDIUM-N: <description> (non-blocking, document only)
LOW-N: <description> (non-blocking, document only)

FIXED_THIS_ROUND: <list issue IDs that are now resolved>

Be thorough. Do not skip issues to be polite."
```

### Issue Triage Rules

| Severity | Action |
|----------|--------|
| CRITICAL | Must fix before shipping. Push to Kiro, re-review. |
| HIGH | Should fix. Push to Kiro if < 5 rounds, else document. |
| MEDIUM | Document in REVIEW_SUMMARY.md. Ship anyway. |
| LOW | Document in REVIEW_SUMMARY.md. Ship anyway. |

### Escalation (after 5 rounds)

If issues persist after 5 rounds, they're usually:
- Theoretical edge cases unlikely in practice
- Self-referential validator paradoxes
- Style/consistency nits that don't affect correctness

Present remaining issues to user with options:
1. Fix manually and re-review once more
2. Accept as-is and ship (tests will catch real issues)
3. Descope the problematic requirement

---

## Phase 4: ROADMAP Sync

**Critical step** — ROADMAP.md is what the agent actually executes.

### ROADMAP_SYNC_CHECKLIST

Before creating ROADMAP items, verify:

```
[ ] Technology choices match (Python version, framework, IaC tool)
[ ] File paths match design.md Project Structure
[ ] PR boundaries match tasks.md grouping (e.g., "Tasks 2-9 are ONE PR")
[ ] Error handling approach matches design.md
[ ] API field names match design.md Data Models
[ ] No contradictions between ROADMAP description and spec
[ ] Each ROADMAP item includes: spec files to read, exact interfaces, critical constraints, dependencies
[ ] Tasks split across multiple ROADMAP items (never one item for all tasks)
[ ] If multiple specs: combined into one PR (not one PR per spec)
```

### ROADMAP Item Template

The spec files are self-contained and complete. The ROADMAP item's job is to say which spec and which tasks — nothing more. The agent reads all three spec files in full, then the tasks carry EARS references back to requirements, making it unambiguous what to implement.

```markdown
### N. <Title>

Read `.kiro/specs/<slug>/requirements.md`, `design.md`, and `tasks.md` in full,
then implement tasks `X`, `Y`, `Z`. [Depends on item N-1 (one-line reason).]

- Spec: `.kiro/specs/<slug>/` · tasks `X`, `Y`, `Z`
- [ ] Complete · PR: —

---
```

**Rule**: Do NOT add section hints, interface summaries, or constraint notes to the ROADMAP item. If those belong anywhere, they belong in the spec files — which is where they already are.

### Grouping Rules

1. Read `tasks.md` for explicit PR boundaries (e.g., "Tasks 2-9 are ONE PR")
2. Group related tasks that share files/fixtures — **backend (types, pure logic, tests, API) in early items; frontend (CSS, JS, rendering, E2E) in later items**
3. Each item should be 300-500 lines of implementation
4. Each item must be independently mergeable
5. Infrastructure/CI tasks go early, not at the end
6. **NEVER create a single ROADMAP item pointing to all tasks in a spec** — always split regardless of task count
7. **Multiple specs generated together go in one PR** — they all modify ROADMAP.md; separate PRs create merge conflicts

### Sync Verification

After writing ROADMAP items, run a quick consistency check:

```bash
# Extract key claims from ROADMAP and verify against spec
grep -E "(Python [0-9.]+|CDK|SAM|Lambda|auth|header)" ROADMAP.md
grep -E "(Python [0-9.]+|CDK|SAM|Lambda|auth|header)" .kiro/specs/<slug>/*.md
# Manually verify no contradictions
```

---

## Phase 5: Cut PR

```bash
BRANCH="feat/<slug>-spec"
git checkout -b "$BRANCH"
git add .kiro/specs/<slug>/ ROADMAP.md
git commit -m "feat: add <slug> spec and ROADMAP entry

<Brief one-liner about the feature>

Spec includes:
- requirements.md: <N> functional requirements, <M> non-functional
- design.md: architecture, data models, error handling
- tasks.md: <N> tasks in <M> ROADMAP items

Review: <N> Kiro revisions, <M> Claude opus-5.5 reviews
Final verdict: SHIPPABLE"

git push -u origin "$BRANCH"

# Create PR
gh pr create --base <base-branch> --head "$BRANCH" \
  --title "feat: add <slug> spec and ROADMAP" \
  --body "## Summary
Adds spec for <feature description>.

## Spec Contents
- **requirements.md**: Functional and non-functional requirements with acceptance criteria
- **design.md**: Architecture, data models, API mappings, error handling
- **tasks.md**: Implementation tasks grouped into ROADMAP items

## Review History
- Kiro revisions: <N>
- Claude opus-5.5 reviews: <M>
- Final verdict: SHIPPABLE

## ROADMAP Items
This PR adds items <X>-<Y> to ROADMAP.md, covering:
1. <Item 1 summary>
2. <Item 2 summary>
...

## Next Steps
After merge, implementation begins with ROADMAP item <X>."
```

**Save state**: `phase: "pr_created"`, `pr_url: <url>`

---

## Gotchas

### Session Management
- **Always capture Kiro session ID** after first run
- **Always resume with `--resume-id`** — don't start fresh sessions for fixes
- **State file is the source of truth** — check it before any action

### Review Loop
- **5 rounds max** — diminishing returns after that
- **Track issues by ID** — don't lose context between rounds
- **MEDIUM/LOW don't block** — document and ship

### ROADMAP Sync
- **ROADMAP is what the agent executes** — it must match the spec exactly
- **Check PR boundaries** — tasks.md often specifies "Tasks X-Y are ONE PR"
- **Technology must match** — Python version, IaC tool, auth method
- **Enrich, don't summarize** — ROADMAP items must contain interfaces, constraints, and "do NOT" notes from the spec, not a restatement of the feature name

### When to Use a Mini-Spec vs Full Kiro Spec
- **Full Kiro spec** (default): any feature with design decisions, UX choices, or multi-file changes. Full spec takes ~30 min wall clock, ~5 min Gerard's time — negligible cost for the quality gain.
- **Mini-spec only** (exception): truly atomic fixes where "implement exactly this" fits in 3 sentences with no design decisions (e.g., a one-liner bug fix, a config field typo). If you're unsure, default to full Kiro spec.

### Git
- **Use noreply email**: `<id>+<username>@users.noreply.github.com`
- **Branch naming**: `feat/<slug>-spec`
- **Never push to main/master directly**

### Context Files
- **Use repo-relative paths** in spec files
- **Never use absolute host paths** like `/home/user/...`
- **Copy to `.kiro/specs/<slug>/context/`** in the repo

---

## Quick Reference

### Resume a spec-gen session
```bash
STATE_FILE="$HOME/.kiro/crew/workspace/spec-gen-state-<slug>.json"
cat "$STATE_FILE"  # See current phase and session ID
```

### Push fixes to Kiro
```bash
kiro-cli chat --v3 --resume-id "<session_id>" --no-interactive --trust-all-tools "<fixes>"
```

### Run review round N
```bash
# Set SPEC_DIR, then use CLAUDE_REVIEW_TEMPLATE above
```

### Check ROADMAP consistency
```bash
# Compare key terms between ROADMAP and spec
diff <(grep -oE "(Python [0-9.]+|CDK|SAM)" ROADMAP.md | sort -u) \
     <(grep -oE "(Python [0-9.]+|CDK|SAM)" .kiro/specs/<slug>/*.md | sort -u)
```
