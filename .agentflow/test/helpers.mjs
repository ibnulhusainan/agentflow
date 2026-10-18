import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-"));
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text, "utf8");
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function capture(fn) {
  const orig = process.stdout.write;
  let out = "";
  process.stdout.write = (s) => {
    out += s;
    return true;
  };
  try {
    const code = fn();
    return { code, out };
  } finally {
    process.stdout.write = orig;
  }
}

export const TASK_ID = "T-20261016-900";

export function baseState(over = {}) {
  return {
    schema_version: 1,
    task_id: TASK_ID,
    reopened_from: null,
    status: "pending",
    size: "small",
    plan_required: false,
    created_at: "2026-10-16T00:00:00Z",
    updated_at: "2026-10-16T00:00:00Z",
    history: [{ at: "2026-10-16T00:00:00Z", from: null, to: "pending", by: "test" }],
    counters: { attempts_total: 0, max_attempts: 3, spawn_depth: 0, max_spawn_depth: 1, children: 0, max_children: 0 },
    ...over,
  };
}

export function baseResult(over = {}) {
  return {
    schema_version: 1,
    task_id: TASK_ID,
    status: "completed",
    summary: "done",
    changed_files: ["a.js"],
    knowledge_refs: [],
    verification: {
      commands: [{ cmd: "node --test", exit_code: 0, result: "pass" }],
      passed: true,
      performed_at: "2026-10-16T00:00:00Z",
    },
    acceptance_criteria: [{ id: "AC1.1", met: true, evidence: "test pass" }],
    limitations: [],
    follow_ups: [],
    completed_at: "2026-10-16T00:00:00Z",
    ...over,
  };
}

export function makeTask(root, id, files) {
  const dir = path.join(root, ".agent", "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, obj] of Object.entries(files)) writeJson(path.join(dir, name), obj);
  return dir;
}
