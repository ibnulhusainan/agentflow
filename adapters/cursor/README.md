# Cursor Adapter

Exposes the shared agentflow workflow to **Cursor** (Agent mode, subagents,
project rules, hooks). Target docs: <https://cursor.com/docs>.

This adapter contains **no** workflow logic. Freshness, validation, transitions,
closure, and retry/spawn accounting live in the core (`.agentflow/`). The
adapter registers subagents, project rules, and hooks, and invokes the core.

## What it provides

```
adapters/cursor/
  .cursor/
    rules/
      agentflow.mdc            always-apply rule: roles, handoffs, shell boundaries
    agents/
      analyzer.md              readonly: false (owns .agent/knowledge/)
      planner.md               readonly: false (owns plan.json)
      executor.md              readonly: false (owns implementation)
      reviewer.md              readonly: true  (verification only)
      consultant.md            readonly: true  (advice only)
    hooks.json                 beforeShellExecution + subagentStart -> guard.mjs
    hooks/
      guard.mjs                deterministic shell policy (no workflow logic)
```

## Install

1. Copy the core so the CLI is reachable at `.agentflow/cli.mjs`:

   ```
   cp -R .agentflow  <your-project>/.agentflow
   ```

2. Copy the Cursor adapter tree into your project root:

   ```
   cp -R adapters/cursor/.cursor  <your-project>/.cursor
   ```

   (If you already have a `.cursor/` directory, merge `rules/`, `agents/`, and
   add the `hooks` entries from `hooks.json`.)

3. Ensure the guard script is readable and runnable:

   ```
   chmod +x <your-project>/.cursor/hooks/guard.mjs
   ```

4. Initialise workflow state (idempotent):

   ```
   node .agentflow/cli.mjs init
   ```

5. Trust the workspace and reload. `agentflow.mdc` applies to every Agent
   session; the subagents appear as `/analyzer`, `/planner`, `/executor`,
   `/reviewer`, `/consultant`.

## How each shared capability maps to Cursor

| Shared capability | Cursor feature | Strength |
|-------------------|----------------|----------|
| Conductor role (primary) | Agent mode + always-apply rule | **manual** (custom primary modes are UI-configured) |
| Analyzer/Planner/Executor/Reviewer/Consultant | `.cursor/agents/*.md` subagents | **enforced** registration; selectable via `/name` |
| Reviewer/Consultant read-only | subagent `readonly: true` | **partial** (blocks writes + state-changing shell; also blocks the core append, see below) |
| Analyzer/Planner/Executor write scope | rules + prompt | **soft** (no per-path write permission for subagents) |
| Shell boundaries | `beforeShellExecution` hook + guard | **enforced** (best-effort command matching) |
| Spawn limits | `subagentStart` hook + Cursor nesting limit + core counters | **partial** (`ask` is treated as `deny`; nesting already capped) |
| Freshness/validation/closure | core CLI | **enforced** (identical to OpenCode) |
| Concise handoffs / artifact pointers | always-apply rule text | **soft** (prompt only) |

### Honest limitations

- **No file-based primary modes.** Custom Modes are beta and configured in the
  UI, so the Conductor is realised as the always-apply rule over the default
  Agent mode, not as a selectable primary profile.
- **`readonly: true` is coarse.** It blocks all edits and state-changing shell,
  so the Reviewer cannot itself append `.agent/tasks/<id>/discrepancies.json`.
  The subagent reports findings; the Conductor records them via
  `node .agentflow/cli.mjs discrepancy add ...`. This is documented in the
  reviewer subagent body.
- **Per-path edit boundaries are prompt-only.** Cursor subagents do not accept
  per-path write permissions, so "Analyzer does not edit source" is enforced by
  the rule/prompt, not by Cursor. Do not treat it as a security boundary.
- **Hook `ask` for `subagentStart` is treated as `deny`** by Cursor; the guard
  therefore only ever allows or denies there.

## Shell guard

`beforeShellExecution` runs `.cursor/hooks/guard.mjs` (project hooks run from the
project root). The guard applies an ordered policy (last match wins):

- **allow:** `node .agentflow/cli.mjs ...`, `git status|diff|log|show|branch`,
  read-only tools (`ls`, `cat`, `grep`, `rg`, ...), `node --test`, local test/lint.
- **ask:** installs (`npm/pnpm/yarn/bun install`), `npx`/`bunx`, `pip install`,
  containers/cloud CLIs (`docker`, `kubectl`, `terraform`, `aws`, ...), and
  non-destructive git mutations (`commit`, `add`, `checkout`, ...).
- **deny:** `sudo`, broad recursive deletion, `git push`, `git reset --hard` /
  `git clean -fd`, publish, raw device writes, `chmod -R 777`,
  download-piped-to-shell, and fork bombs.

`failClosed: true` is set on the shell hook, so a crash/timeout blocks the action
rather than allowing it through. Invalid hook JSON also blocks the action.

You can test the policy directly:

```
echo '{"command":"git push origin main"}' | node .cursor/hooks/guard.mjs
echo '{"command":"node .agentflow/cli.mjs status --json"}' | node .cursor/hooks/guard.mjs
```

## Test

```
node --test "adapters/test/cursor.test.mjs" "adapters/test/guard.test.mjs"
```

An end-to-end example is in `docs/guides/` (Task 7) and
`docs/validation/` (Task 6).
