# Requirements — Cross-Platform AI Agent Workflow

Status: proposed (Task 1). Source: `tasks/TASK-1.md`. Must stay consistent with
`architecture.md`, `workflow.md`, `decisions.md`, `acceptance-criteria.md`.

## 1. Purpose

A token-efficient, persistent, platform-independent workflow that lets AI coding
agents (Analyzer, Planner, Executor) cooperate on a repository while reusing
knowledge, persisting state outside chat history, and enforcing deterministic
gates. The core must run without any specific AI editor and be adaptable to
OpenCode, Cursor, and similar tools.

## 2. Functional requirements (mandatory)

| ID | Requirement | Notes |
|----|-------------|-------|
| FR-1 | Reuse existing knowledge before new analysis. | Check index first; never re-analyze fresh scopes. |
| FR-2 | Classify knowledge as `missing`, `fresh`, `stale`, `incomplete`, `invalid`. | Deterministic classification (see `architecture.md` §5). |
| FR-3 | Support scoped incremental analysis. | Invalidate only knowledge intersecting changed paths. |
| FR-4 | Allow small, clearly bounded tasks to bypass planning. | Threshold-driven (see §4). |
| FR-5 | Require an approved plan for complex/cross-file tasks. | Orchestrator enforces. |
| FR-6 | Persist task state outside conversation history. | File-based under `.agent/`. |
| FR-7 | Prevent uncontrolled agent spawning and retry loops. | Persisted counters + depth limits. |
| FR-8 | Define trust rules, discrepancy reporting, verification gates, scope boundaries. | See `workflow.md`. |
| FR-9 | Minimize context, repeated reads, oversized output, model calls. | See §5. |
| FR-10 | Keep the core independent of editor/model provider. | No platform APIs in core. |
| FR-11 | Validate task files, plan items, dependencies, and state transitions. | CLI `validate`. |
| FR-12 | Reject closure when verification is missing or failed. | CLI `task close`. |
| FR-13 | Emit concise machine-readable output for humans and adapters. | JSON + text modes. |
| FR-14 | Handle missing/malformed files, interrupted writes, and Git errors safely. | Atomic writes; graceful Git absence. |
| FR-15 | Enforce a per-item usage budget (requests + input/output tokens). | CLI `usage add`/`usage check`; enforced by `close` when `budget.enforce_on_close`. |
| FR-16 | Provide a minimal one-call resume context per task/item. | CLI `context`; session policy in `workflow.md` §10. |

## 3. Non-functional requirements

- **Token efficiency (NFR-1):** a normal "resume" reads the index + targeted
  knowledge only, never the whole repo.
- **Determinism (NFR-2):** freshness, validation, and transitions are computed by
  scripts, not by LLM judgement.
- **Portability (NFR-3):** core has zero external runtime dependencies; runs on
  Node.js (bundled where the target editors run).
- **Safety (NFR-4):** atomic file writes; no destructive operations; never close
  an unverified task.
- **Testability (NFR-5):** core logic covered by automated tests for valid and
  invalid transitions, freshness, partial completion, failure handling.
- **Auditability (NFR-6):** meaningful decisions and discrepancies recorded; not
  every trivial action.

## 4. Task-size policy (configurable)

| Class | Criteria (default, override in config) | Planning |
|-------|----------------------------------------|----------|
| Small | ≤ 1 logical change, ≤ 3 files, no cross-module/data-contract change, clear acceptance | May bypass Planner |
| Medium | 4–15 files or one module | Plan required |
| Complex | > 15 files, cross-module, data/API/schema change, or unknown scope | Plan + knowledge readiness required |

Thresholds are user configuration, never hard-coded policy in the core.

## 5. Efficiency requirements

- Read the knowledge **index** first; open only referenced artifacts.
- Reference knowledge by **heading anchor**, not line numbers.
- Prefer machine-generated **facts** over LLM re-derivation.
- Handoffs carry **pointers** (artifact paths), not full reports.
- Cap tool output size and re-reads; a "trusted" prior result is not re-read
  unless a defined trigger fires.
- Resume from **one** `context` payload instead of opening several task
  artifacts that restate the same information (FR-16).
- Every plan item's spend is **recorded** (`usage add`) and **checked**
  (`usage check`) against `config.budget`; a session over budget stops the
  affected item and hands off instead of continuing (FR-15).
- Context sent to the model is bounded by `config.context` and trimmed at
  **item/session boundaries** only — never per request, which would break
  prompt caching (see `workflow.md` §10).

## 6. Out of scope (this specification phase)

- No implementation code (Task 1 constraint).
- No runtime, adapters, or agent prompts yet.
- No database, server, queue, or always-on service.
- No security guarantee that the platform does not actually enforce (prompt text
  is not a hard boundary — see `decisions.md` D-006).

## 7. Assumptions

- Repositories are file-based and (normally) under Git.
- A coding agent platform can run shell commands and read/write files.
- The user or Conductor selects the active task and role.

## 8. Open questions (require user decision)

- Q-1: Confirm the primary platform order for adapters (Task 5 suggests
  OpenCode first). **Assumed: OpenCode, then Cursor.**
- Q-2: This repository is currently **not a Git repo**. FR-3/Freshness rely on
  Git for change detection. Acceptable fallback: content-hash + mtime scoped
  invalidation. **Assume fallback is acceptable; confirm before Task 6.**
- Q-3: Confirm Node.js zero-dependency core (see D-001) vs Python.
