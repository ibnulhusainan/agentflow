import path from "node:path";
import { readdirSync } from "node:fs";
import { readJson } from "./fsutil.mjs";
import { stateRoot } from "./config.mjs";
import { validateDef } from "./schema.mjs";
import { checkUsage } from "./usage.mjs";

export const TASK_STATUSES = ["pending", "in_progress", "blocked", "review", "completed", "reopened"];

export const TRANSITIONS = Object.freeze({
  pending: ["in_progress"],
  in_progress: ["blocked", "review", "in_progress"],
  blocked: ["in_progress", "review"],
  review: ["completed", "in_progress"],
  completed: ["reopened"],
  reopened: ["in_progress"],
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function taskDir(root, config, id) {
  return path.join(stateRoot(root, config), "tasks", id);
}

const TASK_FILES = {
  plan: "plan.json",
  progress: "progress.json",
  state: "state.json",
  discrepancies: "discrepancies.json",
  result: "result.json",
  usage: "usage.json",
};

export function loadTask(root, config, id) {
  const dir = taskDir(root, config, id);
  const out = { dir, realm: "task", task_id: id };
  for (const [key, file] of Object.entries(TASK_FILES)) {
    out[key] = readJson(path.join(dir, file));
  }
  return out;
}

// Manual operation must not require remembering task IDs. These two helpers
// let a role (or a person) say "the current task" and have the core resolve it
// from persisted state instead of guessing or re-reading every task directory.
export function listTasks(root, config) {
  const base = path.join(stateRoot(root, config), "tasks");
  let names;
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }
  const out = [];
  for (const id of names.sort()) {
    const read = readJson(path.join(base, id, "state.json"));
    if (!read.ok) continue; // a half-written or corrupt record is not a task
    const state = read.value;
    out.push({
      task_id: id,
      status: state.status ?? null,
      size: state.size ?? null,
      plan_required: state.plan_required ?? null,
      created_at: state.created_at ?? null,
      updated_at: state.updated_at ?? null,
    });
  }
  return out;
}

// `current` = the most recently updated task that is not finished. Falls back to
// the most recent task overall so a closed task is still reachable by name.
export function currentTaskId(root, config) {
  const tasks = listTasks(root, config);
  if (tasks.length === 0) return null;
  const open = tasks.filter((t) => t.status !== "completed");
  const pool = open.length > 0 ? open : tasks;
  const key = (t) => t.updated_at || t.created_at || "";
  return pool.slice().sort((a, b) => key(a).localeCompare(key(b))).at(-1).task_id;
}

// Attempt a lifecycle transition; mutates and returns the new state object.
export function applyTransition(state, to, { by = "unknown", note, at } = {}) {
  const from = state.status;
  const iso = at || new Date().toISOString();
  if (!TASK_STATUSES.includes(to)) return { ok: false, error: `unknown status "${to}"` };
  if (!canTransition(from, to)) return { ok: false, error: `illegal transition ${from} \u2192 ${to}` };
  state.history = Array.isArray(state.history) ? state.history : [];
  state.history.push({ at: iso, from, to, by, ...(note ? { note } : {}) });
  state.status = to;
  state.updated_at = iso;
  return { ok: true, state };
}

function checkHistory(history, errors) {
  if (!Array.isArray(history)) {
    errors.push("state.history must be an array");
    return;
  }
  let prev = null;
  history.forEach((ev, i) => {
    if (i === 0) {
      if (!(ev.from === null && ev.to === "pending")) {
        errors.push(`history[0]: expected null \u2192 pending`);
      }
    } else {
      if (ev.from !== prev) errors.push(`history[${i}]: from "${ev.from}" does not chain from "${prev}"`);
      if (!canTransition(ev.from, ev.to)) errors.push(`history[${i}]: illegal transition ${ev.from} \u2192 ${ev.to}`);
    }
    prev = ev.to;
  });
}

function hasCycle(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const state = new Map(); // 0=visiting, 1=done
  const visit = (id) => {
    if (state.get(id) === 0) return true;
    if (state.get(id) === 1) return false;
    state.set(id, 0);
    for (const dep of byId.get(id)?.depends_on || []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 1);
    return false;
  };
  return items.some((i) => visit(i.id));
}

// Validate a task's artifacts against schemas + semantic rules.
export function validateTask(root, config, id, schema) {
  const errors = [];
  const warnings = [];
  const t = loadTask(root, config, id);

  const structural = [
    ["state", "State", true],
    ["plan", "Plan", false],
    ["progress", "Progress", false],
    ["discrepancies", "DiscrepancyList", false],
    ["result", "Result", false],
    ["usage", "Usage", false],
  ];
  for (const [key, def, required] of structural) {
    const r = t[key];
    if (!r.ok) {
      if (required || r.error === "parse") errors.push(`${TASK_FILES[key]}: ${r.error}`);
      else warnings.push(`${TASK_FILES[key]}: absent`);
      continue;
    }
    for (const e of validateDef(r.value, schema, def)) errors.push(`${TASK_FILES[key]}: ${e}`);
  }

  if (t.state.ok) {
    const state = t.state.value;
    checkHistory(state.history, errors);
  }
  if (t.plan.ok) {
    const plan = t.plan.value;
    const ids = plan.items.map((i) => i.id);
    if (new Set(ids).size !== ids.length) errors.push("plan.json: duplicate item ids");
    for (const item of plan.items) {
      for (const dep of item.depends_on || []) {
        if (!ids.includes(dep)) errors.push(`plan.json: item ${item.id} depends on unknown ${dep}`);
      }
    }
    if (hasCycle(plan.items)) errors.push("plan.json: dependency cycle detected");
    if (t.progress.ok) {
      const known = new Set(t.progress.value.items ? Object.keys(t.progress.value.items) : []);
      for (const k of known) if (!ids.includes(k)) warnings.push(`progress.json: unknown item "${k}" not in plan`);
    }
  }
  // Cross-file task_id consistency.
  const ids = ["state", "plan", "progress", "discrepancies", "result", "usage"]
    .filter((k) => t[k].ok)
    .map((k) => ({ k, id: t[k].value.task_id }))
    .filter((o) => o.id && o.id !== id);
  for (const o of ids) errors.push(`${TASK_FILES[o.k]}: task_id "${o.id}" != "${id}"`);

  return { ok: errors.length === 0, task_id: id, errors, warnings };
}

// Closure gates. Never passes when required verification is missing/failed.
export function checkClosure(root, config, id, schema) {
  const reasons = [];
  const t = loadTask(root, config, id);
  if (!t.state.ok) return { ok: false, task_id: id, passed: false, reasons: ["state.json missing or invalid"] };
  const state = t.state.value;

  if (state.plan_required) {
    if (!t.plan.ok) reasons.push("plan.json missing or invalid (plan_required=true)");
    else if (!t.progress.ok) reasons.push("progress.json missing or invalid");
    else {
      const items = t.plan.value.items || [];
      const prog = t.progress.value.items || {};
      for (const item of items) {
        const p = prog[item.id];
        if (!p) {
          reasons.push(`item ${item.id}: no progress record`);
          continue;
        }
        if (p.status !== "done" && p.status !== "skipped") reasons.push(`item ${item.id}: status "${p.status}" (not done/skipped)`);
        if (p.status === "skipped" && !p.justification) reasons.push(`item ${item.id}: skipped without justification`);
      }
    }
  }

  if (!t.result.ok) {
    reasons.push("result.json missing or invalid");
  } else {
    const r = t.result.value;
    if (r.verification?.passed !== true) reasons.push("verification.passed is not true");
    const cmds = r.verification?.commands;
    if (!Array.isArray(cmds) || cmds.length === 0) reasons.push("no verification commands recorded");
    else for (const c of cmds) if (typeof c.exit_code !== "number") reasons.push(`verification command has no exit_code: ${c.cmd}`);
    const ac = r.acceptance_criteria;
    if (!Array.isArray(ac) || ac.length === 0) reasons.push("no acceptance criteria recorded");
    else
      for (const a of ac) {
        if (a.met !== true) reasons.push(`acceptance ${a.id}: not met`);
        if (!a.evidence) reasons.push(`acceptance ${a.id}: no evidence`);
      }
  }

  if (t.discrepancies.ok) {
    for (const d of t.discrepancies.value.items || []) {
      if (d.status === "open" && d.severity === "blocker") reasons.push(`open blocker discrepancy ${d.id}`);
    }
  }

  const c = state.counters || {};
  if (typeof c.attempts_total === "number" && typeof c.max_attempts === "number" && c.attempts_total > c.max_attempts)
    reasons.push("attempts_total exceeds max_attempts");
  if (typeof c.spawn_depth === "number" && typeof c.max_spawn_depth === "number" && c.spawn_depth > c.max_spawn_depth)
    reasons.push("spawn_depth exceeds max_spawn_depth");
  if (typeof c.children === "number" && typeof c.max_children === "number" && c.children > c.max_children)
    reasons.push("children exceeds max_children");

  // Budget gate: closes only when recorded per-item usage is within
  // `config.budget`. Self-reported numbers, hard-checked by the core.
  if (config?.budget?.enforce_on_close !== false) {
    const chk = checkUsage(root, config, id);
    for (const e of chk.exceeded) {
      reasons.push(`budget exceeded: item ${e.item_id} ${e.field} ${e.value} > ${e.limit}`);
    }
  }

  return { ok: reasons.length === 0, task_id: id, passed: reasons.length === 0, reasons };
}
