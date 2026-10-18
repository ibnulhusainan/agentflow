# Workflow — Cross-Platform AI Agent Workflow

Status: proposed (Task 1). Consistent with `requirements.md`, `architecture.md`,
`decisions.md`, `acceptance-criteria.md`.

## 1. Roles and boundaries

| Role | Owns | May read | Must not |
|------|------|----------|----------|
| Analyzer | `knowledge/` | repo, Git, config | implement app code; edit `plan.md`/`progress.json`; spawn agents |
| Planner | `plan.md` | index, knowledge, request | implement app code; edit knowledge; silently expand scope |
| Executor | implementation, `progress.json`, `result.md` | approved plan, trusted knowledge | edit knowledge directly; spawn agents; proceed past a stopping discrepancy |
| Reviewer | `discrepancies.md`, verification findings | plan, result, code | edit source; edit plan |
| Consultant | recommendations (read-only) | knowledge, plan, code | write artifacts (except its own notes) |
| Conductor | lifecycle, `manifest.md`, delegation | everything | implement; bypass a deterministic gate |

No role may spawn agents unless the platform actually permits it and the
approved contract allows it; the core enforces a persisted spawn-depth limit
regardless.

## 2. Lifecycle state machine

```
 pending ──start──► in_progress ──block──► blocked
    ▲                   │  ▲                  │
    │                   │  └────resolve───────┘
    │                   │
    │              verify─┘                     
    │                   ▼
    │                review ──pass──► completed
    │                   │  │
    │                   │  └──fail──► in_progress
    └────reopen─────────┘
```

Allowed transitions (enforced by core `task transition`):

- `pending → in_progress`
- `in_progress → blocked | review | in_progress` (retry within limit)
- `blocked → in_progress` (requires resolution note) or `blocked → review` when
  workaround applied
- `review → completed` (only if closure gates pass) or `review → in_progress`
  (verification failed)
- `completed → reopened` (creates a new task state; history preserved)

Illegal transitions (e.g. `pending → completed`) are rejected with a non-zero
exit code.

## 3. Main flow

The Conductor is the *orchestrated* path, not a requirement. Any role may be
invoked directly by a person; the record is created by the core (`task new`) and
its id is discoverable (`task current`, `task list`, `--task current`). Steps
below name the owning role for clarity, not as a precondition.

1. **Intake (Conductor, or you).** Record the request with
   `task new --request <text> --files <n>`; classify task size (§4).
2. **Knowledge readiness.**
   - Small task: may skip knowledge; Executor confirms a bounded scope.
   - Medium/Complex: run core `status`; if required knowledge is
     `missing/stale/incomplete/invalid`, run **Analyzer** (scoped).
3. **Planning.**
   - Small: bypass (Executor proceeds).
   - Medium/Complex: **Planner** produces `plan.md` with testable items and
     dependencies; core `validate` checks it.
4. **Execution.** Executor works items in dependency order, updating
   `progress.json` and `next_action`. Retry counter increments per failed
   attempt; at the limit the item/task goes `blocked`.
5. **Verification gate.** Core `task close` checks: all items `done` (or
   explicitly `skipped` with justification), required verification commands
   passed, no open `blocker`-severity discrepancy, counters within limits.
6. **Review (optional).** Reviewer checks result vs acceptance criteria.
7. **Closure / reopen.** On pass → `completed` + `result.md`. On reopen → new
   state, history intact.

## 4. Small-task bypass rules (FR-4)

Bypass planning only if ALL hold: ≤ threshold files (default 3), single logical
change, no data/API/schema change, acceptance is directly testable, no new
knowledge dependency. Otherwise planning is required (FR-5). The core returns
`plan_required: true/false` from `task classify`.

## 5. Trust rules, tripwire, discrepancies (FR-8)

- **Trust by default.** Approved plans and `fresh` knowledge are trusted without
  re-derivation.
- **Tripwire.** Before using a trusted knowledge artifact, Compare its declared
  `revision` to the current one cheaply (hash/mtime or Git). A mismatch is a
  concrete discrepancy — not a reason to rescan the repo.
- **Discrepancy handling.** Executor records evidence + affected scope in
  `discrepancies.md`, marks the item `blocked`, and stops only the affected
  work. It does not trigger a repository-wide rescan (FR-13/Task 4 §7).
- **Resolution.** Only the owning role (Analyzer for knowledge, Planner for plan)
  resolves a discrepancy for its artifact; the Conductor reopens the task.

## 6. Retry and spawning limits (FR-7)

- **Per-item attempts:** default `max_attempts = 3`. Exceeded → item `blocked`,
  task `blocked`, report to user.
