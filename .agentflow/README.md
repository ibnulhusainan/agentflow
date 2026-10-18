# agentflow — Platform-Independent Workflow Core

Deterministic core for the cross-platform AI agent workflow. No external
dependencies; runs on Node.js ≥ 18 (developed/verified on Node 24).

## Installation

Nothing to install. The core is plain ESM under `.agentflow/`. Invoke it
directly with Node, or via a wrapper/alias.

```
node .agentflow/cli.mjs <command> [options]
```

Optional: make it runnable on PATH.

```
alias agentflow="node \"$PWD/.agentflow/cli.mjs\""
```

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | success / rule satisfied |
| 1 | rule failure (validation error, illegal transition, closure rejected, limit exceeded) |
| 2 | usage error or missing schema |

Errors are written to stdout as JSON in `--json` mode, allowing adapters to parse
results without scraping prose.

## Commands

| Command | Purpose |
|---------|---------|
| `status [--changed <ref>] [--json]` | Classify knowledge: `missing/fresh/stale/incomplete/invalid`. Uses Git diff (`--changed <ref>` or working tree) with an mtime fallback. |
| `task new [--id <T-YYYYMMDD-NNN>] [--request <text>] [--size <s>] [--files <n>] [--cross-module] [--contract-change] [--json]` | Create the task record — `.agent/tasks/<id>/state.json` (+ `request.md`). **Do this first**: `validate`, `transition`, `attempt`, `context` and `close` all refuse without `state.json`. Generates the next gap-free id when `--id` is omitted, and derives `size`/`plan_required` from the same thresholds `classify` uses unless `--size` is asserted. Refuses to overwrite an existing task. |
| `task list [--json]` | Every task with its status, size and `plan_required` — for when more than one is open. |
| `task current [--json]` | The most recently updated open task, its status, and whether it needs `planner` or `executor`. Fails with a `task new` hint when there is none. |
| `facts [--kind <name>]... [--scope <glob>]... [--register] [--dry-run] [--json]` | Generate deterministic repository facts into `knowledge/facts/<kind>.json` (one document per kind). `--register` upserts one knowledge-index entry per kind, each with its own `scope` and `revision.content_hash`. |
| `classify --files <n> [--cross-module] [--contract-change] [--json]` | Decide task size and whether planning is required (FR-4/FR-5). |
| `validate <task-id> [--json]` | Validate a task's artifacts (schema + semantics: IDs, deps, cycles, transitions). |
| `transition --task <id> --to <status> [--by <role>] [--note <t>] [--json]` | Enforce an allowed lifecycle transition. |
| `close --task <id> [--by <role>] [--json]` | Run closure gates and, only if they pass, move the task to `completed`. |
| `attempt --task <id> --item <P> [--json]` | Increment the persisted retry counter; block at `max_attempts`. |
| `spawn --task <id> [--json]` | Check the persisted spawn limits (`max_spawn_depth`, `max_children`). |
| `discrepancy add --task <id> --severity <s> --type <t> --summary <s> --evidence <e> [--json]` | Append a discrepancy/blocker record. |
| `context --task <id> [--item <P>] [--json]` | Minimal resume bundle: status, `next_action`, the referenced plan item (paths/knowledge refs/criterion), open items, counters, blockers, and budget state in one payload. Exit 1 when the budget is exceeded. |
| `usage add --task <id> --item <P> --requests <n> --input <n> --output <n> [--cache-read <n>] [--note <t>] [--json]` | Record per-item usage (cumulative: keeps the maximum per item, recomputes totals). Exit 1 when a `config.budget` ceiling is passed. |
| `usage check --task <id> [--item <P>] [--json]` | Compare recorded usage against `config.budget`. Exit 1 on any exceeded ceiling. |
| `models show [--json]` | Show every adapter/role's two tiers (`go`, `free`), the current tier/index, and the active model. |
| `models check [--client] [--json]` | Validate `.agent/models.json` (known model ids, non-empty chains). `--client` enforces the privacy policy (`trains_on_data` must be false, retention within `client_max_retention_days`, unknown metadata fails closed) across both tiers. Exit 1 on any policy error. |
| `models next --role <r> [--reason <t>] [--client] [--json]` | Manual fallback: advance the role's pointer (`go[0] → … → free[0] → …`), rewrite `model:` in each adapter's agent file (atomic + `.bak`), and record the reason. Resets to the primary model when the task changes. Exit 1 when both tiers are exhausted (then record a discrepancy and move the task to `blocked`). |
| `models set --role <r> --model <id> [--json]` | Manual override of a role's active model (rewrites frontmatter). |
| `models apply [--json]` | Sync every agent file to its chain's current (or head) model — idempotent. |
| `init [--json]` | Create the `.agent/` skeleton (idempotent). |

