# Task T-20261016-001

## Request
Add a `--dry-run` flag to the CLI that prints planned writes without touching disk.

## Scope
- `.agentflow/cli.mjs`
- `.agentflow/lib/`

## Out of scope
- Changing the on-disk artifact schema.

## Acceptance criteria
- AC1.1 `--dry-run` prints each target path and exits 0.
- AC1.2 With `--dry-run`, no file under `.agent/` is modified.
