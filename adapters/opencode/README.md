# OpenCode Adapter

Exposes the shared agentflow workflow to **OpenCode V2**. Target docs:
<https://opencode.ai/v2/docs/> (config, agents, commands, permissions).

This adapter contains **no** workflow logic. All freshness, validation,
transition, closure, and retry/spawn accounting live in the core
(`.agentflow/`). The adapter only registers agents, maps permissions, and
invokes the core.

## What it provides

```
adapters/opencode/
  opencode.jsonc                 config: default agent + shared permissions
  agents/
    conductor.md                 primary  — orchestrates, delegates one role at a time
    analyzer.md                  all      — owns .agent/knowledge/
    planner.md                   all      — owns .agent/tasks/<id>/plan.json
    executor.md                  primary  — owns implementation + progress/result
    reviewer.md                  all      — read-only verification
    consultant.md                primary  — read-only advice
  commands/
    wf-status.md                 /wf-status  — knowledge status
    wf-validate.md               /wf-validate <id> — validate a task
    wf-close.md                  /wf-close <id>    — run closure gates
    wf-resume.md                 /wf-resume  — resume from persisted next action
```

## Install

1. Copy the core so the CLI is reachable at `.agentflow/cli.mjs` (the
   adapter commands and permissions reference this exact path).

   ```
   cp -R .agentflow  <your-project>/.agentflow
   ```

2. Copy the config and agent/command directories into your project:

   ```
   cp adapters/opencode/opencode.jsonc  <your-project>/opencode.jsonc
   mkdir -p <your-project>/.opencode
   cp -R adapters/opencode/agents   <your-project>/.opencode/agents
   cp -R adapters/opencode/commands <your-project>/.opencode/commands
   ```

   To keep the adapter separate from other OpenCode config, you may instead
   merge the `permissions`/`default_agent` keys into an existing
   `opencode.jsonc`.

3. Initialise workflow state (idempotent):

   ```
   node .agentflow/cli.mjs init
   ```

4. Start OpenCode. The default primary agent is `conductor`; switch roles with
   the native agent picker.

## Configuration notes

- **`default_agent: "conductor"`** — the conductor must exist, be visible, and
  be `primary`-capable, which it is (`mode: primary`).
- **Global `permissions`** load before agent rules and set the shared baseline:
  shell actions ask by default, core-CLI/git-inspection commands are allowed,
  and `git push`, `rm -rf`, and `.env` reads are denied. Agent rules are
  appended afterwards and refine this baseline.
- **Commands are files**, not JSON config entries, so they can use shell blocks
  to call the core. Do not also define `wf-*` commands in `opencode.jsonc` —
  duplicate names collide in one command registry.

## Role → agent mapping

| Role | Agent (`mode`) | Enforced boundary |
|------|----------------|-------------------|
| Conductor | `conductor` (`primary`) | `edit: * deny`; may only launch `analyzer/planner/executor/reviewer` |
| Analyzer | `analyzer` (`all`) | `edit: * deny` except `.agent/knowledge/**` |
| Planner | `planner` (`all`) | `edit: * deny` except `.agent/tasks/**` |
| Executor | `executor` (`primary`) | `edit` denied on `.agent/knowledge/**` and `*plan.json` |
| Reviewer | `reviewer` (`all`) | `edit: * deny`, `shell: * deny` except core CLI + `git diff` |
| Consultant | `consultant` (`primary`) | `edit: * deny`, `shell: * deny` except core CLI |

Each agent body references its full contract under `.agentflow/docs/agents/` and the shared
rules, and follows the handoff protocol (task ID + artifact paths + next action
+ blockers only).

## Permissions → enforcement reality

| Boundary | Mechanism | Strength |
|----------|-----------|----------|
| Analyzer cannot edit source | `edit` rule: `*` deny then `.agent/knowledge/**` allow | **hard** (OpenCode evaluates rules) |
| Executor cannot edit knowledge/plan | `edit` deny rules | **hard** |
| Reviewer/consultant read-only | `edit`/`shell` deny rules | **hard** |
| Conductor may only spawn the 4 roles | `subagent: * deny` then per-ID allow | **hard** |
| Shell destructive commands blocked | `shell` deny rules (`git push`, `rm -rf`) | **hard** (best-effort command matching) |
| Retry/spawn limits | core persisted counters + `subagent` permission | hard for recorded spawns; OpenCode blocks disallowed subagents |
| Concise handoffs / artifact pointers | agent prompt text | **soft** (prompt only) |

Honest caveat: the `shell` action matches scanner-produced command text, and
compound commands may produce several checks; directory inference is best
effort. Prefer the narrow allowlist above over trying to enumerate every
dangerous command. Prompt text (handoff style) is not a security boundary.

## Commands

| Command | Runs |
|---------|------|
| `/wf-status` | `node .agentflow/cli.mjs status --json` |
| `/wf-validate <id>` | `node .agentflow/cli.mjs validate <id> --json` |
| `/wf-close <id>` | `node .agentflow/cli.mjs close --task <id> --json` |
| `/wf-resume` | `node .agentflow/cli.mjs status --json` (then read persisted state) |

Shell blocks run when OpenCode evaluates the command, outside the agent tool
permission flow — the `node .agentflow/cli.mjs *` shell permission is what
keeps the core callable.

## Limitations

- OpenCode V2 has no built-in "mode" concept for primary selection beyond the
  agent picker; role selection is done through the native agent switcher.
- Agent `color`/`steps` are cosmetic/step-budget hints, not security controls.
- The adapter cannot stop an agent from spawning a process it never records
  through `spawn`; only the `subagent` permission can hard-block disallowed
  child agents.
- Requires the core at the fixed relative path `.agentflow/cli.mjs`.

## Test

```
node --test "adapters/test/opencode.test.mjs" "adapters/test/jsonc.test.mjs"
```

An end-to-end example is in `docs/guides/` (Task 7) and
`docs/validation/` (Task 6).
