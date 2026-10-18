# Agentflow CLI

## Scope
- `.agentflow/cli.mjs`
- `.agentflow/lib/**`

## Verified facts
- `.agentflow/cli.mjs` — dispatches subcommands to `lib/*.mjs` (see `.agent/knowledge/facts/repo.json#data`).
- `.agentflow/lib/` — contains stateless helpers; no I/O beyond `lib/fsutil.mjs`.

## Interpretation
- CLI is a thin dispatcher; business logic stays in `lib/`, so adding flags is low-risk.

## Assumptions
- Node.js >= 18 is available in every target environment.

## Unknowns
- Whether `init` is idempotent (not yet read).

## References
- `.agent/knowledge/facts/repo.json#data`
- `.agentflow/cli.mjs`
