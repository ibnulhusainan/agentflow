import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { tmpRoot, makeTask, baseState, baseResult, TASK_ID, readJson, capture } from "./helpers.mjs";
import { run } from "../cli.mjs";

test("init creates the knowledge index", () => {
  const root = tmpRoot();
  const { code, out } = capture(() => run(["init", "--root", root, "--json"]));
  assert.equal(code, 0);
  assert.ok(fs.existsSync(path.join(root, ".agent/knowledge/index.json")));
  assert.match(out, /created/);
});

test("task new creates the task record that every gate requires", () => {
  // Regression: `state.json` had no CLI command, so validate/transition/close
  // all failed with "state.json: missing" and the Conductor had to hand-write it.
  const root = tmpRoot();
  const { code, out } = capture(() =>
    run(["task", "new", "--files", "8", "--request", "add feature A", "--root", root, "--json"])
  );
  assert.equal(code, 0);
  const d = JSON.parse(out);
  assert.match(d.task_id, /^T-\d{8}-001$/);
  assert.equal(d.status, "pending");
  assert.equal(d.size, "medium");
  assert.equal(d.plan_required, true);
  assert.equal(d.next, "planner");

  // The record must satisfy the gates that previously refused to run.
  const statePath = path.join(root, ".agent/tasks", d.task_id, "state.json");
  assert.ok(fs.existsSync(statePath));
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.task_id, d.task_id);
  assert.equal(state.history.length, 1);
  assert.equal(state.history[0].from, null);
  assert.equal(state.history[0].to, "pending");
  assert.equal(state.counters.attempts_total, 0);
  assert.ok(fs.existsSync(path.join(root, ".agent/tasks", d.task_id, "request.md")));

  const tr = capture(() => run(["transition", "--task", d.task_id, "--to", "in_progress", "--by", "conductor", "--root", root, "--json"]));
  assert.equal(tr.code, 0);
});

test("task new: small task skips planning, ids increment, duplicates rejected", () => {
  const root = tmpRoot();
  const small = JSON.parse(capture(() => run(["task", "new", "--files", "1", "--root", root, "--json"])).out);
  assert.equal(small.size, "small");
  assert.equal(small.plan_required, false);
  assert.equal(small.next, "executor");

  const second = JSON.parse(capture(() => run(["task", "new", "--root", root, "--json"])).out);
  assert.equal(second.task_id.slice(-3), "002");

  const dup = capture(() => run(["task", "new", "--id", second.task_id, "--root", root, "--json"]));
  assert.equal(dup.code, 1);
  assert.match(dup.out, /already exists/);
});

test("status reports knowledge states", () => {
  const root = tmpRoot();
  fs.mkdirSync(path.join(root, ".agent/knowledge"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".agent/knowledge/index.json"),
    JSON.stringify({ schema_version: 1, generated_at: "2026-10-16T00:00:00Z", entries: [
      { id: "k-x", path: ".agent/knowledge/facts/x.json", type: "facts", scope: ["a/**"], owner: "analyzer", revision: { git_commit: null, content_hash: "sha256:x" }, status: "fresh", last_validated: "2026-10-16T00:00:00Z" },
    ] }),
  );
  const { code, out } = capture(() => run(["status", "--root", root, "--json"]));
  assert.equal(code, 0);
  const data = JSON.parse(out);
  assert.equal(data.summary.missing, 1);
});

test("classify: small/medium/complex", () => {
  const root = tmpRoot();
  const small = JSON.parse(capture(() => run(["classify", "--files", "2", "--root", root, "--json"])).out);
  assert.equal(small.size, "small");
  assert.equal(small.plan_required, false);
  const medium = JSON.parse(capture(() => run(["classify", "--files", "8", "--root", root, "--json"])).out);
  assert.equal(medium.size, "medium");
  assert.equal(medium.plan_required, true);
  const complex = JSON.parse(capture(() => run(["classify", "--files", "50", "--root", root, "--json"])).out);
  assert.equal(complex.size, "complex");
});

