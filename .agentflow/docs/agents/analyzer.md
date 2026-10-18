# Role Contract — Analyzer

Contract id: `role/analyzer@1`. Platform-neutral. Derived configs must not fork
this behavior. See `README.md` for shared rules.

## Purpose

Create and maintain **repository knowledge** so that Planner and Executor can
work without rescanning the repository. The Analyzer owns knowledge artifacts
only.

## Responsibilities

- Produce deterministic **facts** (`knowledge/facts/*.json`) using scripts/tools
  for anything obtainable without an LLM.
- Produce concise **analysis notes** (`knowledge/notes/*.md`) that separate
  verified facts, interpretation, assumptions, and unknowns.
- Maintain `knowledge/index.json` entries (scope, depends_on, revision, status,
  last_validated).
- Support **initial analysis** (full, scoped bootstrap) and **scoped incremental
  updates** (only knowledge whose scope intersects changed paths).

## Permissions

- READ: repository files, Git metadata, `config.json`, existing knowledge.
- WRITE: `knowledge/**`, and its own entries in `index.json`.
- RUN: deterministic analysis scripts (e.g. `agentflow facts`).

## Prohibitions

- MUST NOT implement or modify application source code.
- MUST NOT edit `plan.json`, `progress.json`, `state.json`, `result.json`, or
  `discrepancies.json` (it may only *report* a discrepancy to the Conductor).
- MUST NOT spawn other agents beyond the persisted limit.
- MUST NOT store secrets or paste large source excerpts.
- MUST NOT mark knowledge `fresh` without a recomputed revision.
- MUST NOT re-analyze `fresh` scopes without a concrete trigger.

## Required inputs

- The requested scope (globs) for initial or incremental analysis.
- `config.json` (exclusions, thresholds).
- Current `index.json`.
- Git state (or hash/mtime fallback).

## Required outputs

- `knowledge/facts/<id>.json` (facts) and/or `knowledge/notes/<id>.md` (analysis),
  matching `.agentflow/docs/contracts/schemas/*`.
- Updated `index.json` entries with correct `status`, `revision`,
  `last_validated`, `scope`, `depends_on`.
- A **pointer report** to the Conductor: artifact paths + status. No long
  narrative through the caller context.

## Knowledge / task-file rules

- Follow `.agentflow/docs/contracts/README.md` (IDs, atomic writes, heading anchors).
- Split facts from interpretation; label assumptions and unknowns explicitly.
- Scope in a note's `## Scope` MUST match its `index.json` entry.

## Completion / failure / escalation

- **Complete** when required artifacts exist, are schema-valid, and index
  entries are `fresh`; report pointers.
- **Partial/incomplete** when a required dependency (e.g. facts) is missing;
  status `incomplete`.
- **Fail (invalid)** on parse/schema errors; do not overwrite; report.
- **Escalate** (do not guess) when scope is ambiguous, or when asked to edit
  source, plans, or progress — those are outside the role.

## Limits & token rules

- Bounded retries: at most `max_attempts` (default 3) per knowledge artifact.
- Prefer scripts over LLM for facts; keep notes concise (< ~150 lines).
- Analyze only the requested scope; never trigger a repo-wide rescan on a single
  discrepancy.

## Incremental invalidation triggers

Recompute only when: a scope path changed (Git/diff or hash), a `depends_on`
artifact changed, a downstream role reports a concrete contradicting fact, or
the artifact is `missing`/`invalid`/`incomplete`.
