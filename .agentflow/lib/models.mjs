// Model-chain support: a single source of truth (`.agent/models.json`) for
// which model each role uses, plus a manual fallback pointer
// (`.agent/models.state.json`).
//
// Two tiers per role, in priority order:
//   - `go`   — OpenCode Go models (`opencode-go/<id>`). These draw down the Go
//             subscription allowance.
//   - `free` — free OpenCode (Zen) models (`opencode/<id>`). These sit outside
//             Go and do not count toward the Go allowance.
// Fallback order is go[0] → go[1] → … → free[0] → free[1] → … → break.
//
// Phase 1 is intentionally manual: the core never talks to a provider and never
// classifies provider errors. It only moves the pointer, rewrites agent
// frontmatter, and refuses to continue when a chain is exhausted.
import path from "node:path";
import { exists, readJson, readText, writeJsonAtomic, writeTextAtomic } from "./fsutil.mjs";
import { stateRoot } from "./config.mjs";
import { setFrontmatterKey } from "./models-util.mjs";

export const MODELS_SCHEMA_VERSION = 2;

// Known OpenCode Go model ids (from the Go docs "Endpoints" table). Baseline for
// `models check`; the canonical, always-current list is
// https://opencode.ai/inference/go/v1/models (refresh with `models check --refresh`).
export const KNOWN_MODELS = Object.freeze([
  "grok-4.7",
  "gpt-6-luna",
  "gpt-5.6-luna",
  "claude-haiku-5-5",
  "gemini-4-argon-contributor",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
  "kimi-k2.7-code",
  "longcat-2.0",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "mimo-v2.6-flash",
  "mimo-v2.6-pro",
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "minimax-m3",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
  "qwen3.8-max",
  "qwen3.8-flash",
  "qwen3.7-plus",
  "hy4-preview",
  "hy3",
  "space-bunny",
  "longcat-2.5-preview-free",
  "step-5-preview",
  "beam-free",
]);

// Known free OpenCode (Zen) model ids. The list rotates (mostly limited-time
// launches); refresh with `models check --refresh` or
// https://opencode.ai/zen/v1/models.
export const FREE_MODELS = Object.freeze([
  "big-pickle",
  "deepseek-v4-flash-free",
  "deepseek-v4.1-flash-free",
  "mimo-v2.5-free",
  "mimo-v2.6-flash-free",
  "minimax-m3-free",
  "longcat-2.0-free",
  "beam-free",
  "space-bunny-free",
  "step-5-preview-free",
  "ling-3.0-flash-free",
  "ling-3.1-flash-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "north-mini-code-free",
  "qwen3.6-plus-free",
  "exo-free",
  "muse-spark-1.3-contributor-free",
  "cat-jam-free",
  "laguna-s-2.1-free",
  "union-alpha",
]);

