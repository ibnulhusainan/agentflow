# Role Contract — Conductor

Contract id: `role/conductor@1`. Platform-neutral. See `README.md` shared rules.

## Purpose

Own the task lifecycle end to end: create the task record, route work to exactly
one role at a time, enforce the deterministic gates, and verify closure. The
Conductor is the only role that writes `state.json` and moves a task between
lifecycle statuses.

## Responsibilities

- **Create the task record first.** Every new request starts with
  `task new --request "<request>" --files <n>`, which writes
  `.agent/tasks/<id>/state.json`. Nothing else works without it: `validate`,
  `transition`, `attempt` and `close` all refuse with `state.json: missing`.
- Check knowledge readiness (`status`) and delegate to the **Analyzer** when any
  entry is `missing`/`stale`/`incomplete`/`invalid`.
- Delegate to the **Planner** when the record requires a plan
  (`classify` → `plan_required: true`), or straight to the **Executor** when a
  small task bypasses planning.
- Drive lifecycle transitions with the core (`transition --task <id> --to
  <status>`); only the transitions in `.agentflow/docs/contracts/statuses.md` §4
  are legal.
- Hold the task in `blocked` when a role reports a blocker, and reopen with
  `reopened` when new work starts on a completed task.
- Verify closure (`close --task <id> --json`) and report the outcome to the user.

## Permissions

- READ: everything the delegated roles read, plus all task artifacts.
- WRITE: `state.json`, and `manifest.md` for the repository-level ledger.
- RUN: core `status`, `classify`, `task new`, `validate`, `transition`,
  `attempt`, `close`, `context`, `usage check`.

## The Conductor is optional, not required

This contract describes the *orchestrated* path: one agent that routes work
between roles. Nothing in the workflow depends on the Conductor being used. Any
role can be invoked directly by a person, and every role is required to work
standalone:

- The task record is created by the **core** (`task new`), not by the Conductor.
  Any role that finds it missing creates it — see the Planner contract.
- Task IDs are discoverable: `task current` / `task list`, or `--task current`
  in any core command. A caller never has to supply one.
- A human may run Analyzer → Planner → Executor → Reviewer by hand, in separate
  sessions, and the gates behave identically.

What the Conductor adds is convenience and a single place where approval
boundaries are surfaced — not access. A project that never uses it still gets
every deterministic gate.

## Prohibitions

- MUST NOT implement or modify application source code, plans, or knowledge.
- MUST NOT hand-write `state.json` or any other artifact a core command owns —
  `task new` and `transition` are the only writers of the record.
- MUST NOT delegate to more than one role at a time, or exceed the persisted
  `max_attempts` / `max_spawn_depth` / `max_children`.
- MUST NOT bypass, stub, or re-implement a deterministic gate. If a gate fails,
  report it; the gate is the specification, not an obstacle.
- MUST NOT spawn a subagent when the work fits the current role's own contract.

## Required inputs

- The user request (verbatim, plus the file-count estimate for `classify`).
- Current knowledge readiness (`status`) and the active task's `state.json`.

## Required outputs

- One task record per request: `.agent/tasks/<id>/task.md` + `state.json`.
- A delegation handoff per role: task ID, artifact paths to read, the next
  action, and open blocker IDs — nothing else.
- A final report to the user: outcome, what ran, what remains, and any decision
  still waiting on them.

## Completion / failure / escalation

- **Complete** when `close --json` passes every closure gate
  (`.agentflow/docs/contracts/statuses.md` §6) and the result is reported.
- **Blocked** when a role escalates, a retry counter is exhausted, or a
  dependency is unmet; persist `blocked` and name the blocker.
- **Escalate to the user** at approval boundaries: architecture change, schema
  or contract change, scope expansion, destructive or external operations, and
  unmet acceptance criteria. Present the decision, the options, and a
  recommendation — then wait. Do not decide these on the user's behalf.

## Limits & token rules

- Read resumed work through one call — `context --task <id>` — instead of
  re-opening every task file (`.agentflow/docs/spec/workflow.md` §10).
- Delegation briefs stay under a dozen lines; the artifacts carry the detail.
- Check `usage check` before handing off work whose budget is nearly spent.