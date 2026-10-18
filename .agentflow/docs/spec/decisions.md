# Decisions & Trade-offs — Cross-Platform AI Agent Workflow

Status: proposed (Task 1). Each decision: context, decision, alternatives,
consequences, status.

## D-001 Core language: Node.js, zero external dependencies
- **Context:** core must be deterministic, portable, and run where target editors
  run (OpenCode ships Node; Cursor uses a Node-based CLI).
- **Decision:** implement the core in plain Node.js (ESM, `node:` built-ins only);
  tests via built-in `node --test`.
- **Alternatives:** Python 3 (also common), TypeScript (build step), Go/Rust
  (extra toolchain).
- **Consequences:** no install step, no dependency drift; requires Node in the
  environment (acceptable). Slightly less type safety (mitigated by JSDoc).
- **Status:** proposed — confirm (requirements Q-3).

## D-002 File-based state, no database/server
- **Context:** FR-6, FR-14; Task 4 forbids a DB/service unless justified.
- **Decision:** all state in `.agent/` as Markdown/JSON; core is a stateless CLI
  over these files.
- **Alternatives:** SQLite, a daemon, index service.
- **Consequences:** trivially portable and auditable; concurrency handled by
  atomic writes + single-writer assumption. No cross-process locking (documented
  limitation; per-session single writer is the norm).
- **Status:** accepted.

## D-003 Thin adapters, single source of truth in core
- **Context:** Task 5 forbids duplicating freshness/validation/state logic.
- **Decision:** adapters only register agents/commands, map permissions, and call
  the core CLI; shared artifact formats are unchanged by adapters.
- **Alternatives:** per-platform logic for better ergonomics.
- **Consequences:** consistent behavior across platforms; adapters may feel
  minimal, but that is intended.
- **Status:** accepted.

## D-004 Knowledge split: machine facts vs. LLM analysis
- **Context:** FR-1, FR-9; Task 2 requires separation.
- **Decision:** `knowledge/facts/*.json` are deterministic, regenerable, and
  cheap; `knowledge/notes/*.md` are LLM-authored and reference facts by heading.
- **Consequences:** reduces model tokens and hallucination; analysis stays
  concise and links to facts.
- **Status:** accepted.

## D-005 Heading anchors, not line numbers
- **Context:** Task 2 requirement; line numbers are fragile.
- **Decision:** knowledge references use `path#Heading` anchors.
- **Status:** accepted.

## D-006 Enforcement is layered; prompts are not security boundaries
- **Context:** Task 5/8 warn against assuming prompts enforce permissions.
- **Decision:** distinguish **deterministic** enforcement (core code: freshness,
  transitions, closure, counters) from **prompt-level** boundaries (role scope).
  Adapters map prompt-level rules to native permissions where verified, else
  document them as prompt-only.
- **Consequences:** honest capability matrix; no fabricated guarantees.
- **Status:** accepted.

## D-007 Freshness fallback when Git is unavailable
- **Context:** this repo is not a Git repo; FR-3 needs change detection.
- **Decision:** prefer Git diff; fall back to content-hash + mtime over `scope`
  globs when Git is absent/errors.
- **Consequences:** fallback is coarser for large repos but correct and safe.
- **Status:** provisional — confirm before Task 4/6 (Q-2).

## D-008 Retry/spawn limits persisted in task state
- **Context:** FR-7; must survive session boundaries.
- **Decision:** counters live in `state.json`, incremented by the core; defaults
  `max_attempts=3`, `max_spawn_depth=1`, `max_children=0`.
- **Status:** accepted.

## Explicit non-goals (avoid overengineering)
- No database, queue, server, or background daemon.
- No semantic search/embeddings unless later justified.
- No automatic repo-wide rescans on discrepancy.
- No plugin orchestration/model-rotation changes (Task 8 boundary).

## Mandatory vs. optional
- **Mandatory:** FR-1..FR-14, file contracts, core CLI, closure gating, retry/
  spawn limits, one adapter that satisfies the user's primary platform.
- **Optional/future:** additional adapters, embeddings-based search, UI dashboards,
  auto-generated CI integration, richer metrics dashboards.

## Unresolved questions
- Q-1 adapter order (assumed OpenCode → Cursor).
- Q-2 Git fallback acceptance.
- Q-3 Node vs Python core.
- Q-4 exact default numbers for small-task threshold and retry limits (proposed
  above; user-tunable).