// Documented privacy metadata per model id: whether prompts are used for
// training and how long data is retained. `null` means "not documented here" —
// callers must treat `null` as fail-closed in client mode, never as "safe".
export const MODEL_PRIVACY = Object.freeze({
  // Go models (from the Go docs privacy table)
  "grok-4.7": { trains_on_data: false, retention_days: 30 },
  "gpt-6-luna": { trains_on_data: false, retention_days: 30 },
  "gpt-5.6-luna": { trains_on_data: false, retention_days: 30 },
  "claude-haiku-5-5": { trains_on_data: false, retention_days: 30 },
  "gemini-4-argon-contributor": { trains_on_data: true, retention_days: null },
  "glm-5.3-flash": { trains_on_data: false, retention_days: 0 },
  "glm-5.3": { trains_on_data: false, retention_days: 0 },
  "glm-5.2": { trains_on_data: false, retention_days: 0 },
  "kimi-k3": { trains_on_data: false, retention_days: 0 },
  "kimi-k2.7-code": { trains_on_data: false, retention_days: 0 },
  "longcat-2.0": { trains_on_data: false, retention_days: 0 },
  "mimo-v2.6-flash": { trains_on_data: false, retention_days: 0 },
  "mimo-v2.6-pro": { trains_on_data: false, retention_days: 0 },
  "mimo-v2.5": { trains_on_data: false, retention_days: 0 },
  "mimo-v2.5-pro": { trains_on_data: false, retention_days: 0 },
  "minimax-m3": { trains_on_data: false, retention_days: 0 },
  "muse-spark-1.3-contributor": { trains_on_data: true, retention_days: null },
  "muse-spark-1.2-contributor": { trains_on_data: true, retention_days: null },
  "qwen3.8-max": { trains_on_data: false, retention_days: 0 },
  "qwen3.8-flash": { trains_on_data: false, retention_days: 0 },
  "qwen3.7-plus": { trains_on_data: false, retention_days: 0 },
  "deepseek-v4.1-flash": { trains_on_data: false, retention_days: 0 },
  "deepseek-v4-pro": { trains_on_data: false, retention_days: 0 },
  "hy4-preview": { trains_on_data: false, retention_days: 0 },
  "hy3": { trains_on_data: false, retention_days: 0 },
  "space-bunny": { trains_on_data: false, retention_days: 0 },
  "longcat-2.5-preview-free": { trains_on_data: false, retention_days: 0 },
  "step-5-preview": { trains_on_data: false, retention_days: 0 },
  "beam-free": { trains_on_data: false, retention_days: 30 },
  // Free (Zen) models — terms vary by provider; unknown = null (fail-closed).
  "big-pickle": { trains_on_data: true, retention_days: null },
  "union-alpha": { trains_on_data: false, retention_days: 0 },
  "muse-spark-1.3-contributor-free": { trains_on_data: true, retention_days: null },
  "nemotron-3-ultra-free": { trains_on_data: true, retention_days: null },
  "nemotron-3.5-lightning-free": { trains_on_data: true, retention_days: null },
  "deepseek-v4-flash-free": { trains_on_data: false, retention_days: null },
  "deepseek-v4.1-flash-free": { trains_on_data: false, retention_days: null },
  "mimo-v2.5-free": { trains_on_data: true, retention_days: null },
  "mimo-v2.6-flash-free": { trains_on_data: true, retention_days: null },
  "minimax-m3-free": { trains_on_data: null, retention_days: null },
  "longcat-2.0-free": { trains_on_data: null, retention_days: null },
  "space-bunny-free": { trains_on_data: null, retention_days: null },
  "composer-2.5": { trains_on_data: false, retention_days: 0 },
  "grok-4.7-low": { trains_on_data: false, retention_days: 0 },
  "grok-4.7-medium": { trains_on_data: false, retention_days: 0 },
  "cursor-grok-4.6-medium": { trains_on_data: false, retention_days: 0 },
  "gemini-3.8-flash-medium": { trains_on_data: false, retention_days: 0 },
});

export function modelsConfigPath(root) {
  return path.join(stateRoot(root, {}), "models.json");
}

export function modelsStatePath(root, config) {
  return path.join(stateRoot(root, config || {}), "models.state.json");
}

export function emptyModelsState() {
  return { schema_version: MODELS_SCHEMA_VERSION, roles: {} };
}

export function loadModelsConfig(root) {
  const p = modelsConfigPath(root);
  if (!exists(p)) return { ok: false, error: "missing", path: p, value: null };
  const r = readJson(p);
  if (!r.ok) return { ok: false, error: r.error, path: p, value: null };
  return { ok: true, path: p, value: r.value };
}

export function loadModelsState(root, config) {
  const p = modelsStatePath(root, config);
  if (!exists(p)) return { ok: false, error: "missing", path: p, value: emptyModelsState() };
  const r = readJson(p);
  if (!r.ok) return { ok: false, error: r.error, path: p, value: emptyModelsState() };
  const value = r.value && typeof r.value === "object" ? r.value : emptyModelsState();
  if (!value.roles || typeof value.roles !== "object") value.roles = {};
  return { ok: true, path: p, value };
}

export function saveModelsState(root, config, state) {
  const p = modelsStatePath(root, config);
  writeJsonAtomic(p, state);
  return { ok: true, path: p };
}

// Adapters whose agent files agentflow knows how to rewrite frontmatter for.
const ADAPTER_DIRS = {
  opencode: ".opencode/agents",
  cursor: ".cursor/agents",
};

function roleDef(config, adapter, role) {
  return config?.adapters?.[adapter]?.roles?.[role] || null;
}

function chainsOf(config, adapter, role) {
  const r = roleDef(config, adapter, role);
  if (!r) return { paid: [], free: [] };
  // Back-compat: older configs used `go` for the paid tier.
  const paid = Array.isArray(r.paid) ? r.paid : (Array.isArray(r.go) ? r.go : []);
  return {
    paid,
    free: Array.isArray(r.free) ? r.free : [],
  };
}

function stateKey(adapter, role) {
  return `${adapter}:${role}`;
}

function freshEntry(taskId) {
  return {
    tier: "paid",
    index: 0,
    attempts: 0,
    switched_count: 0,
    last_switched_at: null,
    reason: null,
    task_id: taskId ?? null,
    override: null,
  };
}