- **Spawn depth:** default `max_depth = 1`; **max children per task = 0** for
  Executor (no recursive delegation). Enforced via persisted counters in
  `state.json`, not by prompt text.
- On repeated failure the workflow stops and reports the cause (README §3).

## 7. Verification gates (FR-12)

A task cannot be closed unless: deliverables exist, acceptance criteria checked,
focused tests/validation ran and passed, actual results recorded, and known
limitations documented. No fabricated results (README §5). Closure with missing
or failed verification returns a non-zero exit code.

## 8. Token-efficiency rules (FR-9, FR-15, FR-16)

- One task per session where practical.
- **Resume in one call.** A (resumed) session starts with core
  `context --task <id>`: status, `next_action`, the referenced plan item
  (paths / knowledge refs / completion criterion), counters, open
  discrepancies, and budget state in a single payload. Re-reading
  `state.json` + `progress.json` + `plan.json` + `config.json` separately for
  the same information is not allowed.
- Read the index, then only referenced artifacts; never rescan the repo for a
  known fact.
- **No re-read to verify.** A file the agent just wrote is not re-read to check
  it; the write plus the tripwire is the evidence. Trusted artifacts are
  checked by comparing `revision`, not by re-reading content.
- **Batch independent tool calls** (parallel reads/globs) instead of running
  them serially; cap tool output and report size.
- **Record usage per item** with core `usage add` at item completion and at
  handoff. `usage check` compares against `config.budget`; exceeding a ceiling
  exits non-zero, and `close` is rejected while any recorded item exceeds its
  budget (gate: `budget.enforce_on_close`).
- Handoffs are pointers + short summary; full content stays in artifacts.
- Report concisely; avoid repeating already-documented analysis unless the
  tripwire fires.

## 9. Platform-independent vs platform-specific

Everything in §1–§8 and §10 is platform-independent and lives in the core. Only
the following are platform-specific and belong to adapters: how agents are
registered/selected, how permissions are enforced, how commands/hooks invoke
the core, how status is surfaced, and any per-request message selection
(context filter). If a platform cannot enforce a boundary, the adapter
documents it as prompt-only (no false guarantees).

## 10. Session & context policy (FR-16)

Goal: keep the context sent to the model small **without** breaking the prompt
cache or dropping decisions later work depends on. The unit of continuity is
the **plan item**, not chat history.

**Session lifecycle — default: one plan item = one session.**

| Condition | Action |
|-----------|--------|
| Item small, independent, verification passed | close session; next item starts a new session |
| Next item tightly coupled, context still healthy | may continue in the same session |
| Complex item (cross-module, unknown scope) | keep the session while healthy; write handoff **before** switching |
| Context near `context.compact_at_percent` of `context.max_context_tokens` | stop, hand off via `progress.next_action`, start a new session |
| Item failed or unfinished | record status + blocker (discrepancy, `usage add`, `next_action`) **before** switching |

**Rules:**

1. **One verifiable unit per session.** The unit is defined by `plan.json`
   (`completion_criterion` + `paths`), not by file count. Too small → startup
   overhead (re-reading the contract and files) exceeds the actual work; too
   large → context bloat returns.
2. **State lives in files, never in chat.** `plan.json` item statuses,
   `progress.next_action`, `state.json` counters, `usage.json`. The next
   session reads these — never the previous conversation.
3. **Escalation over improvisation.** If the executor finds the contract
   (plan/knowledge) wrong or insufficient: stop, record a discrepancy, report.
   The owning role fixes it, then execution resumes. This is what keeps items
   1–4 from silently diverging in assumption from items 5–10.
4. **Review checkpoint.** After the core items pass — and occasionally after —
   run the full verification set and inspect the diff before continuing.
   Errors that pass early get copied by later sessions, because the executor
   treats existing code as the pattern.
5. **Cache stability across sessions.** Consecutive sessions share prompt
   cache only when the prefix is identical and the gap is short: keep the
   stable part of the prompt (role, contract, task bundle) at the front and
   don't idle long between sessions.
6. **Cut tool output before cutting messages.** Old tool results are the
   largest share of a coding session's context; drop or replace them with a
   short placeholder first. Never drop a tool call without its result (or a
   result without its call) — the API rejects or misbehaves.
7. **Cut per batch, not per request.** Trimming the oldest message on every
   request changes the prefix and destroys prompt caching, so a smaller
   context can cost more than a larger cached one. Trim at session/item
   boundaries only.
8. **Measure before enabling any filter.** A platform context filter (adapter,
   §9) must be justified by measured composition (system prompt vs messages vs
   tool output per request) and A/B'd on equal-outcome tasks — token/request
   savings that coincide with failing verification are not savings.
