# Agent Role Contracts — Shared Contract

Status: proposed (Task 3). Inputs: `.agentflow/docs/spec/*`, `.agentflow/docs/contracts/*`. This is the
single, platform-neutral source of role definitions. Platform adapters (Task 5)
and agent configs are **derived** from these files; they must not fork
role behavior.

## Roles

| Role | Owns | Contract |
|------|------|----------|
| Analyzer | `knowledge/` | `analyzer.md` |
| Planner | `plan.json` | `planner.md` |
| Executor | implementation, `progress.json`, `result.json` | `executor.md` |
| Reviewer | `discrepancies.json`, verification findings | `reviewer.md` |
| Consultant | recommendations (read-only) | `consultant.md` |
| Conductor | lifecycle, `manifest.md`, delegation | `conductor.md` |

## Shared rules (all roles)

0. **Roles work standalone.** No role requires the Conductor to have run. The
   task record belongs to the core (`task new`), never to a role, and its ID is
   discoverable (`task current`, `task list`, `--task current`). A role that
   finds the record missing creates it and continues; it does not report
   "blocked" over missing bookkeeping. Manual operation — one role per session,
   driven by a person — is a first-class way to use this workflow.
1. **One task per session** where practical; read only the active task and the
   knowledge/plan it references. A (resumed) session starts from core
   `context --task current` — one payload instead of re-opening every task file.
2. **Read the index first.** Never rescan the repository for a known, `fresh`
   fact. Trust `fresh` knowledge and `approved` plans by default. A specific
   file in the current item's scope may be read; a repo-wide sweep may not —
   **including after a model switch** (see executor contract).
3. **No uncontrolled spawning, recursive delegation, or retry loops.** Honors
   persisted limits in `state.json` (`max_attempts`, `max_spawn_depth`,
   `max_children`). Defaults: 3 / 1 / 0.
4. **No claim of success without evidence.** Record commands + observed results.
5. **Scope stays within the task's declared scope.** Do not silently expand.
6. **Artifacts are the handoff.** Chat carries pointers + short summaries; full
   content lives in files. Reports are concise (README §3).
7. **Do not store secrets** or copy large source excerpts into artifacts.
8. **References use `path#Heading`**, never line numbers.
9. **Stop and report** when blocked by a decision outside the role's authority
   (see README §7 approval boundaries). Do not guess.
10. **Distinguish enforced vs prompt-only** permissions; never claim a boundary
    the platform does not actually enforce.
11. **Stay inside the usage budget.** The role that performs work records it
    (`usage add --task <id> --item <P>` at item completion/handoff) and checks
    it (`usage check`). Over a `config.budget` ceiling → stop the affected item,
    hand off, report; `close` refuses until it fits (`workflow.md` §8, FR-15).
12. **No re-reading to verify.** Do not re-read a file you just wrote, or
    re-open a trusted artifact to reconfirm it — compare `revision` instead
    (`workflow.md` §8).

## Enforcement reality (honest)

| Boundary | Enforceable by | Strength |
|----------|----------------|----------|
| Freshness / validation / transitions / closure / counters | core code (Task 4) | **hard** |
| Usage budget (requests + input/output tokens per item) | core code (`usage check`, `close` gate); numbers self-reported by the agent | **hard gate on self-reported data** |
| "Analyzer does not edit source", "Executor does not edit knowledge" | platform permissions if available, else prompt text | **soft** on platforms without per-tool/path permissions |
| No recursive spawning | prompt text + persisted counter credited by core | soft (core detects/limits recorded spawns, but cannot prevent an unrecorded spawn) |

Adapters document the actual strength per platform (Task 5 capability matrix).

## Handoff protocol

A handoff passes: `task_id`, role from → to, artifact path(s) to read, the exact
next action, and any open blocker IDs. Nothing else. Example:

```
T-20261016-001  planner→executor
read: .agent/tasks/T-20261016-001/plan.json, .agent/knowledge/notes/n-cli.md#Verified facts
next: execute P2
blockers: none
```

Prefer handing off with `context --task <id> [--item <P>]`, which returns the
same fields (status, `next_action`, plan item, counters, blockers, budget) in
one payload; the file paths above remain the authoritative sources it reads.

## Custom agents

Core roles (consultant, conductor, analyzer, planner, executor, reviewer) are
**locked**: their keys must stay in `config.json` and cannot be renamed or
removed. Only their `agent`, `enabled`, and `order` fields are editable.

To add a custom agent (spawnable, not a workflow step):

1. Pick a unique name, e.g. `my-reviewer`.
2. Add an entry to `.agent/config.json` under `agents`:
   ```json
   "my-reviewer": { "agent": "my-reviewer", "order": 6, "enabled": true }
   ```
3. Create the agent file for each platform you use:
   - OpenCode: `.opencode/agents/my-reviewer.md`
   - Cursor: `.cursor/agents/my-reviewer.md`
   Follow the frontmatter format of an existing agent (description, mode,
   permission, etc.) and point its contract at the agents contracts directory if
   applicable.
4. Verify it is recognized: `node .agentflow/cli.mjs agent list` and
   `node .agentflow/cli.mjs agent check my-reviewer` (exit 0 = enabled + file present).
5. Disable without deleting: set `"enabled": false` in config. Spawn attempts
   will then fail with a clear message.

To rename an agent's display name without breaking the workflow: keep the
role key, change only the `agent` field and rename the `.md` file to match.

To rename a core role key itself (e.g. `executor` → `implementor`) is **not**
supported — core orchestration references these keys. Use the `agent` field
instead.
