# Artifact Contracts — Overview

Status: proposed (Task 2). Inputs: `.agentflow/docs/spec/*`. This defines the exact,
platform-independent file formats used by Analyzer, Planner, Executor, and the
Orchestrator. Machine-readable schemas: `schemas/agentflow.schema.json`.
Examples: `examples/`.

## 1. State root

All workflow state lives under `.agent/` (root-relative, configurable name).

```
.agent/
  config.json
  manifest.md
  knowledge/
    index.json
    facts/<id>.json
    notes/<id>.md
  tasks/<task-id>/
    task.md
    plan.json
    progress.json
    state.json
    discrepancies.json
    result.json
    result.md            # optional human narrative
    usage.json           # optional; per-item request/token spend (self-reported)
```

## 2. Authoritative vs. human views

| Artifact | Format | Authority | Authored by |
|----------|--------|-----------|-------------|
| `config.json` | JSON | machine | user |
| `knowledge/index.json` | JSON | machine | Analyzer / core |
| `knowledge/facts/*.json` | JSON | machine (deterministic) | scripts |
| `knowledge/notes/*.md` | Markdown | human/LLM | Analyzer |
| `task.md` | Markdown | human/LLM | Conductor |
| `plan.json` | JSON | machine | Planner |
| `progress.json` | JSON | machine | Executor / core |
| `state.json` | JSON | machine | core |
| `discrepancies.json` | JSON | machine | any role |
| `result.json` | JSON | machine | Executor / core |
| `result.md` | Markdown | optional view | Executor |
| `usage.json` | JSON | machine (numbers self-reported by the agent) | Executor via core `usage add` |

Markdown artifacts are validated by **required H2 headings** (case-insensitive),
never by line numbers. JSON artifacts are validated by JSON Schema.

## 3. Naming and ID rules

- **Task ID:** `T-<yyyymmdd>-<nnn>` (e.g. `T-20261016-001`). Stable, never reused.
- **Plan item ID:** `P<n>` for top-level, `P<n>.<m>` for sub-items. Stable within
  a plan. A reopened task gets a **new** plan; old IDs are never re-used.
- **Knowledge ID:** `k-<slug>` (facts) or `n-<slug>` (analysis notes).
- **Discrepancy ID:** `D<n>`.
- **Acceptance criterion ID (in result/plan):** `AC<task-suffix>.<n>`.

## 4. References (heading anchors, no line numbers)

- Knowledge reference syntax: `<path>#<Heading>` (e.g.
  `.agent/knowledge/notes/auth.md#Verified facts`).
- Line numbers, byte offsets, and large source excerpts are **forbidden**.
- A reference must resolve: path exists and heading is present (core `validate`).

## 5. Schema versioning

- Every JSON artifact has an integer `schema_version` (current: `1`).
- Breaking changes increment it; `docs/guides/upgrade.md` (Task 7) documents
  migrations. Absent/unknown version → artifact is `invalid`, not auto-migrated.

## 6. Atomic writes & interrupted-write detection

- Writers MUST write to `<file>.tmp` then `rename()` over the target (atomic on
  the same filesystem).
- Readers MUST ignore `*.tmp` files entirely.
- An artifact missing `schema_version` or failing parse → status `invalid`
  (never `missing`), and is never silently overwritten.
- Interrupted write signature: target present but fails parse, or a `.tmp`
  sibling exists → core reports `invalid`/`interrupted`, and resume starts from
  the last valid `progress.json`.

## 7. Resume contract

`progress.json.next_action` MUST be sufficient to continue in a new session
without chat history: it names the plan item, a concrete action, and any
blocking item IDs. `state.json` carries lifecycle status + counters. On resume,
a new session reads `state.json` → `progress.json.next_action` → the referenced
plan item and knowledge only — or, preferred, gets all of it in one payload
from core `context --task <id>` (same sources, one read).

`usage.json` (optional) records per-item request/token spend against
`config.budget`; it is part of the resume payload so a session resumes knowing
whether the remaining budget allows it to continue the item.

## 8. Freshness / status metadata

- Knowledge status lives in `index.json` entries (`fresh`, `stale`, `missing`,
  `incomplete`, `invalid`) — see `statuses.md`.
- `state.json` carries task lifecycle status and counters.
- See `statuses.md` for the full enumerations and legal transitions.

## 9. Secrets & duplication

- Never store credentials, tokens, `.env` contents, or private keys.
- Never copy large source files into artifacts; reference paths + headings and
  keep facts to structured summaries.

## 10. Audit trail

Record **meaningful** events only (state transitions, discrepancies, plan
approvals, verification runs). Trivial edits are not logged. Event list lives in
`state.json.history` and `discrepancies.json`.
