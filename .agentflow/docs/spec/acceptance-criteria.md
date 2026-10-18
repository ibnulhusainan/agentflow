# Acceptance Criteria — Cross-Platform AI Agent Workflow

Status: proposed (Task 1). These criteria gate each task; a task is `completed`
only when its criteria are checked with recorded evidence (README §5).

## Global (all tasks)
- G-1 Deliverables exist at the specified paths.
- G-2 Outputs are consistent with `requirements.md` and `architecture.md`.
- G-3 No fabricated results, metrics, or guarantees; limitations documented.
- G-4 No application/business source modified; no destructive operations.
- G-5 Reports are concise; context/token rules respected.

## Task 1 — Specification
- AC1.1 `.agentflow/docs/spec/{requirements,architecture,workflow,decisions,acceptance-criteria}.md` exist.
- AC1.2 Mandatory vs optional features are separated.
- AC1.3 Unresolved decisions and trade-offs are explicit.
- AC1.4 No implementation code produced.
- AC1.5 Requirements map to the 10 core requirements in `TASK-1.md`.

## Task 2 — Artifact contracts
- AC2.1 Templates/schemas exist under `.agentflow/docs/contracts/` for: knowledge index,
  facts, analysis, plan, progress, discrepancy, result, status/freshness metadata.
- AC2.2 Each schema lists required fields and allowed status transitions.
- AC2.3 Representative **valid and invalid** examples included for each.
- AC2.4 References use heading anchors; no large source excerpts or secrets.
- AC2.5 Interrupted-write detection and resume rules documented.
- AC2.6 Validated against the Task 1 specification; inconsistencies reported.

## Task 3 — Role contracts
- AC3.1 One contract per role under `.agentflow/docs/agents/` (Analyzer, Planner, Executor)
  plus a shared contract.
- AC3.2 Each defines ownership, allowed reads, prohibitions, outputs, and stop/
  escalate conditions matching the artifact schemas.
- AC3.3 Permissions that prompts alone cannot enforce are explicitly flagged.
- AC3.4 No runtime/adapters built.

## Task 4 — Core
- AC4.1 Core inspects the index and reports `missing|fresh|stale|incomplete|invalid`.
- AC4.2 Scoped change detection (Git, with hash/mtime fallback) invalidates only
  affected knowledge.
- AC4.3 `validate` checks task files, fields, item IDs, dependencies, transitions.
- AC4.4 Closure is rejected when verification missing/failed.
- AC4.5 Retry and spawn limits enforced via persisted state.
- AC4.6 Discrepancy/blocker recorded without repo-wide rescan.
- AC4.7 Output is concise and machine-readable (JSON) and human-readable.
- AC4.8 Automated tests cover valid/invalid transitions, freshness, partial
  completion, failure handling, and pass (`node --test`).
- AC4.9 Install/invocation/exit codes documented; malformed/missing/Git-error
  inputs handled safely; writes atomic.

## Task 5 — Platform adapter(s)
- AC5.1 Capability matrix per platform (enforced / partial / manual / unsupported).
- AC5.2 Adapter uses documented platform features only; no invented APIs.
- AC5.3 No duplication of core freshness/validation/state logic.
- AC5.4 Installation/config/permissions/limitations documented.
- AC5.5 Focused tests + one end-to-end example; core unchanged.

## Task 6 — End-to-end validation
- AC6.1 All 12 scenarios in `TASK-6.md` exercised, each with an observed result.
- AC6.2 Real metrics recorded where the platform exposes them; none invented.
- AC6.3 Known failure modes and a prioritized fix list produced.
- AC6.4 No acceptance criterion silently weakened to force a pass.

## Task 7 — Reusable packaging
- AC7.1 User config separated from defaults; minimal setup command or documented
  manual setup; dry-run available.
- AC7.2 Repo-specific exclusions/conventions/verification/thresholds supported.
- AC7.3 Schema upgrade/migration documented; adapters optional.
- AC7.4 Examples for small/medium/complex tasks; troubleshooting/recovery docs.
- AC7.5 Permission-boundary guarantees vs limitations documented exactly.
- AC7.6 Verified clean install in a fresh sample repo; full relevant tests pass.

## Task 8 — Custom agent modes
- AC8.1 Platform compatibility audit for OpenCode and Cursor (documented sources).
- AC8.2 Canonical, platform-neutral role specs for consultant, analyzer, planner,
  executor, reviewer, conductor (each with responsibilities, permissions,
  inputs, required outputs, completion/failure/escalation, retry & token rules).
- AC8.3 One source of role definitions; platform adapters/config derived from it.
- AC8.4 Only roles supported by the platform are registered as selectable
  primary agents; switcher uses native mechanisms only.
- AC8.5 Roles that can only be subagents/prompts are explicitly documented.
- AC8.6 Validation: correct permissions, no cross-role work without delegation,
  reads existing artifacts before re-exploring, resumable status, no false
  permission-enforcement claims.
- AC8.7 No platform-specific duplication causing divergent behavior.
