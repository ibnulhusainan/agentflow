// OpenCode v2 adapter: token-aware context filter (opt-in, fail-safe).
//
// Implements the trimming policy from `.agentflow/docs/spec/workflow.md` §10 with the
// *verified* v2 hook `ctx.session.hook("context", ...)` — NOT the V1
// `experimental.chat.messages.transform` name (that hook is not present in the
// opencode v2 runtime; see adapter README for the evidence).
//
// Policy (why this only trims at turn boundaries):
//   - Trimming on every request rewrites the prompt prefix and destroys prompt
//     caching, so a smaller context can end up costing more. This filter only
//     changes anything when a *new user turn* appears.
//   - Old tool results dominate a coding session's context, so they are the
//     first payload to shrink.
//   - A tool call is never removed without its result (and vice versa): parts
//     stay in place, only oversized payloads are replaced with a short pointer.
//   - System instructions are left untouched: they are the stable cache prefix.
//
// Modes (`OPENCODE_CTX_FILTER`):
//   off  — do nothing (hook still registered, returns immediately)
//   dry  — default: log what would change, mutate nothing
//   on   — apply the planned trim
//
// Env:
//   OPENCODE_CTX_FILTER=off|dry|on     (default dry)
//   OPENCODE_CTX_KEEP_TURNS=<n>        (default 3)   newest user turns kept intact
//   OPENCODE_CTX_MAX_CHARS=<n>         (default 4000) per payload before trimming
//   OPENCODE_CTX_DROP_TURNS=on|off     (default off)  also drop whole old turns
//   OPENCODE_CTX_LOG=<path>            (default /tmp/opencode/context-filter.log)
//   OPENCODE_CTX_MAX_ACTIONS=<n>       (default 200)  safety valve
//
// Copy to `.opencode/plugins/context-filter.js` (auto-discovered by OpenCode v2).

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const DEFAULT_CONFIG = {
  mode: "dry",
  keepTurns: 3,
  maxChars: 4000,
  dropTurns: false,
  logPath: "/tmp/opencode/context-filter.log",
  maxActions: 200,
};

export function readConfig(env = process.env) {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  const modeRaw = String(env.OPENCODE_CTX_FILTER || "dry").toLowerCase();
  const mode = ["off", "dry", "on"].includes(modeRaw) ? modeRaw : "dry";
  return {
    mode,
    keepTurns: num(env.OPENCODE_CTX_KEEP_TURNS, DEFAULT_CONFIG.keepTurns),
    maxChars: num(env.OPENCODE_CTX_MAX_CHARS, DEFAULT_CONFIG.maxChars),
    dropTurns: String(env.OPENCODE_CTX_DROP_TURNS || "").toLowerCase() === "on",
    logPath: env.OPENCODE_CTX_LOG || DEFAULT_CONFIG.logPath,
    maxActions: num(env.OPENCODE_CTX_MAX_ACTIONS, DEFAULT_CONFIG.maxActions),
  };
}

export function placeholder(chars, hint = "re-read the referenced path if it is needed again") {
  return `[context-filter: ${chars} chars elided at a turn boundary — ${hint}]`;
}

// Returns [field, currentLength] for the first trimmable payload field, or null.
function payloadField(part) {
  if (!part || typeof part !== "object") return null;
  if (typeof part.output === "string") return ["output", part.output.length];
  if (typeof part.result === "string") return ["result", part.result.length];
  if (typeof part.value === "string") return ["value", part.value.length];
  if (typeof part.content === "string") return ["content", part.content.length];
  if (Array.isArray(part.content)) {
    const allText = part.content.length > 0 && part.content.every((p) => p && typeof p === "object" && typeof p.text === "string");
    if (allText) return ["contentText", part.content.reduce((a, p) => a + p.text.length, 0)];
  }
  if (typeof part.text === "string") return ["text", part.text.length];
  return null;
}

function isTextPart(part) {
  return !!part && typeof part === "object" && (part.type === "text" || part.type === "reasoning");
}

function partChars(part) {
  const f = payloadField(part);
  return f ? f[1] : 0;
}

export function messageChars(message) {
  if (!message) return 0;
  if (typeof message.content === "string") return message.content.length;
  if (!Array.isArray(message.content)) return 0;
  return message.content.reduce((a, p) => a + partChars(p), 0);
}