Global option: `--root <dir>` (or `AGENTFLOW_ROOT`) selects the project root.
`AGENTFLOW_SCHEMA` overrides the contract path.

### `--task current`

Every `--task <id>` also accepts `current`, which resolves to the task returned
by `task current`. Manual operation does not require the Conductor: run one role
per session and let the core answer "which task am I on?" instead of carrying an
ID around.

```bash
node .agentflow/cli.mjs task new --request "add login page" --files 2  # only if none exists
node .agentflow/cli.mjs context --task current --json                   # where am I?
node .agentflow/cli.mjs transition --task current --to in_progress --by executor
```

### Budget (`config.budget`) and resume context (`config.context`)

Per-item ceilings on requests / input tokens / output tokens (defaults 25 /
60 000 / 25 000) are enforced twice: `usage check` fails fast, and `close` is
rejected while any recorded item exceeds its ceiling
(`budget.enforce_on_close: false` disables the gate). The numbers come from the
agent (self-reported), so the gate is hard on data it does not itself produce —
see `.agentflow/docs/agents/README.md` "Enforcement reality". `context.max_context_tokens`
(60 000) and `context.compact_at_percent` (70) are the advisory resume limits
referenced by `.agentflow/docs/spec/workflow.md` §10.

### Fact generators (`config.facts`)

`facts` runs one deterministic generator per **kind**. Every kind is
project-agnostic: scope, ids and extraction rules come from
`.agent/config.json → facts` (defaults in `lib/config.mjs`), so each project
declares what its Analyzer must provide instead of receiving a fixed structure.
`--kind` selects kinds explicitly (accepts `routes` or `k-routes`); without it,
every kind with `enabled: true` runs. `--scope` overrides the configured scope
of the file-scoped kinds.

| Kind | Output | Covers |
|------|--------|--------|
| `repo-structure` | `repo.json` | Top-level layout, manifest files, scoped file counts (unchanged shape). |
| `inventory` | `inventory.json` | Per file: `role` (first match of `role_patterns`), `loc`, `in_tsconfig`. |
| `imports` | `imports.json` | In-repo import edges (importer → imported file, extension inference for relative specifiers), unresolved specs, external count. |
| `routes` | `routes.json` | Handler/page modules: exported HTTP methods (`method_pattern`), derived route path (`app_dir`), dynamic-segment flag, plus configured text `signals` (e.g. auth guard / validation markers). |
| `schema` | `schema.json` | Regex `extractors` over declaration files (definitions with capture name), migration files in order, existence of configured `db_files`. |
| `verify-state` | `verify-state.json` | Per task: status, recorded verification commands + exit codes, acceptance-criterion results, last verification date. |

Config example (project-declared rules; arrays replace defaults):

```json
{
  "facts": {
    "routes": {
      "signals": { "auth": [{ "pattern": "requireSession", "value": "session" }] }
    },
    "schema": {
      "extractors": [{ "id": "tables", "include": ["src/db/**"], "pattern": "table\\(\\s*\"([^\"]+)\"" }],
      "migration_globs": ["migrations/*.sql"],
      "db_files": ["data/app.db"]
    }
  }
}
```

`--register` writes one index entry per generated kind (scope + content hash
per domain), so a change in one domain does not stale the others. Semantic
facts that no regex can extract honestly (e.g. which tables a handler mutates)
stay the Analyzer's note work; the generators only emit what is deterministic.

### Model chains (`.agent/models.json`)

`.agent/models.json` is the single source of truth for which model each role
uses and its fallback order. It is **per-adapter** (`opencode`, `cursor`) so a
model id that only exists for one adapter is never written into the other. Each
role has **two tiers**:

- `go` — OpenCode Go models (`opencode-go/<id>`). Tried first; they draw down
  the Go subscription allowance.
- `free` — free OpenCode (Zen) models (`opencode/<id>`). Tried after the Go tier
  is exhausted; they do **not** count toward the Go allowance.

