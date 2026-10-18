---
description: Run closure gates for a task and close it only if they pass
---

Attempt to close task `$1`. If closure fails, report the gate reasons and do not
force the transition.

!`node .agentflow/cli.mjs close --task $1 --json`