// Pure planner: computes what to trim without mutating anything.
export function planTrim(messages, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const stats = { messages: 0, totalChars: 0, plannedChars: 0, savedChars: 0, keepFrom: 0, turnsKept: 0 };
  const actions = [];
  if (!Array.isArray(messages) || messages.length === 0) return { actions, stats, cfg };

  stats.messages = messages.length;
  stats.totalChars = messages.reduce((a, m) => a + messageChars(m), 0);

  const userStarts = [];
  messages.forEach((m, i) => {
    if (m && m.role === "user") userStarts.push(i);
  });

  // Turn boundaries: each user message starts a turn; the trailing slice has no
  // user message and belongs to the last turn.
  const bounds = [...userStarts, messages.length];
  const keepTurns = Math.max(1, cfg.keepTurns);
  const keepFrom = userStarts.length > keepTurns ? userStarts[userStarts.length - keepTurns] : 0;
  stats.keepFrom = keepFrom;
  stats.turnsKept = Math.min(keepTurns, Math.max(1, bounds.length - 1));

  // Whole turns strictly older than the kept window (never turn 0: task brief).
  const droppable = [];
  if (cfg.dropTurns) {
    for (let k = 1; k < bounds.length - 1; k++) {
      const start = bounds[k];
      const end = bounds[k + 1];
      if (end <= keepFrom) {
        for (let i = start; i < end; i++) droppable.push(i);
      }
    }
  }
  const dropped = new Set(droppable);
  for (const i of droppable) {
    if (actions.length >= cfg.maxActions) break;
    const chars = messageChars(messages[i]);
    actions.push({ kind: "drop_message", messageIndex: i, chars, reason: "turn boundary" });
  }

  for (let i = 0; i < keepFrom && actions.length < cfg.maxActions; i++) {
    if (dropped.has(i)) continue;
    const msg = messages[i];
    if (!msg) continue;

    if (typeof msg.content === "string") {
      if (msg.content.length > cfg.maxChars) {
        actions.push({ kind: "trim_string", messageIndex: i, chars: msg.content.length, placeholder: placeholder(msg.content.length) });
      }
      continue;
    }
    if (!Array.isArray(msg.content)) continue;

    for (let p = 0; p < msg.content.length && actions.length < cfg.maxActions; p++) {
      const part = msg.content[p];
      const field = payloadField(part);
      if (!field) continue;
      const [name, len] = field;
      if (len <= cfg.maxChars) continue;
      // Tool results are the noisy majority; text/reasoning prose is trimmed too
      // (the decision itself stays in the artifacts, not the transcript).
      const type = isTextPart(part) ? String(part.type) : "tool";
      actions.push({
        kind: "trim_part",
        messageIndex: i,
        partIndex: p,
        partType: type,
        field: name,
        chars: len,
        placeholder: placeholder(len),
      });
    }
  }

  for (const a of actions) {
    stats.plannedChars += a.chars;
    if (a.kind !== "drop_message") stats.savedChars += Math.max(0, a.chars - a.placeholder.length);
  }
  return { actions, stats, cfg };
}

// Applies a plan in place. Never removes a part, so tool-call/tool-result
// pairing is preserved; drops, when enabled, remove whole messages.
export function applyTrim(messages, actions) {
  if (!Array.isArray(messages) || !Array.isArray(actions)) return messages;

  for (const a of actions) {
    if (a.kind === "trim_string") {
      if (typeof messages[a.messageIndex]?.content === "string") messages[a.messageIndex].content = a.placeholder;
      continue;
    }
    if (a.kind !== "trim_part") continue;
    const part = messages[a.messageIndex]?.content?.[a.partIndex];
    if (!part || typeof part !== "object") continue;
    if (a.field === "contentText" && Array.isArray(part.content)) {
      part.content = part.content.map((p, i) => ({ ...p, text: i === 0 ? a.placeholder : "" }));
    } else if (typeof part[a.field] === "string") {
      part[a.field] = a.placeholder;
    }
  }

  const drops = actions.filter((a) => a.kind === "drop_message").map((a) => a.messageIndex);
  if (drops.length) {
    const set = new Set(drops);
    for (let i = messages.length - 1; i >= 0; i--) if (set.has(i)) messages.splice(i, 1);
  }
  return messages;
}

function log(cfg, payload) {
  try {
    mkdirSync(dirname(cfg.logPath), { recursive: true });
    appendFileSync(cfg.logPath, `${new Date().toISOString()} ${JSON.stringify(payload)}\n`);
  } catch {
    /* logging must never break a request */
  }
}

// The hook body. Fail-safe: any error is swallowed (and logged) so a filter bug
// can never break a model call.
export function makeContextHook(env = process.env) {
  return function contextHook(input) {
    const cfg = readConfig(env);
    if (cfg.mode === "off") return;
    try {
      const messages = input?.messages;
      const plan = planTrim(messages, cfg);
      const summary = {
        plugin: "agentflow.context-filter",
        sessionID: input?.sessionID ?? null,
        agent: input?.agent ?? null,
        mode: cfg.mode,
        actions: plan.actions.length,
        messages: plan.stats.messages,
        totalChars: plan.stats.totalChars,
        savedChars: plan.stats.savedChars,
        byKind: plan.actions.reduce((a, x) => ({ ...a, [x.kind]: (a[x.kind] || 0) + 1 }), {}),
      };
      if (cfg.mode === "on" && plan.actions.length) applyTrim(messages, plan.actions);
      log(cfg, summary);
    } catch (error) {
      log(cfg, { plugin: "agentflow.context-filter", error: String(error?.message ?? error) });
    }
  };
}

export const ContextFilterPlugin = async (ctx) => {
  const hook = makeContextHook();
  await ctx.session.hook("context", hook);
};

// OpenCode v2 plugin entry point.
//
// `setup` is the member the runtime invokes; `server` is not part of the schema
// at all (the module then fails to decode and the plugin never loads).
//
// Export ONLY `setup`. Exporting `effect` as well is not a harmless belt-and-
// braces: it makes the module fail to load, and a plugin load failure takes the
// whole OpenCode runtime with it — the editor then cannot reach providers and
// the model list stays empty. One valid key beats two "compatible" ones.
export default {
  id: "agentflow.context-filter",
  setup: ContextFilterPlugin,
};
