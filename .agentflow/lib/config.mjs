import path from "node:path";
import { readJson } from "./fsutil.mjs";

export const DEFAULTS = Object.freeze({
  schema_version: 1,
  state_root: ".agent",
  small_task: {
    max_files: 3,
    max_changed_lines: 200,
    forbid_cross_module: true,
    forbid_contract_change: true,
  },
  limits: {
    max_attempts: 3,
    max_spawn_depth: 1,
    max_children: 0,
  },
  // Per-item ceilings recorded in `.agent/tasks/<id>/usage.json` (self-reported
  // by the agent, enforced by `usage check` and the close gate).
  budget: {
    max_requests_per_item: 25,
    max_input_tokens_per_item: 60000,
    max_output_tokens_per_item: 25000,
    warn_ratio: 0.8,
    enforce_on_close: true,
  },
  // Advisory resume-context limits used by `usage check` / `context`.
  context: {
    max_context_tokens: 60000,
    compact_at_percent: 70,
  },
  verify: { commands: [] },
  exclude: [
    "node_modules/**",
    ".git/**",
    // The workflow's own artefacts must never invalidate knowledge about the
    // project they analyse: editing them changes their mtime, so every entry
    // would read stale forever and the tripwire would be useless.
    ".agent/**",
    // The installed core itself — same reasoning as the state dir.
    ".agentflow/**",
    ".agentflow-backup/**",
    // Installed adapters — same reasoning: a plugin/hook edit says nothing
    // about the application's code.
    ".opencode/**",
    ".cursor/**",
    // The OpenCode agent config lands at the project root; it is part of the
    // workflow installation, not the application.
    "opencode.jsonc",
  ],
  // Agent roster. Core roles (consultant, conductor, analyzer, planner, executor,
  // reviewer) are required and locked as keys; only agent/enabled/order are
  // editable. Additional entries are custom agents (spawnable, not workflow
  // steps). See docs.
  agents: {
    consultant: { agent: "consultant", order: 0, enabled: true },
    conductor:  { agent: "conductor",  order: 1, enabled: true },
    analyzer:   { agent: "analyzer",   order: 2, enabled: true },
    planner:    { agent: "planner",    order: 3, enabled: true },
    executor:   { agent: "executor",   order: 4, enabled: true },
    reviewer:   { agent: "reviewer",   order: 5, enabled: true },
  },
  medium_max_files: 15,
  // Deterministic fact generators run by `agentflow facts`. Keys are kind names
  // (see .agentflow/README.md); every kind is project-agnostic and fully
  // configurable here — override scope, ids, role rules, route signals or
  // schema extractors per project. Arrays replace defaults (no merge).
  facts: {
    "repo-structure": { enabled: true, id: "k-repo-structure", scope: [] },
    inventory: {
      enabled: true,
      id: "k-inventory",
      scope: ["**/*"],
      tsconfig: "tsconfig.json",
      role_patterns: [
        { role: "route", patterns: ["**/route.ts", "**/route.tsx", "**/route.js", "**/route.jsx"] },
        { role: "page", patterns: ["**/page.ts", "**/page.tsx", "**/page.js", "**/page.jsx"] },
        { role: "test", patterns: ["**/*.test.*", "**/__tests__/**"] },
        { role: "component", patterns: ["**/components/**"] },
        { role: "migration", patterns: ["**/migrations/**", "**/*.sql"] },
        { role: "script", patterns: ["scripts/**"] },
        { role: "config", patterns: ["**/*.config.js", "**/*.config.mjs", "**/*.config.cjs", "**/*.config.ts", "**/package.json"] },
        { role: "lib", patterns: ["lib/**", "src/lib/**"] },
      ],
    },
    imports: {
      enabled: true,
      id: "k-imports",
      scope: ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"],
    },
    routes: {
      enabled: true,
      id: "k-routes",
      scope: ["**/route.ts", "**/route.tsx", "**/route.js", "**/route.jsx"],
      page_scope: ["**/page.ts", "**/page.tsx", "**/page.js", "**/page.jsx"],
      app_dir: null,
      method_pattern: "^export\\s+(?:async\\s+)?function\\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\b",
      signals: {},
    },
    schema: {
      enabled: true,
      id: "k-schema",
      scope: [],
      extractors: [],
      migration_globs: ["**/*.sql"],
      db_files: [],
    },
    "verify-state": { enabled: true, id: "k-verify-state", tasks_dir: null },
  },
});

function deepMerge(base, over) {
  if (over === null || over === undefined) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = base?.[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = deepMerge(b, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function stateRoot(root, config) {
  return path.join(root, config?.state_root ?? DEFAULTS.state_root);
}

export function configPath(root) {
  return path.join(root, DEFAULTS.state_root, "config.json");
}

export const CORE_AGENT_ROLES = Object.freeze([
  "consultant", "conductor", "analyzer", "planner", "executor", "reviewer",
]);

export function validateAgents(config) {
  const errors = [];
  const agents = config?.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    errors.push("agents must be an object");
    return { ok: false, errors };
  }
  for (const role of CORE_AGENT_ROLES) {
    if (!(role in agents)) errors.push(`missing core agent role: ${role}`);
  }
  const orders = new Set();
  for (const [role, spec] of Object.entries(agents)) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      errors.push(`agent spec for ${role} must be an object`);
      continue;
    }
    if (typeof spec.agent !== "string" || spec.agent.trim() === "") {
      errors.push(`agent.agent must be a non-empty string (${role})`);
    }
    if (!Number.isInteger(spec.order) || spec.order < 0) {
      errors.push(`agent.order must be a non-negative integer (${role})`);
    } else {
      if (orders.has(spec.order)) errors.push(`duplicate agent.order: ${spec.order}`);
      orders.add(spec.order);
    }
    if (typeof spec.enabled !== "boolean") {
      errors.push(`agent.enabled must be a boolean (${role})`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function loadConfig(root) {
  const r = readJson(configPath(root));
  const warnings = [];
  if (!r.ok && r.error === "parse") {
    // Hard error: do NOT silently fall back to defaults, because that would
    // discard verify.commands, knowledge scope, budget, etc. without the user
    // noticing. Caller must surface this and stop.
    return { ok: false, config: null, warnings: ["config.json is malformed; refusing to use defaults"], error: "config.json is malformed" };
  }
  const user = r.ok && r.value && typeof r.value === "object" ? r.value : {};
  if (!r.ok) warnings.push("config.json is missing; using defaults");
  const merged = deepMerge(DEFAULTS, user);
  const v = validateAgents(merged);
  if (!v.ok) {
    return { ok: false, config: null, warnings: v.errors, error: `config.json invalid: ${v.errors.join("; ")}` };
  }
  return { ok: true, config: merged, warnings };
}
