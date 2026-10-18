# Platform Adapters — Overview

Status: Task 5. These adapters expose the shared workflow (core in
`.agentflow/`) to coding-agent platforms. They contain **no** business
logic: freshness, validation, transitions, closure, and retry/spawn accounting
all live in the core. Adapters only register agents/commands, map permissions,
and invoke the core.

Sources of truth:
- Shared contracts: `.agentflow/docs/contracts/`
- Role contracts: `.agentflow/docs/agents/`
- Core CLI: `.agentflow/README.md`

## Capability matrix

Legend: **enforced** = platform enforces it deterministically; **partial** =
supported but with caveats; **manual** = user must do it; **unsupported** = not
available.

| # | Shared capability | OpenCode V2 | Cursor | Notes |
|---|-------------------|-------------|--------|-------|
| C1 | Register selectable primary agents/modes | **enforced** (`agents` + `default_agent`) | **manual** (Custom Modes are beta, UI-configured) | Cursor subagents are file-based and selectable. |
| C2 | Native agent/mode switcher | **enforced** (primary agent selection) | **enforced** for built-ins (mode picker / `Ctrl+.`); custom modes via picker | |
| C3 | Enforce role edit boundaries (read-only roles) | **enforced** (`edit` permission rules) | **partial** (subagents `readonly: true`; Ask mode read-only) | |
| C4 | Enforce spawn/subagent limits | **enforced** (`subagent` permission) + core counters | **partial** (`subagentStart` hook can deny; nesting limit) | |
| C5 | Enforce shell/destructive command boundaries | **enforced** (`shell` permission rules) | **enforced** (`beforeShellExecution` hook, Run Modes, sandbox) | |
| C6 | Workflow commands | **enforced** (`commands`) | **partial** (slash commands via skills/plugins) | |
| C7 | Inject rules/instructions | **enforced** (`instructions`, `AGENTS.md`) | **enforced** (`.cursor/rules/*.mdc`, `AGENTS.md`) | |
| C8 | Per-role model selection | **enforced** (`agents.<id>.model`) | **partial** (subagent `model:`; mode model in UI) | |
| C9 | Invoke the core CLI | **enforced** (shell) | **enforced** (shell) | Both subject to shell permissions/hooks. |
| C10 | Freshness/validation/closure enforcement | **enforced** (core) | **enforced** (core) | Platform-independent; identical behavior. |
| C11 | Concise handoffs / artifact pointers | **partial** (instructions/prompt) | **partial** (rules/prompt) | No platform-native handoff format. |
| C12 | Guard-rail hooks/plugins | **enforced** (plugins, permissions) | **enforced** (`hooks.json`) | |

## Honest limitations

- Prompt/instruction text is **not** a hard security boundary. Where a platform
  lacks a deterministic mechanism, this is marked partial/manual above. No
  adapter claims enforcement it does not have.
- Retry/spawn limits are enforced over the **persisted counters** the core
  manages; an agent that spawns something without recording it cannot be stopped
  by the core alone. OpenCode can hard-block via `subagent` permission; Cursor
  can block via `subagentStart` hooks (best-effort, source-dependent).
- Cursor Custom Modes are in beta and configured through the UI, so primary-mode
  registration is documented as manual rather than automated.

## Adapters

- `adapters/opencode/` — OpenCode V2 (implemented first, per Task 5/8).
- `adapters/cursor/` — Cursor (rules, subagents, hooks).

Each adapter directory has its own README with install, config, permissions, and
limitations, plus a focused test under `adapters/test/`.

## Verification

```
node --test "adapters/test/*.test.mjs"
```
