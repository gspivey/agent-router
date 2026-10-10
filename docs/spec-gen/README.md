# Spec-Gen SOP

This directory contains the spec-generation standard operating procedure (SOP) used
by the Kiro Crew agent when writing specs for this repository.

## Contents

- `SKILL.md` -- Full SOP: brief enrichment, Kiro spec generation, Claude opus-5.5 review
  loop, ROADMAP sync, and PR workflow.
- `scripts/ears_validator.py` -- Deterministic pre-review validator. Checks
  requirements.md for EARS violations before burning Claude tokens. Run with:
  `python3 scripts/ears_validator.py <path/to/requirements.md>`

## When this SOP is used

The Kiro Crew agent follows this SOP whenever a spec is generated for this repository.
The Claude review loop uses `claude-opus-5-5` and targets SHIPPABLE verdict before
a PR is cut.
