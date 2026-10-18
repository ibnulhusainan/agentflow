#!/usr/bin/env node
// agentflow guard — a Cursor hook script.
//
// Deterministic shell policy for the workflow. It does NOT contain workflow
// logic (freshness/validation/state); those stay in the core. It only maps the
// shared shell boundary onto Cursor's hook surface.
//
// Wiring: `.cursor/hooks.json` registers this for `beforeShellExecution`.
// Cursor runs project hooks from the project root and passes JSON on stdin:
//   { "command": "...", "cwd": "...", "hook_event_name": "beforeShellExecution", ... }
// We print a JSON decision on stdout: { "permission": "allow"|"deny"|"ask", ... }
//
// The policy is an ordered list; the LAST matching rule wins, mirroring the
// OpenCode adapter's rule semantics so behavior is consistent across platforms.

import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// effect: "deny" | "ask" | "allow". Ordered; last match wins.
const SHELL_RULES = [
  // Broad baseline: anything not matched explicitly requires approval.
  { pattern: /.*/, effect: "ask", reason: "Unrecognised shell command requires approval." },

  // The workflow core is always safe to call.
  { pattern: /^node \.agentflow\/cli\.mjs(\s|$)/, effect: "allow" },
  { pattern: /^node(\.exe)? \.agentflow[\\/]cli\.mjs(\s|$)/, effect: "allow" },

  // Read-only inspection.
  { pattern: /^git (status|diff|log|show|branch)(\s|$)/, effect: "allow" },
  { pattern: /^(ls|cat|pwd|head|tail|wc|find|rg|grep|which|echo|node --version)(\s|$)/, effect: "allow" },
  { pattern: /^node --test(\s|$)/, effect: "allow" },
  { pattern: /^(npm|pnpm|yarn|bun) (test|run test|run lint)(\s|$)/, effect: "allow" },

  // Guard rails: destructive or external side effects.
  { pattern: /^(sudo|su)(\s|$)/, effect: "deny", reason: "Privilege escalation is not allowed." },
  { pattern: /rm\s+(-[a-z]*[rf][a-z]*\s+)+(\/|\*|~|\.\.|\$HOME)/, effect: "deny", reason: "Recursive/forced deletion of a broad path is not allowed." },
  { pattern: /^rm\s+-[a-z]*r[a-z]*f|^rm\s+-[a-z]*f[a-z]*r/, effect: "deny", reason: "Recursive forced deletion is not allowed." },
  { pattern: /^git\s+push(\s|$)/, effect: "deny", reason: "Pushing is an external side effect; do it manually." },
  { pattern: /^git\s+reset\s+--hard|^git\s+clean\s+-[a-z]*f/, effect: "deny", reason: "Destructive git operations are not allowed." },
  { pattern: /^(npm|pnpm|yarn|bun)\s+publish(\s|$)/, effect: "deny", reason: "Publishing is an external side effect." },
  { pattern: /^(shutdown|reboot|halt|poweroff)(\s|$)/, effect: "deny" },
  { pattern: /\bmkfs(\.|\s|$)/, effect: "deny" },
  { pattern: /^dd\s+[^|]*\bof=\/dev\//, effect: "deny", reason: "Raw device writes are not allowed." },
  { pattern: /^chmod\s+-R\s+777/, effect: "deny", reason: "World-writable recursion is not allowed." },
  { pattern: /(curl|wget)[^|]*\|\s*(sudo\s+)?(sh|bash|zsh)\b/, effect: "deny", reason: "Piping a download into a shell is not allowed." },
  { pattern: /:\s*\(\s*\)\s*\{.*\}\s*;?\s*:/, effect: "deny", reason: "Fork bomb pattern detected." },

  // Network/install/containers: allowed only after approval.
  { pattern: /^(npm|pnpm|yarn|bun)\s+(install|add|i|ci)(\s|$)/, effect: "ask" },
  { pattern: /^(npx|bunx|pnpm\s+dlx)(\s|$)/, effect: "ask" },
  { pattern: /^(pip|pip3|python\s+-m\s+pip)\s+install(\s|$)/, effect: "ask" },
  { pattern: /^(docker|podman|kubectl|helm|terraform|aws|gcloud|az)(\s|$)/, effect: "ask" },
  { pattern: /^git\s+(commit|add|merge|rebase|checkout|switch|stash|tag|remote)(\s|$)/, effect: "ask" },
];

export function evaluateShell(command) {
  const cmd = String(command ?? "").trim();
  let decision = { effect: "ask", reason: "Unrecognised shell command requires approval." };
  for (const rule of SHELL_RULES) {
    if (rule.pattern.test(cmd)) {
      decision = { effect: rule.effect, reason: rule.reason };
      // no break: last match wins
    }
  }
  return decision;
}

export function decisionFor(input) {
  const event = input?.hook_event_name ?? "beforeShellExecution";
  if (event === "subagentStart") {
    // Cursor already enforces a nesting limit and blocks spawning without Task
    // access. We allow here and rely on the core's persisted counters plus that
    // limit; the adapter does not claim deeper enforcement.
    return { permission: "allow" };
  }
  const { effect, reason } = evaluateShell(input?.command ?? "");
  const out = { permission: effect };
  if (effect === "deny") {
    out.user_message = `Blocked by agentflow guard: ${reason}`;
    out.agent_message =
      `The command was blocked by the agentflow guard (${reason}). ` +
      `Do not retry it. If the task genuinely needs it, stop and ask the user to run it manually.`;
  } else if (effect === "ask") {
    out.user_message = `agentflow guard requests approval: ${reason ?? "review the command"}`;
  }
  return out;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const raw = await readStdin();
  let input = {};
  try {
    input = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    // Malformed input: permission hooks block on invalid responses, which is
    // fail-safe. Emit an explicit deny instead of crashing silently.
    process.stdout.write(JSON.stringify({ permission: "deny", user_message: "agentflow guard: malformed hook input." }) + "\n");
    process.exit(2);
  }
  const out = decisionFor(input);
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exit(out.permission === "deny" ? 2 : 0);
}
