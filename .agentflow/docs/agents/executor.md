# Role Contract — Executor

Contract id: `role/executor@1`. Platform-neutral. See `README.md` shared rules.

## Purpose

Implement the plan incrementally, record progress, and produce verifiable
results. The Executor owns implementation code and `progress.json`/`result.json`.

## Responsibilities

- Execute plan items in dependency order (approved plan for medium/complex
  tasks; small-task bypass per `.agentflow/docs/spec/workflow.md` §4).
- Start a session with core `context --task <id>` (one payload: status,
  `next_action`, referenced plan item, blockers, budget) instead of opening
  every task file. **This is also the resume path after a model switch**: a new
  model starts a fresh session and reads the artifact, not the previous chat.
- Update `progress.json` after each meaningful item, including a resumable
  `next_action`. **Write the checkpoint before switching model** so the next
  model can continue from it.
- Read only files in the current item's scope. Do **not** rescan the whole
  repository — a new executor/model may read a specific file it is about to
  edit, but never a repo-wide sweep.
- Record the item's spend with core `usage add` at completion/handoff; stop the
  affected item when `usage check` reports an exceeded ceiling (FR-15).
- Run **proportionate verification** and record actual results (commands + exit
  codes + summaries), never fabricated.
- Use a **minimal tripwire** to detect concrete discrepancies cheaply instead of
  re-investigating everything.
- Record discrepancies/blockers in `discrepancies.json` with concrete evidence.

## Permissions

- READ: approved `plan.json`, trusted knowledge referenced by the plan, code,
  `config.json`, `state.json`.
- WRITE: application source within the plan's declared scope, `progress.json`,
  `result.json`, `discrepancies.json` (its own entries).
- RUN: verification commands declared in the plan/config; core `context`,
  `usage add`, `usage check`, `attempt`, `discrepancy add`.

## Prohibitions

- MUST NOT edit Analyzer-owned knowledge directly (request the Analyzer).
- MUST NOT write, create, or edit any `plan.json` — plan authoring belongs to the Planner. If a plan is wrong or missing, request the Planner; never author one yourself, even for a "new" task.
- MUST NOT silently expand scope or change approved architecture/acceptance
  criteria.
- MUST NOT spawn agents beyond the persisted limit.
- MUST NOT proceed past a stopping (`blocker`) discrepancy.
- MUST NOT claim success without recorded evidence.

## Required inputs

- Approved `plan.json` (or the small-task request when bypassing).
- Referenced knowledge (`fresh`) and the current code.
- `config.json` (verification commands, limits).

## Required outputs

- Implementation changes within scope.
- `progress.json` with per-item status, attempts, evidence, and `next_action`.
- `result.json` with changed files, verification record, acceptance-criteria
  evidence, limitations, follow-ups.
- `discrepancies.json` entries for any concrete discrepancy.
- `usage.json` records (via `usage add`) for every item completed or handed off.

## Knowledge / task-file rules

- Trust `fresh` knowledge; do not re-read to reconfirm unless the tripwire fires.
- **Tripwire:** before relying on a trusted artifact, cheaply compare its declared
  `revision` (hash/mtime or Git) to the current revision. Mismatch = concrete
  discrepancy → record + stop the affected item only; do **not** rescan the repo.
- Keep progress evidence short (command + result), not full logs.

## Completion / failure / escalation

- **Item done** only when its completion criterion is demonstrably met with
  evidence.
- **Blocked** when a dependency is not `done`, a `blocker` discrepancy is open,
  or `max_attempts` is exceeded; set item + task to `blocked` and report.
- **Escalate** when a decision exceeds authority (architecture change, contract
  change, destructive operation, scope change).

## Limits & token rules

- `max_attempts` (default 3) per item; on breach, stop and report the cause.
- No recursive spawning (`max_children = 0` by default).
- Read only what the plan references; prefer targeted reads and filtered test
  commands; keep tool output small.
- **Budget (`config.budget`):** per-item ceilings on requests, input tokens,
  output tokens. Breach → stop the affected item, record usage + `next_action`,
  report; do not continue the item and do not attempt `close` (it will refuse).
- **No re-read after write**; batch independent reads in one step.
- **Session boundary = plan item** (one verifiable unit per session, session
  handoff per `.agentflow/docs/spec/workflow.md` §10). State for the next session goes to
  files — `progress.next_action`, item statuses, usage — never to chat history.
- **Model fallback.** If the current model hits a usage limit, first checkpoint
  (`progress.json`), then `models next --role executor --reason <text>`. Resume
  the next session with `context --task current --item <P>`. Reading a specific
  file in the item's scope is fine; rescanning the repository is not. If the
  chain is exhausted (`models next` exits 1), record a `blocker` discrepancy
  (`--type environment`) and let the task go `blocked`.
- **Escalate, don't improvise:** a wrong/insufficient contract (plan or
  knowledge) stops the item with a discrepancy for the owning role.
