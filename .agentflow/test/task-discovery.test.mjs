import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpRoot, capture } from "./helpers.mjs";
import { run } from "../cli.mjs";
import { listTasks, currentTaskId } from "../lib/task.mjs";
import { loadConfig } from "../lib/config.mjs";

// Manual operation ("run one role at a time, no Conductor") is a supported mode,
// so the core must be able to answer "which task am I on?" on its own. Without
// it every manual caller had to remember an ID — the reason the Planner used to
// stall instead of starting.

const cfg = (root) => loadConfig(root).config;
const json = (out) => JSON.parse(out);

test("task list is empty and task current fails cleanly with no tasks", () => {
  const root = tmpRoot();
  const list = capture(() => run(["task", "list", "--root", root, "--json"]));
  assert.equal(list.code, 0);
  assert.equal(json(list.out).count, 0);

  const cur = capture(() => run(["task", "current", "--root", root, "--json"]));
  assert.equal(cur.code, 1);
  assert.match(cur.out, /no task found/);
  assert.match(cur.out, /task new/);
});

test("task list reports each record's status and size", () => {
  const root = tmpRoot();
  capture(() => run(["task", "new", "--files", "1", "--request", "small one", "--root", root, "--json"]));
  capture(() => run(["task", "new", "--files", "40", "--request", "big one", "--root", root, "--json"]));

  const { code, out } = capture(() => run(["task", "list", "--root", root, "--json"]));
  assert.equal(code, 0);
  const { tasks } = json(out);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].plan_required, false);
  assert.equal(tasks[1].plan_required, true);
  assert.equal(tasks[1].size, "complex");
  for (const t of tasks) assert.match(t.status, /^(pending|in_progress|blocked|review|completed|reopened)$/);
});

test("task current returns the newest task and its next actor", () => {
  const root = tmpRoot();
  capture(() => run(["task", "new", "--files", "1", "--request", "a", "--root", root, "--json"]));
  const { out } = capture(() => run(["task", "new", "--files", "40", "--request", "b", "--root", root, "--json"]));
  const created = json(out);

  const cur = capture(() => run(["task", "current", "--root", root, "--json"]));
  assert.equal(cur.code, 0);
  assert.equal(json(cur.out).task_id, created.task_id);
  assert.equal(json(cur.out).next_action, "planner");
  assert.equal(currentTaskId(root, cfg(root)), created.task_id);
});

test("--task current resolves for every command that takes a task id", () => {
  const root = tmpRoot();
  const made = capture(() => run(["task", "new", "--files", "1", "--request", "manual", "--root", root, "--json"]));
  const id = json(made.out).task_id;

  const t = capture(() => run(["transition", "--task", "current", "--to", "in_progress", "--by", "planner", "--root", root, "--json"]));
  assert.equal(t.code, 0);
  assert.equal(json(t.out).task_id, id);
  assert.equal(json(t.out).status, "in_progress");

  const c = capture(() => run(["context", "--task", "current", "--root", root, "--json"]));
  assert.equal(c.code, 0);
  assert.equal(json(c.out).task_id, id);
});

test("--task current reports a hint instead of a usage error when nothing exists", () => {
  const root = tmpRoot();
  const r = capture(() => run(["context", "--task", "current", "--root", root, "--json"]));
  assert.equal(r.code, 1);
  assert.match(r.out, /no current task/);
  assert.match(r.out, /task new --request/);
});

test("an explicit task id always wins over `current`", () => {
  const root = tmpRoot();
  const first = json(capture(() => run(["task", "new", "--files", "1", "--request", "a", "--root", root, "--json"])).out);
  capture(() => run(["task", "new", "--files", "40", "--request", "b", "--root", root, "--json"]));

  // `task new` stamps `updated_at` from the clock (ms resolution), so the two
  // creations can land in the same millisecond. Pin the second task to an
  // unambiguously older timestamp so "most recently updated" is deterministic.
  const secondId = json(capture(() => run(["task", "list", "--root", root, "--json"])).out).tasks
    .map((t) => t.task_id)
    .find((id) => id !== first.task_id);
  const secondPath = path.join(root, ".agent", "tasks", secondId, "state.json");
  const secondState = JSON.parse(fs.readFileSync(secondPath, "utf8"));
  secondState.updated_at = "2000-01-01T00:00:00Z";
  fs.writeFileSync(secondPath, JSON.stringify(secondState, null, 2), "utf8");

  // `current` follows the most recently *updated* open task, so naming the
  // older task explicitly must reach that one, not the current one.
  const r = capture(() => run(["transition", "--task", first.task_id, "--to", "in_progress", "--root", root, "--json"]));
  assert.equal(json(r.out).task_id, first.task_id);
  assert.equal(currentTaskId(root, cfg(root)), first.task_id, "the task just moved is the most recently updated");
});

test("a completed task is still reachable when nothing is open", () => {
  const root = tmpRoot();
  const made = capture(() => run(["task", "new", "--files", "1", "--request", "a", "--root", root, "--json"]));
  const id = json(made.out).task_id;
  capture(() => run(["transition", "--task", id, "--to", "in_progress", "--root", root, "--json"]));

  const statePath = path.join(root, ".agent/tasks", id, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.status = "completed";
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");

  assert.equal(currentTaskId(root, cfg(root)), id, "falls back to the most recent finished task");
  const cur = capture(() => run(["task", "current", "--root", root, "--json"]));
  assert.equal(json(cur.out).task_id, id);
});

test("a corrupt task directory is skipped, not crashed on", () => {
  const root = tmpRoot();
  capture(() => run(["task", "new", "--files", "1", "--request", "a", "--root", root, "--json"]));
  fs.mkdirSync(path.join(root, ".agent/tasks/T-99999999-999"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent/tasks/T-99999999-999/state.json"), "{ not json", "utf8");

  const { code, out } = capture(() => run(["task", "list", "--root", root, "--json"]));
  assert.equal(code, 0);
  assert.equal(json(out).count, 1);
  assert.equal(listTasks(root, cfg(root)).length, 1);
});