function bare(modelId) {
  return String(modelId).replace(/^(?:opencode-go|opencode)\//, "");
}

// Reset a role's pointer to the head when the current task differs from the one
// the pointer was last advanced under. A missing/`null` stored task id is not a
// change (first use), so it never resets. This is what keeps a temporary limit
// in task A from stranding task B on a fallback model.
export function syncTaskPointer(state, adapter, role, taskId) {
  const key = stateKey(adapter, role);
  const cur = state.roles[key];
  if (!cur) {
    state.roles[key] = freshEntry(taskId);
    return { reset: false, entry: state.roles[key] };
  }
  if (taskId && cur.task_id && cur.task_id !== taskId) {
    state.roles[key] = { ...freshEntry(taskId), switched_count: cur.switched_count || 0 };
    return { reset: true, entry: state.roles[key] };
  }
  if (taskId && !cur.task_id) cur.task_id = taskId;
  return { reset: false, entry: cur };
}

function modelRejectedForClient(modelId, config, privacy) {
  const maxRetention = config?.client_max_retention_days;
  if (typeof maxRetention !== "number") return "client_max_retention_days is not set";
  const meta = privacy?.[bare(modelId)];
  if (!meta) return "privacy metadata unknown";
  if (meta.trains_on_data === true) return "trains on data";
  if (meta.trains_on_data === null || meta.trains_on_data === undefined) return "training status unknown";
  if (meta.retention_days === null || meta.retention_days === undefined) return "retention unknown";
  if (meta.retention_days > maxRetention) return `retention ${meta.retention_days}d > ${maxRetention}d`;
  return null;
}

// First index >= fromIndex+1 whose model is allowed by the client policy.
// fromIndex = -1 means "start at the head". Returns null when none remain.
function nextAllowed(chain, fromIndex, client, mcfg, privacy) {
  let idx = fromIndex + 1;
  if (client) while (idx < chain.length && modelRejectedForClient(chain[idx], mcfg, privacy)) idx++;
  return idx < chain.length ? idx : null;
}

// Pure validation. `known`/`freeKnown` are injectable so `--refresh` can swap in
// a freshly fetched list.
export function checkModels(
  config,
  { client = false, privacy = MODEL_PRIVACY, known = KNOWN_MODELS, freeKnown = FREE_MODELS } = {},
) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== "object") {
    return { ok: false, errors: ["models.json is empty or not an object"], warnings };
  }
  if (config.version !== MODELS_SCHEMA_VERSION) {
    errors.push(`unsupported version: ${JSON.stringify(config.version)} (expected ${MODELS_SCHEMA_VERSION})`);
  }
  if (!config.adapters || typeof config.adapters !== "object") {
    errors.push("missing adapters object");
    return { ok: errors.length === 0, errors, warnings };
  }
  if (client && typeof config.client_max_retention_days !== "number") {
    errors.push("client mode requires client_max_retention_days (explicit, fail-closed)");
  }

  for (const [adapter, a] of Object.entries(config.adapters)) {
    if (!ADAPTER_DIRS[adapter]) warnings.push(`unknown adapter: ${adapter}`);
    if (!a || typeof a !== "object" || !a.roles) {
      warnings.push(`adapter ${adapter} has no roles`);
      continue;
    }
    for (const [role, r] of Object.entries(a.roles)) {
      const paid = Array.isArray(r?.paid) ? r.paid : (Array.isArray(r?.go) ? r.go : []);
      const free = Array.isArray(r?.free) ? r.free : [];
      if (paid.length === 0 && free.length === 0) {
        warnings.push(`adapter ${adapter} role ${role} has no paid or free chain (skipped by apply/next)`);
        continue;
      }
      for (const mid of paid) {
        if (typeof mid !== "string") {
          warnings.push(`paid chain entry is not a string: ${JSON.stringify(mid)}`);
          continue;
        }
        // OpenCode Go ids are namespaced and checked against the known list.
        if (adapter === "opencode" && mid.startsWith("opencode-go/")) {
          if (!known.includes(bare(mid))) warnings.push(`unknown paid model id: ${mid}`);
        } else if (adapter === "opencode" && mid.startsWith("opencode/")) {
          // OpenCode Zen paid model: no curated known list; only privacy metadata.
          if (!privacy?.[bare(mid)]) warnings.push(`paid model has no privacy metadata: ${mid}`);
        } else if (adapter === "cursor") {
          if (!privacy?.[mid]) warnings.push(`paid model has no privacy metadata: ${mid}`);
        }
        if (client) {
          const reason = modelRejectedForClient(mid, config, privacy);
          if (reason) errors.push(`client policy rejects ${mid} in ${adapter}/${role}: ${reason}`);
        }
      }
      for (const mid of free) {
        if (typeof mid !== "string" || !mid.startsWith("opencode/")) {
          warnings.push(`free chain id should be namespaced opencode/<id>: ${mid}`);
        } else if (!freeKnown.includes(bare(mid))) {
          warnings.push(`free model not in known set (list rotates): ${mid}`);
        }
        if (client) {
          const reason = modelRejectedForClient(mid, config, privacy);
          if (reason) errors.push(`client policy rejects ${mid} in ${adapter}/${role}: ${reason}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

// Rewrite `model:` in an agent file (atomic + .bak). Missing files are skipped;
// the caller decides whether that is acceptable.
function applyModelToAgent(root, adapter, role, model) {
  const dir = ADAPTER_DIRS[adapter];
  if (!dir) return { ok: false, error: `unknown adapter ${adapter}` };
  const file = path.join(root, dir, `${role}.md`);
  if (!exists(file)) return { ok: false, error: "no agent file", file };
  const before = readText(file);
  if (before !== null) writeTextAtomic(file + ".bak", before);
  setFrontmatterKey(file, "model", model);
  return { ok: true, file };
}

function currentModel(entry, paid, free) {
  if (entry.override) return entry.override;
  const chain = entry.tier === "free" ? free : paid;
  return chain[entry.index] || null;
}

// `models` command. Returns an exit code and emits JSON via `emit`.
export function modelsCommand(root, config, flags, json, { emit, currentTaskId } = {}) {
  const sub = flags.sub || "show";
  const client = flags.client === true || flags.client === "true";
  const privacy = MODEL_PRIVACY;

  const mc = loadModelsConfig(root);
  if (!mc.ok) {
    emit({ ok: false, error: `models.json ${mc.error}`, path: path.relative(root, mc.path), hint: "install copies .agent/models.json; or create it" }, json);
    return 2;
  }
  const mcfg = mc.value;
  const ms = loadModelsState(root, config);
  const state = ms.value;

  if (sub === "show") {
    const taskId = currentTaskId ? currentTaskId(root, config) : null;
    const view = {};
    for (const [adapter, a] of Object.entries(mcfg.adapters || {})) {
      for (const role of Object.keys(a.roles || {})) {
        const { paid, free } = chainsOf(mcfg, adapter, role);
        const key = stateKey(adapter, role);
        const { entry } = syncTaskPointer(state, adapter, role, taskId);
        view[key] = {
          paid,
          free,
          tier: entry.tier,
          index: entry.index,
          current: currentModel(entry, paid, free),
          override: entry.override,
          switched_count: entry.switched_count || 0,
          last_switched_at: entry.last_switched_at || null,
        };
      }
    }
    emit({ ok: true, config: mcfg, roles: view, task_id: taskId }, json);
    return 0;
  }

  if (sub === "check") {
    const res = checkModels(mcfg, { client, privacy, known: KNOWN_MODELS, freeKnown: FREE_MODELS });
    emit({ ok: res.ok, errors: res.errors, warnings: res.warnings, client }, json);
    return res.ok ? 0 : 1;
  }

  if (sub === "next") {
    const role = flags.role;
    if (!role) {
      emit({ ok: false, error: "--role required for next" }, json);
      return 2;
    }
    const taskId = currentTaskId ? currentTaskId(root, config) : null;
    const moved = [];
    const skipped = [];
    let anyChain = false;
    let anyExhausted = false;
    let resetHappened = false;

    for (const adapter of Object.keys(mcfg.adapters || {})) {
      const { paid, free } = chainsOf(mcfg, adapter, role);
      if (paid.length === 0 && free.length === 0) {
        skipped.push(adapter);
        continue;
      }
      anyChain = true;
      const key = stateKey(adapter, role);
      const { reset, entry } = syncTaskPointer(state, adapter, role, taskId);
      if (reset) {
        // New task: the pointer returned to the primary model; do not advance.
        resetHappened = true;
        const head = paid[0] || free[0];
        const applied = applyModelToAgent(root, adapter, role, head);
        moved.push({ adapter, role, tier: entry.tier, model: head, reason: "task reset", applied: applied.ok, file: applied.ok ? path.relative(root, applied.file) : undefined });
        continue;
      }

      // Manual override: clear it and resume the chain from its head.
      if (entry.override) {
        entry.override = null;
        entry.tier = "paid";
        entry.index = -1;
      }

      let tier = entry.tier === "free" ? "free" : "paid";
      let index = entry.index || 0;
      let model = null;

      if (tier === "paid") {
        if (paid.length === 0) {
          const freeIdx = nextAllowed(free, -1, client, mcfg, privacy);
          if (freeIdx !== null) {
            tier = "free";
            index = freeIdx;
            model = free[freeIdx];
          } else {
            anyExhausted = true;
          }
        } else {
          const paidIdx = nextAllowed(paid, index, client, mcfg, privacy);
          if (paidIdx !== null) {
            tier = "paid";
            index = paidIdx;
            model = paid[paidIdx];
          } else {
            const freeIdx = nextAllowed(free, -1, client, mcfg, privacy);
            if (freeIdx !== null) {
              tier = "free";
              index = freeIdx;
              model = free[freeIdx];
            } else {
              anyExhausted = true;
            }
          }
        }
      } else {
        const freeIdx = nextAllowed(free, index, client, mcfg, privacy);
        if (freeIdx !== null) {
          tier = "free";
          index = freeIdx;
          model = free[freeIdx];
        } else {
          anyExhausted = true;
        }
      }

      if (model) {
        entry.tier = tier;
        entry.index = index;
        entry.attempts = (entry.attempts || 0) + 1;
        entry.switched_count = (entry.switched_count || 0) + 1;
        entry.last_switched_at = new Date().toISOString();
        entry.reason = flags.reason || "manual";
        entry.task_id = taskId ?? entry.task_id ?? null;
        state.roles[key] = entry;
        const applied = applyModelToAgent(root, adapter, role, model);
        moved.push({ adapter, role, tier, model, applied: applied.ok, file: applied.ok ? path.relative(root, applied.file) : undefined });
      }
    }

    saveModelsState(root, config, state);

    if (!anyChain) {
      emit({ ok: false, error: `no chain for role ${role}`, hint: "add paid/free models under adapters.<name>.roles in .agent/models.json" }, json);
      return 1;
    }
    if (moved.length === 0 && anyExhausted) {
      emit({
        ok: false,
        exhausted: true,
        role,
        moved,
        error: "chain exhausted (both tiers)",
        hint: "discrepancy add --type environment --severity blocker; then transition --to blocked",
      }, json);
      return 1;
    }
    emit({ ok: true, role, moved, reset: resetHappened, skipped_adapters: skipped, exhausted: anyExhausted }, json);
    return 0;
  }

  if (sub === "set") {
    const role = flags.role;
    const model = flags.model;
    if (!role || !model) {
      emit({ ok: false, error: "--role and --model required" }, json);
      return 2;
    }
    const applied = [];
    for (const adapter of Object.keys(mcfg.adapters || {})) {
      const { paid, free } = chainsOf(mcfg, adapter, role);
      if (paid.length === 0 && free.length === 0) continue;
      const key = stateKey(adapter, role);
      const entry = state.roles[key] || freshEntry(null);
      entry.override = model;
      entry.tier = "paid";
      entry.index = -1;
      state.roles[key] = entry;
      const a = applyModelToAgent(root, adapter, role, model);
      applied.push({ adapter, applied: a.ok, file: a.ok ? path.relative(root, a.file) : undefined });
    }
    saveModelsState(root, config, state);
    emit({ ok: true, role, model, applied }, json);
    return 0;
  }

  if (sub === "apply") {
    const taskId = currentTaskId ? currentTaskId(root, config) : null;
    const written = [];
    for (const [adapter, a] of Object.entries(mcfg.adapters || {})) {
      for (const role of Object.keys(a.roles || {})) {
        const { paid, free } = chainsOf(mcfg, adapter, role);
        if (paid.length === 0 && free.length === 0) continue;
        const { entry } = syncTaskPointer(state, adapter, role, taskId);
        const model = currentModel(entry, paid, free);
        if (!model) continue;
        const res = applyModelToAgent(root, adapter, role, model);
        written.push({ adapter, role, tier: entry.tier, model, applied: res.ok, file: res.ok ? path.relative(root, res.file) : undefined });
      }
    }
    saveModelsState(root, config, state);
    emit({ ok: true, written }, json);
    return 0;
  }

  emit({ ok: false, error: `unknown models subcommand: ${sub}`, subcommands: ["show", "check", "next", "set", "apply"] }, json);
  return 2;
}
