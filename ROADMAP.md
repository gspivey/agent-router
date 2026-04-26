# Agent Router — Roadmap

This document describes the phased evolution of Agent Router from its current single-user daemon to a feature-complete self-hosted tool. It defines *what* each phase delivers and *in what order*. Tactical work items and bug fixes live in `BACKLOG.md`; product strategy lives in `PRODUCT.md`.

Phases are not strict gates — work in later phases can begin once their dependencies are stable, not necessarily complete. Sizing is approximate and assumes one developer.

---

## Phase 1: Production Stability

**Goal:** reliable autonomous operation on a personal dev machine. Cron-triggered sessions ship PRs without human babysitting.

**Scope:** deterministic session completion, self-wake prevention, token expiry monitoring, session collision handling, git worktrees per session, cleanup automation, health endpoint. The daemon must survive its own restarts, recover from common failure modes, and surface enough state for an operator to triage overnight runs.

**Dependencies:** none — current codebase is the starting point.

**Sizing:** 2–3 weeks. Most items are small; the integration work (cron + worktrees + health monitoring + notification webhook) is what takes time.

---

## Phase 2: ACP Server — Editor Integration

**Goal:** any ACP-compatible editor (Cline, Zed, JetBrains) can connect to Agent Router as a frontend. Editors see sessions, inject prompts, and stream output without knowing about the underlying agent runtime.

**Scope:** Agent Router exposes its own ACP endpoint over stdio. Maps `session/new`, `session/prompt`, and `session/load` to internal session operations. Streams `session/update` notifications from the backend agent to the editor. Handles the case where multiple input sources (editor + webhook) target the same session.

**Dependencies:** Phase 1 stable. Sessions need to survive restarts and be resumable before exposing them through a third-party editor's lifecycle.

**Sizing:** 2–4 weeks. Most of the complexity is in concurrent-input handling and tool-call passthrough.

---

## Phase 3: Web Dashboard

**Goal:** monitor and interact with sessions from a browser, including mobile. Primary use case: checking on overnight cron runs from a phone.

**Scope:** static SPA served by the daemon's HTTP server. REST API wrapping existing IPC ops. SSE endpoint streaming `stream.log` entries in real time. Session list and detail views. Prompt input for active sessions. Auth via simple token or Cloudflare Access.

**Dependencies:** Phase 1 stable. Independent of Phase 2 — they're parallel entrypoints to the same session manager and can be built in either order.

**Sizing:** 4–8 weeks. UI work is the bulk; the API layer is mostly already present in CLI form.

---

## Phase 4: Multi-Repo Projects & Sandboxing

**Goal:** features that span multiple repositories, each agent running in an isolated sandbox.

**Scope:** project concept (a named group of repos with shared context). Feature concept (coordinated git worktrees across project repos). Sessions span multiple PRs across repos. Webhooks from any repo in the project route to the correct feature session. Docker-based sandboxing isolates agent execution. Project-level shared memory (codebase embeddings, learnings) persists across features.

**Dependencies:** Phase 2 or Phase 3 — needs at least one UI for managing projects, since CLI alone is too cumbersome at this scope.

**Sizing:** 8–12 weeks. The container sandboxing alone is a meaningful sub-project.

---

## Phase 5: Swappable Agent Backends

**Goal:** route sessions to different agents based on task type or user preference.

**Scope:** abstract the agent backend behind an interface (spawn, initialize, prompt, stream). Refactor the current Kiro driver to that interface. Add a Hermes backend. Per-session backend selection with a config default. Backend health monitoring with fallback on crash.

**Dependencies:** Phase 2. The ACP server work informs what shape the backend interface should take — building it twice is avoidable if Phase 2 happens first.

**Sizing:** 4–6 weeks. Mostly refactoring; the second backend (Hermes) is what proves the abstraction is right.

---

## Sequencing notes

- **Phases 2 and 3 can run in parallel.** They're independent entrypoints to the same session manager. Phase 3 has more user-facing value if you only have time for one.
- **Phase 4 depends on a UI being available** (Phase 2 or 3, either is sufficient). The CLI alone is too cumbersome for managing project-level concepts.
- **Phase 5 is architecturally independent** but most valuable once Phase 3 (dashboard) exists, because backend choice is a UX decision more than a CLI flag.