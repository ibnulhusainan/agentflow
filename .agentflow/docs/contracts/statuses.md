# Statuses and Allowed Transitions

Status: proposed (Task 2). Enforced deterministically by the core (Task 4).

## 1. Knowledge status (`index.json` entries)

| Status | Meaning | Trigger |
|--------|---------|---------|
| `missing` | No entry for a required scope, or referenced file absent | index lookup / fs check |
| `invalid` | File present but fails parse/schema | JSON parse / schema validate |
| `incomplete` | Parseable but required fields/sections or dependency absent | schema + dependency check |
| `stale` | `revision` differs, a `depends_on` changed, or scope-relevant changes since `last_validated` | Git diff / content hash |
| `fresh` | Exists, valid, complete, and unchanged | otherwise |

Classification order (first match wins): missing → invalid → incomplete → stale → fresh.

Knowledge transitions:

```
missing ──analyze──► fresh | incomplete | invalid
incomplete ──complete──► fresh | invalid
stale ──revalidate──► fresh | incomplete | invalid
invalid ──repair──► fresh | incomplete
fresh ──change detected──► stale
```

## 2. Plan status (`plan.json.status`)

`draft → approved → superseded`. Only `approved` plans may be executed for
medium/complex tasks. `superseded` when a task is reopened with a new plan.

## 3. Plan item status (`plan.json.items[].status`, mirrored in `progress.json`)

`todo → in_progress → done | blocked | skipped`

- `in_progress → todo` is allowed when work is rolled back deliberately.
- `blocked` requires an open discrepancy or a dependency not `done`.
- `skipped` requires a justification string and is only allowed when the item is
  not required by the task's acceptance criteria.
- `done` requires evidence (test/command/file reference) recorded in `progress`.

## 4. Task lifecycle status (`state.json.status`)

| Status | Meaning |
|--------|---------|
| `pending` | Created, not started |
| `in_progress` | Work underway |
| `blocked` | Cannot proceed (dependency/discrepancy/retry limit) |
| `review` | Awaiting verification/reviewer |
| `completed` | Closed, closure gates passed |
| `reopened` | Previously completed, new work started (new plan/state id) |

Allowed transitions (any other is rejected with non-zero exit):

```
pending      → in_progress
in_progress  → blocked | review | in_progress   (retry within limit)
blocked      → in_progress | review
review       → completed | in_progress
completed    → reopened
reopened     → in_progress
```

Closure (`review|in_progress → completed`) additionally requires all closure
gates (§6) to pass (see contract §7 of `README.md` and TASK-4).

## 5. Discrepancy status & severity

- Status: `open → resolved | wontfix`. `wontfix` requires a reason.
- Severity: `blocker | major | minor | info`. Only `blocker` prevents closure.
- Type: `knowledge | plan | implementation | environment`.

## 6. Closure gates (all must hold)

1. Every plan item is `done` or justified `skipped` (small tasks with no plan
   must have `state.json.plan_required = false`).
2. `result.json.verification.passed = true` and every listed command has a
   recorded exit code.
3. No open discrepancy with severity `blocker`.
4. Retry/spawn counters within configured limits.
5. Every acceptance criterion in `result.json` has a recorded evidence string.

## 7. Freshness metadata fields

Each `index.json` entry: `status`, `last_validated`, `revision.git_commit`,
`revision.content_hash`, `depends_on[]`, `scope[]`. Recomputation rule: if any
`scope` path changed (per Git diff or hash/mtime fallback) or any `depends_on`
artifact is not `fresh`, the entry becomes `stale`.