test("classify: cross-module forces non-small", () => {
  const root = tmpRoot();
  const data = JSON.parse(capture(() => run(["classify", "--files", "1", "--cross-module", "--root", root, "--json"])).out);
  assert.equal(data.plan_required, true);
  assert.equal(data.size, "medium");
});

test("validate: exit 0 for valid task, 1 for invalid", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, { "state.json": baseState() });
  const okRes = capture(() => run(["validate", TASK_ID, "--root", root, "--json"]));
  assert.equal(okRes.code, 0);

  makeTask(root, "T-20261016-901", {
    "state.json": baseState({
      task_id: "T-20261016-901",
      status: "completed",
      history: [
        { at: "2026-10-16T00:00:00Z", from: null, to: "pending", by: "t" },
        { at: "2026-10-16T00:01:00Z", from: "pending", to: "completed", by: "t" },
      ],
    }),
  });
  const badRes = capture(() => run(["validate", "T-20261016-901", "--root", root, "--json"]));
  assert.equal(badRes.code, 1);
});

test("transition: legal accepted, illegal rejected", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, { "state.json": baseState() });
  const ok = capture(() => run(["transition", "--task", TASK_ID, "--to", "in_progress", "--root", root, "--json"]));
  assert.equal(ok.code, 0);
  const illegal = capture(() => run(["transition", "--task", TASK_ID, "--to", "completed", "--root", root, "--json"]));
  assert.equal(illegal.code, 1);
});

test("close: rejected when verification missing", () => {
  const root = tmpRoot();
  const st = baseState({ status: "review" });
  makeTask(root, TASK_ID, { "state.json": st });
  const res = capture(() => run(["close", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(res.code, 1);
  assert.match(res.out, /closure gates failed/);
});

test("close: accepted for verified small task", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, { "state.json": baseState({ status: "review" }), "result.json": baseResult() });
  const res = capture(() => run(["close", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(res.code, 0);
  assert.equal(readJson(path.join(root, ".agent/tasks", TASK_ID, "state.json")).status, "completed");
});

test("attempt: retry limit blocks after max_attempts", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, {
    "state.json": baseState({ status: "in_progress" }),
    "progress.json": {
      schema_version: 1,
      task_id: TASK_ID,
      updated_at: "2026-10-16T00:00:00Z",
      items: { P1: { status: "in_progress", attempts: 0, updated_at: "2026-10-16T00:00:00Z" } },
      next_action: { item_id: "P1", action: "do", blocked_by: [] },
    },
  });
  let last;
  for (let i = 0; i < 4; i++) {
    last = capture(() => run(["attempt", "--task", TASK_ID, "--item", "P1", "--root", root, "--json"]));
  }
  assert.equal(last.code, 1);
  const st = readJson(path.join(root, ".agent/tasks", TASK_ID, "state.json"));
  assert.equal(st.status, "blocked");
  assert.equal(st.counters.attempts_total, 4);
});

test("spawn: denied by default (max_children=0)", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, { "state.json": baseState({ status: "in_progress" }) });
  const res = capture(() => run(["spawn", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(res.code, 1);
  assert.match(res.out, /max_children exceeded/);
});

test("discrepancy add writes a D1 entry", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, { "state.json": baseState() });
  const res = capture(() =>
    run(["discrepancy", "add", "--task", TASK_ID, "--severity", "major", "--type", "knowledge", "--summary", "s", "--evidence", "e", "--root", root, "--json"]),
  );
  assert.equal(res.code, 0);
  const doc = readJson(path.join(root, ".agent/tasks", TASK_ID, "discrepancies.json"));
  assert.equal(doc.items[0].id, "D1");
});

test("unknown command -> usage exit 2", () => {
  const root = tmpRoot();
  const res = capture(() => run(["bogus", "--root", root, "--json"]));
  assert.equal(res.code, 2);
});
