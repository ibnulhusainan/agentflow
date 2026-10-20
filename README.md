# agentflow

**Deterministic gates and resumable context for AI coding agents (OpenCode, Cursor).**

Agents do the fuzzy work. agentflow's zero-dependency Node.js core enforces what must be
true around it: task state transitions, knowledge freshness against Git, retry limits, and
closure gates. Tasks and knowledge live in files, so work resumes across sessions and
models without relying on chat history.

## Why it exists

AI coding agents forget context between sessions, continue from stale plans, and claim
"done" without verification. agentflow keeps task state in files, checks recorded knowledge
against Git, and refuses to close a task until passing verification results are recorded.
The core is editor-agnostic; thin adapters expose it to OpenCode and Cursor.

**For you if:** you use AI agents for non-trivial changes and want resumable, auditable
tasks with explicit gates.

**Not for you if:** you want a chat-only assistant. Git is strongly recommended; without it,
change detection falls back to mtime + content hash, which is weaker.

## How it works

```
Developer task
      │
      ▼
agentflow core  ── task state · context · freshness · validation · closure
      │
      ├── OpenCode adapter  (permissions and plugins: hard enforcement)
      └── Cursor adapter    (prompts, hooks: best-effort boundaries)
```

Knowledge is split into two layers:

- `knowledge/facts/*.json`: regenerable, machine-readable (repo structure, imports, routes, schema).
- `knowledge/notes/*.md`: human/LLM notes, referenced via `path#Heading`.

## Requirements

- Node.js >= 18
- `curl` and `tar` (one-line install)
- Git (recommended)

## Install

Run from inside the project you want to set up:

```bash
curl -fsSL https://raw.githubusercontent.com/ibnulhusainan/agentflow/v1.1.1/install.sh | bash
```

Or target another directory:

```bash
curl -fsSL https://raw.githubusercontent.com/ibnulhusainan/agentflow/v1.1.1/install.sh | bash -s -- /path/to/project
```

Install from a pinned tag, not a moving branch. The installer copies the core and adapters,
creates `.agent/` state, generates facts, and never touches your application code. Replaced
files are backed up to `.agentflow-backup/<timestamp>/`.

| Option | Effect |
|---|---|
| `-p opencode` / `-p cursor` | Install a single adapter (default: both) |
| `--no-facts` | Skip fact registration |
| `--no-git` | Don't touch Git |
| `--no-commit` | Skip the initial commit |
| `--remote <url>` | Set `origin` non-interactively |
| `--ref <tag>` | Install a specific release |
| `-u`, `--update` | Refresh managed files (backups are kept) |
| `--force` | Like `--update`, and also overwrite `opencode.jsonc` and the `.cursor/` tree |
| `--dry-run` | Preview without changing anything |

> **Heads-up:** in a directory that is **not** a Git repo, the installer runs `git init` and
> creates an initial commit by default. An existing Git work tree is never committed to.

Update an existing install (note `bash -s --`):

```bash
curl -fsSL https://raw.githubusercontent.com/ibnulhusainan/agentflow/v1.1.1/install.sh | bash -s -- -u /path/to/project
```

## Setup

| Folder | Purpose |
|---|---|
| `.agent/` | State: `config.json`, `tasks/`, `knowledge/` (commit it; it is the audit trail) |
| `.agentflow/` | Core CLI (`node .agentflow/cli.mjs <command>`), docs, contracts, specs |
| `.opencode/` | OpenCode adapter: agents, commands, plugins |
| `.cursor/` | Cursor adapter: subagents, rules, hooks |

**1. Edit `.agent/config.json`.** Illustrative values:

```json
{
  "verify": { "commands": ["npm test", "npm run typecheck"] },
  "small_task": { "max_files": 3, "max_changed_lines": 80 },
  "budget": {
    "max_requests_per_item": 25,
    "max_input_tokens_per_item": 60000,
    "max_output_tokens_per_item": 25000,
    "warn_ratio": 0.8,
    "enforce_on_close": true
  }
}
```

