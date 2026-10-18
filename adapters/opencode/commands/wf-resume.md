---
description: Resume the active task from its persisted next action
---

Resume work from persisted state: read `.agent/tasks/<id>/state.json` and
`progress.json`, then continue from `next_action`. Do not re-read files or
re-analyze knowledge that is already fresh.

!`node .agentflow/cli.mjs status --json`