Fallback order is `go[0] → go[1] → … → free[0] → free[1] → … → break`. The
active position lives in `.agent/models.state.json` (per-role tier + index),
which is runtime state, not a template.

```json
{
  "version": 2,
  "client_max_retention_days": 0,
  "adapters": {
    "opencode": {
      "roles": {
        "executor": {
          "go": ["opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.6-flash"],
          "free": ["opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"],
          "on_exhausted": "break"
        }
      }
    },
    "cursor": { "roles": { "executor": { "go": [], "free": [], "on_exhausted": "break" } } }
  }
}
```

Manual fallback flow (Fase 1 — no provider error detection):

```bash
node .agentflow/cli.mjs models show --json                     # where am I?
node .agentflow/cli.mjs models next --role executor --reason "limit"
#   -> advances go -> ... -> free, rewrites .opencode/agents/executor.md (+ .bak)
node .agentflow/cli.mjs context --task current --item P2       # resume from the artifact
```

Honest boundaries:

- **A request that dies on a limit dies.** Only the *next* request uses the
  fallback model. Continuity comes from artifacts (`context --task current`),
  not from carrying chat history across models.
- **`models next` is manual.** Automatic detection of provider limits is Fase 2
  (an OpenCode `session.retry` plugin, off by default) and is not part of the
  core.
- **Client mode is fail-closed.** `models check --client` and
  `models next --client` reject any model whose `trains_on_data` is not `false`
  or whose retention is unknown / above `client_max_retention_days`, in either
  tier.
- **Pointer resets per task.** When the current task differs from the one the
  pointer was advanced under, the next `models next` returns the role to its
  primary model instead of stranding it on a fallback.
- **Model lists rotate.** The known-id baselines are advisory; verify the
  current Go list at `https://opencode.ai/inference/go/v1/models` and the free
  list at `https://opencode.ai/zen/v1/models`.

## Source layout

```
.agentflow/
  cli.mjs                 entrypoint (arg parsing, dispatch)
  lib/glob.mjs            glob matching (*, **, ?)
  lib/fsutil.mjs          atomic IO, hashing, file walking
  lib/config.mjs          config loading + defaults
  lib/git.mjs             Git change detection (graceful when absent)
  lib/freshness.mjs       knowledge classification
  lib/schema.mjs          minimal JSON-Schema validator
  lib/schemafile.mjs      schema resolution
  lib/task.mjs            transitions, validation, closure gates (incl. budget gate)
  lib/usage.mjs           per-item usage records + budget checks
  lib/models.mjs          model chains, pointer state, privacy policy, `models` command
  lib/models-util.mjs     generic YAML frontmatter `model:` writer
  lib/facts.mjs           deterministic facts generation
  lib/output.mjs          human/JSON output
  schema/agentflow.schema.json   bundled copy of the contract schema
  schema/models.schema.json      bundled copy of the model-chains schema
  test/*.test.mjs         automated tests
```

## Tests

```
node --test ".agentflow/test/*.test.mjs"
```

## Known limitations (honest)

- **Git fallback.** When the project is not a Git repository, change detection
  falls back to file mtime vs. `last_validated`; this is coarser than Git.
- **Retry/spawn limits are only as strong as recorded calls.** The core enforces
  limits over the persisted counters it manages. It cannot stop an agent from
  spawning a process it never records through `spawn`; platform-level permission
  enforcement is required for that (see platform adapters).
- **Path-only scope.** Scope is matched by glob; renames are treated as
  delete+add. Globs support `*`, `**` and `?` only — no `{a,b}` brace lists;
  enumerate alternatives instead.
- **Fact extraction is regex-based.** Route signals, schema extractors and
  import parsing are deterministic text matching, not a parser. They report
  what they find (and nothing when a pattern does not match); interpretation
  belongs in Analyzer notes.
- **Single writer assumed.** Atomic writes prevent torn files, but concurrent
  writers are not coordinated by a lock.
- **Model fallback is manual (Fase 1).** The core does not observe provider
  errors; it only moves a pointer when asked. Automatic limit detection needs an
  editor plugin (Fase 2) and is intentionally not built yet.
- **JSON Schema subset.** The bundled validator implements the keywords used by
  `agentflow.schema.json`; unsupported keywords are ignored.