- `verify.commands`: the standard verification list. The core **does not run it**; it is
  surfaced in `context` so the Conductor or Executor knows what to run and record
  (see [How closure works](#how-closure-works)).
- `small_task`: thresholds for bypassing planning.
- `facts.<kind>`: scope, signals and extractors for fact collection (project-specific).
- `budget`: per-item limits; see Limitations for how usage is reported.

Full schema: [`.agentflow/README.md`](.agentflow/README.md).

**2. Verify the install:**

```bash
node .agentflow/cli.mjs status
cd .agentflow && node --test
```

**3. Start your editor.** OpenCode: default agent `conductor`; `/wf-*` commands call the core.
Cursor: subagents `/analyzer`, `/planner`, `/executor`, `/reviewer`, `/consultant`.

## Quick start

```bash
node .agentflow/cli.mjs status
node .agentflow/cli.mjs task new --request "fix login bug"
node .agentflow/cli.mjs context --task current
```

`status` (abridged):

```
fresh      k-repo-structure  (.agent/knowledge/facts/repo.json)
fresh      k-inventory       (.agent/knowledge/facts/inventory.json)
...
summary: fresh=6 stale=0 missing=0 incomplete=0 invalid=0
```

`context --task current` returns the one payload a fresh session reads to resume:

```json
{
  "ok": true,
  "task_id": "T-20261018-001",
  "task_dir": ".agent/tasks/T-20261018-001",
  "status": "pending",
  "size": "small",
  "plan_required": false,
  "next_action": null,
  "item": null,
  "item_progress": null,
  "open_items": [],
  "counters": { "attempts_total": 0, "max_attempts": 3, "spawn_depth": 0,
                "max_spawn_depth": 1, "children": 0, "max_children": 0 },
  "knowledge_refs": [],
  "verify_commands": [],
  "open_discrepancies": [],
  "budget": { "present": false, "limits": { "max_requests_per_item": 25,
              "max_input_tokens_per_item": 60000, "max_output_tokens_per_item": 25000,
              "warn_ratio": 0.8, "enforce_on_close": true },
              "item_id": null, "used": null, "totals": null, "exceeded": [], "warned": [] },
  "context_limits": { "max_context_tokens": 60000, "compact_at_percent": 70 },
  "warnings": []
}
```

Any command that takes `--task <id>` also takes `--task current`.

### Task lifecycle

```bash
node .agentflow/cli.mjs task new --request "fix login bug"      # pending
node .agentflow/cli.mjs classify --files 8 --cross-module        # is a plan required?
node .agentflow/cli.mjs transition --task current --to in_progress
# ... the Executor implements, runs verify_commands, and records the results
node .agentflow/cli.mjs validate current
node .agentflow/cli.mjs transition --task current --to review
node .agentflow/cli.mjs close --task current                     # exits 1 if closure gates fail
```

Allowed transitions:

| From | To |
|---|---|
| `pending` | `in_progress` |
| `in_progress` | `blocked`, `review`, `in_progress` |
| `blocked` | `in_progress`, `review` |
| `review` | `completed`, `in_progress` |
| `completed` | `reopened` |
| `reopened` | `in_progress` |

### How closure works

`close` does **not** execute `verify.commands`. It checks the evidence recorded in the task's
`result.json`, and fails (exit 1, "closure gates failed") unless:

- `verification.passed` is `true`,
- `verification.commands` is non-empty and every entry has a numeric `exit_code`,
- every acceptance criterion is marked met, with evidence.

So an empty or unrecorded verification list makes `close` **refuse**, not pass. The commands
themselves are run by the Conductor or Executor outside the core.

## Concepts

| Term | Meaning |
|---|---|
| Task | A unit of work stored under `.agent/tasks/<id>/`. |
| State | Status, size, plan requirement and counters. Change it through the core CLI, not by hand-editing state files. |
| Gate | A deterministic check that must pass before a transition: freshness, validation, closure. |
| Facts | Regenerable repo facts: structure, inventory, imports, routes, schema. |
| Notes | Human/LLM knowledge in `knowledge/notes/*.md`. |
| Role | A scoped responsibility for a person or agent (below). |
| Attempt / spawn | Counters that bound retries (`max_attempts`) and sub-agent creation (`max_spawn_depth`, `max_children`). |
| Discrepancy | A recorded mismatch between expected and actual result. |

## Roles

Roles work standalone: the Conductor is a convenience, not a requirement. You can run
Analyzer, Planner and Executor yourself in separate sessions.

| Role | Responsibility |
|---|---|
| Conductor | Coordinates the task lifecycle and drives state transitions via the core CLI. |
| Analyzer | Maintains repository knowledge so others don't rescan the repo. |
| Planner | Converts a request into a dependency-aware, testable plan. |
| Executor | Implements the plan, runs verification, records progress and results. |
| Reviewer | Independently verifies a result against acceptance criteria. |
| Consultant | Answers questions and recommends options without changing anything. |

## Models (fallback chains)

Per-role model chains live in `.agent/models.json`, with pointers in `.agent/models.state.json`.
Fallback is **manual**; automatic retry on provider errors is not implemented in v1.1.1.

```bash
node .agentflow/cli.mjs models show                                   # chains and pointers
node .agentflow/cli.mjs models check                                  # validate the chains
node .agentflow/cli.mjs models next --role executor --reason "rate limit"
node .agentflow/cli.mjs models apply                                  # write `model:` lines into agent files
```

- Continuity across a model switch comes from task artifacts (`context --task current`), not chat history.
- A fresh install runs `models check` and `models apply` for OpenCode. On `--update`, agent
  files are not touched; run `models apply` yourself.
- Chains for Cursor are empty by default.

## Platform enforcement

- **OpenCode:** hard enforcement through `edit`/`shell`/`subagent` permissions and plugins.
  The shipped config allows `node .agentflow/cli.mjs *` and denies `git push *`, `rm -rf *`
  and reading `*.env`.
- **Cursor:** prompts, `readonly` flags and a hook guard script (shell policy: allow / ask /
  deny). Boundaries are best-effort; do not assume Cursor blocks edits the way OpenCode does.

The core gates (freshness, validation, transitions, closure) behave identically on both.
Only role-edit boundaries differ.

## Limitations

- **Verification results are agent-recorded.** Closure checks that passing results were
  recorded; it does not re-run the commands. Treat the evidence as something to review, and
  keep CI as the independent check.
- **Budget is self-reported.** `usage check` and the budget closure check use data the agent
  submits, not a provider API.
- **Adapter enforcement differs** (see above).
- **Git is assumed.** Without it, change detection falls back to mtime + content hash.
- **Knowledge reads as stale until the workflow state is committed.**

## CLI reference

`status`, `facts`, `classify`, `task new|list|current`, `validate`, `transition`, `close`,
`attempt`, `spawn`, `discrepancy add`, `usage add|check`, `context`, `init`,
`models show|check|next|set|apply`.

Full reference: [`.agentflow/README.md`](.agentflow/README.md). Also:
[contracts](.agentflow/docs/contracts/), [agent definitions](.agentflow/docs/agents/),
[specs](.agentflow/docs/spec/).

## Adapters

- [`adapters/opencode/`](adapters/opencode/): agents, commands, permissions, plugins. Includes
  an optional `context-filter` plugin (off by default, not part of the core) and an optional
  `model-fallback` plugin (off by default; retries then switches model on timeout/rate limit).
- [`adapters/cursor/`](adapters/cursor/): subagents, rules, hooks, guard script.

## Development

```bash
git clone https://github.com/ibnulhusainan/agentflow.git
cd agentflow
node --test ".agentflow/test/*.test.mjs" "adapters/test/*.test.mjs"   # core + adapters
./install.sh /tmp/testproject -p both --no-git                          # try an install
```

## Troubleshooting

- **`close` fails with "closure gates failed" / "no verification commands recorded":** the
  task's `result.json` has no passing verification. Run the commands and record the results.
- **Knowledge reads as stale:** commit the workflow state, or re-run `facts --register`.
- **Adapter not active:** re-run the installer with `-u` to refresh managed files.
- **Installer fails on Node:** Node.js >= 18 is required.

## License

MIT. See [`LICENSE`](LICENSE).