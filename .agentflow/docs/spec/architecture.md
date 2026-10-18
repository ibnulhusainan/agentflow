# Architecture — Cross-Platform AI Agent Workflow

Status: proposed (Task 1). Consistent with `requirements.md`, `workflow.md`,
`decisions.md`, `acceptance-criteria.md`.

## 1. Overview

Three cooperating roles (Analyzer, Planner, Executor) operate on **file-based
artifacts** under `.agent/`. A **platform-independent core** (CLI + library)
performs all deterministic operations: freshness classification, validation,
state transitions, verification gating, and retry/spawn accounting. **Platform
adapters** are thin mappings of the core to each editor's native capabilities;
they contain no business logic.

```
                user request
                     │
                     ▼
   ┌─────────── Orchestration (Conductor) ───────────┐
   │  selects task, enforces gates & lifecycle state  │
   └───────────────┬───────────────┬─────────────────┘
                   │               │
        ┌──────────▼───┐   ┌───────▼──────┐   ┌──────────────┐
        │  Analyzer    │   │  Planner     │   │  Executor    │
        │ knowledge/*  │   │ plan.md      │   │ impl+progress │
        └──────┬───────┘   └───────┬──────┘   └──────┬───────┘
               │                   │                  │
               └─────────────► .agent/ artifacts ◄───┘
                     ▲                                   
                     │  deterministic reads/writes        
        ┌────────────┴─────────────┐                      
        │  Core (.agentflow)  │  status, validate,   
        │  no platform APIs        │  transition, gate,   
        └────────────┬─────────────┘  retry/spawn counts   
                     │                                     
        ┌────────────▼─────────────┐                      
        │  Platform adapters       │ OpenCode, Cursor, …  
        │  (thin, optional)        │                      
        └──────────────────────────┘                      
```

## 2. Components

| Component | Responsibility | Owns |
|-----------|----------------|------|
| Analyzer | Produce/maintain repo knowledge (facts + analysis) | `knowledge/` |
| Planner | Convert request into dependency-aware plan | `tasks/<id>/plan.md` |
| Executor | Implement plan, record progress/verification | `tasks/<id>/progress.json`, `result.md` |
| Orchestrator (Conductor) | Enforce prerequisites, transitions, retry/spawn limits, closure | `state.json`, lifecycle |
| Core | Deterministic freshness/validation/transitions | `.agentflow/*` |
| Platform adapter | Map core to platform features | `adapters/*` |

## 3. Repository layout (proposed, user-overridable)

```
.agent/                        # workflow state (the only state root)
  config.json                  # user config: thresholds, exclusions, verify cmds
  knowledge/
    index.json                 # knowledge index (entries + status)
    facts/                     # machine-generated, deterministic (JSON)
      repo.json
    notes/                     # LLM-authored analysis (Markdown, heading refs)
  tasks/
    <task-id>/
      task.md                  # user request + scope
      plan.md                  # ordered plan items
      progress.json            # per-item status + resumable next action
      state.json               # lifecycle status, retry/spawn counters, checksums
      discrepancies.md         # discrepancy/blocker reports
      result.md                # final result + verification record
  manifest.md                  # execution manifest (human + machine readable)
.agentflow/               # core CLI + library (platform-independent)
  cli.mjs  lib/*  test/*
adapters/                      # platform adapters (optional)
  opencode/  cursor/
```

## 4. Artifact contracts

Exact schemas are defined in Task 2 (`.agentflow/docs/contracts/`). Task 1 only fixes the
relationships:

- `index.json` entries carry: `id`, `path`, `type` (`facts|analysis`), `scope`
  (globs), `depends_on[]`, `owner`, `revision` (commit + content hash),
  `status`, `last_validated`.
- A **plan item** has a stable ID, description, `paths[]`, `knowledge_refs[]`
  (heading anchors), `completion_criterion` (testable), `depends_on[]`,
  `status`.
- `progress.json` carries per-item status and a **`next_action`** that is
  sufficient to resume in a new session.
- `state.json` carries lifecycle status and **persisted counters** (attempts,
  spawn depth/children) — the basis for FR-7.

## 5. Knowledge freshness model (deterministic)

Classification order (first match wins):

1. **missing** — no index entry for required scope, or referenced file absent.
2. **invalid** — file present but fails parse/schema (malformed JSON/Markdown
   structure).
3. **incomplete** — parseable, but required fields/sections absent, or required
   dependency (`facts`) absent.
4. **stale** — `revision` differs from a recomputed revision, or any
   `depends_on` entry changed, or Git reports scope-relevant changes since
   `last_validated`.
5. **fresh** — otherwise.

Change detection: prefer `git diff --name-only <last_commit>..HEAD`; if Git is
unavailable, fall back to content hash + mtime of files matching `scope`.
Only knowledge whose `scope` intersects changed paths is invalidated (FR-3).

## 6. Enforcement model

Two layers, clearly separated (see decisions D-006):

- **Deterministic (hard, in core):** freshness, validation, transition legality,
  closure gating, retry/spawn counters. Enforced by code, independent of prompts.
- **Prompt-level (soft):** role boundaries, "don't edit X", "don't spawn". Only
  as strong as the platform's permission system; adapters map them to native
  permissions where available (e.g. OpenCode tool/permission config), otherwise
  documented as prompt-only.

## 7. Platform adapter boundary

An adapter may: register agents/commands, map permissions, run the core CLI,
and present status. An adapter may **not**: reimplement freshness, validation,
or task-state logic (must call the core); or assume a platform feature without
verifying official documentation.

## 8. Failure handling

- **Missing file** → treat as `missing`; never crash.
- **Malformed metadata** → treat as `invalid`; do not auto-delete; report.
- **Interrupted write** → atomic write (temp file + rename); a leftover temp is
  ignored, never treated as authoritative.
- **Git error / not a repo** → fall back to hash+mtime; record limitation.
