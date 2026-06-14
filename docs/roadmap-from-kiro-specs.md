# Serializing a Kiro spec into a ROADMAP

This document describes the **method** for turning a [Kiro](https://kiro.dev) spec into items
in the [`ROADMAP.md`](../ROADMAP.md) work queue that agent-router consumes. The agent ships one
ROADMAP item per session; the quality of that loop depends almost entirely on how well the spec
is serialized. Read this before you add your own items.

A Kiro spec is three documents in a `.kiro/specs/<feature>/` directory:

- **`requirements.md`** — what the feature must do, in EARS/Kiro acceptance-criteria form.
- **`design.md`** — how it will be built: components, types, file layout, interfaces.
- **`tasks.md`** — a flat checklist of implementation sub-tasks, usually grouped and numbered
  (`1.1`, `1.2`, `2.1`, …), sometimes with a dependency/wave graph.

The ROADMAP is **not** a copy of `tasks.md`. It is a re-grouping of those sub-tasks into
**PR-sized, dependency-ordered items**, each of which an agent can implement, test, and merge in
a single session. The mapping is many-to-one: one ROADMAP item bundles several `tasks.md`
sub-tasks. (agent-router's queue also carries **backlog-backed** items that cite a `BACKLOG.md`
mini-spec instead of a Kiro spec — those skip steps 1–2 below since the mini-spec is already a
single PR's worth of contract.)

For a real, large example of the output, see the ROADMAP of
[`gspivey/dpdk-stdlib-rust`](https://github.com/gspivey/dpdk-stdlib-rust/blob/development/ROADMAP.md):
multi-crate Kiro specs serialized into 30-plus ordered items, each citing the exact `tasks.md`
numbers it covers.

---

## Why serialize at all?

The agent-router daemon wakes an agent, which picks the **first unchecked item** and ships
exactly one PR (see [`AGENTS.md`](../AGENTS.md) and
[`prompts/agent-router.md`](../prompts/agent-router.md)). That model only works if the queue has
three properties:

1. **One item is one PR.** If an item is too large, the PR is unreviewable and CI takes too long
   to close the loop. If it is too small, you spend more sessions on overhead than on code.
   Target roughly **300–500 lines** of new or modified code per item, tests included.
2. **Items are independently mergeable.** Each item must build, type-check (`npm run
   typecheck`), and pass `npm test` and merge to `development` on its own. It may depend on
   *earlier* items (already merged) but never on a *later* one.
3. **The order is a valid topological sort.** When the agent reaches item N, every prerequisite
   it imports, calls, or extends is already on `development`. No item may reference code that a
   later item introduces.

Serialization is the act of imposing those three properties on a spec that, on its own, is just
a pile of requirements and an unordered (or loosely ordered) task list.

---

## The method, step by step

### 1. Read all three spec documents fully

Start from `requirements.md` to understand *what* and *why*, then `design.md` for the component
and file layout, then `tasks.md` for the unit of work. Note every type, module, and file path
the design names — these become the nouns in your item titles.

### 2. Build the dependency graph

For each `tasks.md` sub-task, ask: *what must already exist for this to compile and pass its
tests?* A type must exist before the function returning it; a broker method must exist before the
test exercising it; a fixture must exist before the spec files that import it. The result is a
directed acyclic graph over sub-tasks. Many Kiro `tasks.md` files publish this explicitly as a
wave graph at the bottom — use it. If you find a cycle, the spec has a design problem; resolve it
before serializing (usually by splitting a type out into its own earlier item).

### 3. Group sub-tasks into PR-sized items

Walk the graph in dependency order and accrete sub-tasks into an item until it reaches the
~300–500-line budget or a natural seam (a complete type, a finished fixture, one cohesive set of
test files). Prefer grouping sub-tasks that share a file or a test fixture. Each item should leave
the tree **green**: it builds and all its tests pass with nothing stubbed that a later item is
responsible for. A good item is a sentence: "add X and its tests."

A few sizing heuristics:

- A foundational item (new module skeleton, shared types, a test fixture) is often light on lines
  but unblocks many later items — keep it focused; do not pad it.
- A pure test item can stand alone once the code it tests has merged.
- If a single `tasks.md` sub-task is itself ~500 lines, it becomes its own item; the many-to-one
  mapping is a guideline, not a rule.

### 4. Topologically order the items

Order the items so every item's prerequisites appear above it. Within the freedom the graph
allows, prefer ordering that lets an agent demonstrate behavior early (a thin walking skeleton
before deep features) and front-loads low-risk items so the self-build loop proves itself before
it reaches anything fragile. The first item should have no unmet prerequisites — it is what the
agent picks on the very first session.

### 5. Map each item back to `tasks.md`

Record, on each item, the exact `tasks.md` sub-task numbers it covers (the `Spec:` line below).
This is what lets the agent tick the matching `tasks.md` checkboxes when the item merges, keeping
`tasks.md` and `ROADMAP.md` in lockstep. Every sub-task in `tasks.md` must appear in exactly one
ROADMAP item — no orphans, no duplicates.

### 6. Write each item in the exact format

Use this shape for every Active Roadmap item (verbatim — the agent and the tooling rely on it):

```markdown
### N. Title

A short paragraph: what the item delivers, the key types/files it touches, the tests it adds, and
which earlier item(s) it builds on. One PR's worth of work, described in prose.

- Spec: `.kiro/specs/<feature>/` · tasks `a.b`, `c.d`
- [ ] Complete · PR: —
```

Rules for the format:

- `### N. Title` — sequential number, then a terse noun-phrase title naming the thing built.
- The paragraph names concrete files/types and states the dependency on prior items so a reviewer
  understands the slice without opening the spec.
- The `Spec:` line points at the spec **directory** and lists the covered `tasks.md` numbers in
  backticks, separated by the middle dot `·`. For a backlog-backed item the line is instead
  `Spec: BACKLOG.md § P<n>` with no `tasks` list.
- The checkbox line is **literally** `- [ ] Complete · PR: —` until merge, then becomes
  `- [x] Complete · PR: #<number>`.
- Separate items with a `---` rule.

### 7. Keep the file's two sections

The ROADMAP has a header paragraph (how the file is used and sized), an **`## Active Roadmap`**
section (the ordered items), and a **`## Completed`** section that items move into after they
merge.

---

## Worked walkthrough: the browser-test-harness spec

The spec at [`.kiro/specs/browser-test-harness/`](../.kiro/specs/browser-test-harness/) introduces
a Playwright tier and serializes into items **14–18** of `ROADMAP.md`. Here is how the method
produced them.

**The spec.** `requirements.md` defines ten requirement groups (module resolution, fixtures, list
view, detail view, SSE render, SSE reconnect, inject, kill, auth, npm wiring). `design.md` fixes
the file layout (`test/browser/*.spec.ts`, `test/browser/fixtures.ts`, `playwright.config.ts`) and
the new `SSEBroker.disconnectAll` method. `tasks.md` lists sub-tasks `1.1`, `2.1`, `3.1`, `5.1`,
`6.1`, `7.1`, `8.1`, `9.1`, `10.1`, `12.1`, `13.1`, `14.1` and — crucially — publishes a **wave
graph** at the bottom.

**Apply the method.**

1. *Read.* Ten requirement groups, one new broker method, one fixtures module, ~10 spec files.
2. *Dependency graph.* Take it straight from the spec's published waves: `1.1` (resolution) →
   `2.1` (`disconnectAll`) → `3.1` (fixtures) → the read-path specs `{5.1, 6.1, 7.1, 13.1}` → the
   interactive specs `{8.1, 9.1, 10.1}` → `12.1` (visibility) and `14.1` (npm script).
3. *Group into items.* `1.1`+`2.1` are both small scaffolding and share the "make the tier exist"
   seam → one item (14). `3.1` (fixtures) is the load-bearing dependency for everything below and
   is substantial on its own → its own item (15). The read-path specs share the `live: false`
   fixture mode → one item (16). The interactive specs share the `live: true` scenario → one item
   (17). `12.1`+`14.1` close the suite out → one item (18).
4. *Order.* Items 14 → 15 → 16 → 17 → 18, matching the waves. Item 14 has no unmet prerequisite.
5. *Map back.* 14 covers `1.1, 2.1`; 15 covers `3.1`; 16 covers `5.1, 6.1, 7.1, 13.1`; 17 covers
   `8.1, 9.1, 10.1`; 18 covers `12.1, 14.1`. Every sub-task is claimed exactly once.
6. *Write the items* in the format above — see `ROADMAP.md` items 14–18.

When you serialize your next spec, run the same six steps over its `.kiro/specs/<feature>/` and
append the items after the last unchecked entry.

---

## Checklist before you commit ROADMAP changes

- [ ] Every `tasks.md` sub-task (for spec-backed work) appears in exactly one item.
- [ ] Each item is one PR's worth of work (~300–500 lines, tests included).
- [ ] Each item leaves the tree green on its own — nothing it ships is stubbed pending a later
      item.
- [ ] Items are in valid topological order: no item references code a later item introduces.
- [ ] Every item has a number, a title, a paragraph, a `Spec:` line, and a `- [ ] Complete · PR: —`
      line.
- [ ] The file has a header paragraph, `## Active Roadmap`, and a `## Completed` section.
