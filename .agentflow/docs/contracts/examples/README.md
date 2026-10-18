# Contract Examples

Status: proposed (Task 2). Validated against `.agentflow/docs/spec/*` and
`.agentflow/docs/contracts/schemas/agentflow.schema.json`.

## valid/

A coherent, internally consistent task set for `T-20261016-001` (medium task that
required a plan). Every file passes schema validation and semantic checks.

| File | Artifact | Notes |
|------|----------|-------|
| `task.md` | task file | required H2 headings present |
| `plan.json` | plan | approved, items P1(done) P2(todo), dependency P2→P1 resolves |
| `progress.json` | progress | resumable `next_action` for P2 |
| `state.json` | state | `in_progress`, counters within limits |
| `discrepancies.json` | discrepancies | empty list |
| `result.json` | result | completed, verification passed, all AC met |
| `index.json` | knowledge index | one facts + one analysis entry, both `fresh` |
| `facts.json` | machine facts | deterministic `data` block |
| `n-cli.md` | analysis note | all required H2 headings, anchor refs only |

## invalid/

Each file violates exactly one documented rule. Expected detection is by the
Task 4 validator / schema.

| File | Violation | Rule |
|------|-----------|------|
| `plan-dangling-dependency.json` | `P1.depends_on = ["P9"]` where P9 does not exist | dependency integrity |
| `plan-bad-item-id.json` | item id `item-1` | ID pattern `^P[0-9]+(\.[0-9]+)*$` |
| `state-illegal-transition.json` | history `pending → completed` | allowed transitions (`statuses.md` §4) |
| `index-bad-knowledge-status.json` | knowledge `status: "ok"` | knowledge status enum |
| `result-closure-rejected.json` | `status: completed` with `verification.passed=false` and unmet AC | closure gates (`statuses.md` §6) |
| `progress-no-next-action.json` | missing `next_action` | resume contract (schema required field) |
| `note-missing-headings.md` | missing required H2 headings; uses line-number reference | Markdown contract |

## How to use

- Copy `templates/*` as starting points; they contain placeholders.
- Compare against `valid/` for a fully filled, consistent set.
- Use `invalid/` as fixtures for the Task 4 validator tests.
