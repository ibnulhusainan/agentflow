# Execution Manifest — Cross-Platform AI Agent Workflow

Source of truth: `tasks/README.md`, `tasks/TASK-1..9.md`.
Roles per README §4: Analyzer (knowledge), Planner (plans), Executor (implementation), Reviewer, Consultant, Conductor.
Agent executing: Artisan (Executor role). Board: `.opencode/boards/artisan/open-cross-platform-agent-workflow.md`.

## Environment (baseline)

- Repo state: **not a Git repo** at start. Only `tasks/` and `.opencode/boards/` existed. No `docs/`, no source code.
- No existing user changes to preserve (fresh working tree).
- Languages available: Node.js (bundled with OpenCode), Python 3. Core will be **Node.js, zero external deps** (rationale in `.agentflow/docs/spec/decisions.md`).
- No application source code exists in this repo; all creation is greenfield workflow tooling.

## Task table

| ID | Source | Status | Depends on | Deliverables | Evidence | Next action |
|----|--------|--------|-----------|--------------|----------|-------------|
| T1 | tasks/TASK-1.md | completed | — | .agentflow/docs/spec/{requirements,architecture,workflow,decisions,acceptance-criteria}.md | 5 files created | none |
| T2 | tasks/TASK-2.md | completed | T1 | .agentflow/docs/contracts/{README,statuses}.md, schemas/, templates/, examples/ | 21 JSON parse OK; required-field check OK (15 artifacts) | none |
| T3 | tasks/TASK-3.md | completed | T1,T2 | .agentflow/docs/agents/{README,analyzer,planner,executor}.md | cross-checked vs schemas | none |
| T4 | tasks/TASK-4.md | completed | T1–T3 | .agentflow/{cli.mjs,lib/*,schema/*,test/*,README.md} | 48 tests pass (`node --test`) | none |
| T5 | tasks/TASK-5.md | in_progress | T4 | adapters/opencode, adapters/cursor | capability matrix | research + implement |
| T6 | tasks/TASK-6.md | pending | T5 | docs/validation/test-report.md | 12 scenarios | after T5 |
| T7 | tasks/TASK-7.md | pending | T6 | docs/guides/*, init/dry-run | clean install in sample repo | after T6 |
| T8 | tasks/TASK-8.md | pending | T4,T5 | agents/ canonical + platform config | validation | after T5/T7 |
| T9 | tasks/TASK-9.md | in_progress | T4 | budget/context in core (`usage`, `context`, close gate), `usage.json` schema+template, docs (§8/§10, FR-15/FR-16, roles), TASK-9 tests, adapter usage-report | 59 tests pass (`node --test`); schema copies byte-identical | adapter `usage-report.mjs` + final verification |

## Approval boundaries (README §7)

Stop and ask user when: requirements conflict, architecture changes, destructive/external operation, insufficient credentials, platform limitation needs meaningful alternative, acceptance criteria cannot be met within retry limit.

## Decisions log (append-only, meaningful only)

- D-001 (T1): Core implemented in Node.js, zero external dependencies. Rationale: OpenCode ships Node; Cursor environment has Node; avoids install friction and satisfies "least complex implementation".
- D-002 (T1): Workflow state stored as files under `.agent/` (plain Markdown/JSON), no database/server.
- D-003 (T1): Platform adapters are thin; all freshness/validation/state logic lives in core CLI.

## Blockers

- None yet. (Note: repo is not a Git repo; Task 4 requires Git-based change detection. Core will degrade gracefully when Git is unavailable and this will be recorded as a limitation. Confirmed by user before implementation if it blocks T4.)
