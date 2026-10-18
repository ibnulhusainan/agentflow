import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpRoot, makeTask, baseState, baseResult, TASK_ID, readJson, capture } from "./helpers.mjs";
import { run } from "../cli.mjs";

const NOW = "2026-10-16T00:00:00Z";

// Small task (no plan) with a valid result: closable once the budget is met.
function makeSmallTask(root) {
  return makeTask(root, TASK_ID, {
    "state.json": baseState({
      status: "review",
      history: [
        { at: NOW, from: null, to: "pending", by: "test" },
        { at: NOW, from: "pending", to: "in_progress", by: "test" },
        { at: NOW, from: "in_progress", to: "review", by: "test" },
      ],
    }),
    "result.json": baseResult(),
  });
}

// Planned task: P1 done, P2 open with a next_action.
function makePlannedTask(root) {
  return makeTask(root, TASK_ID, {
    "state.json": baseState({
      status: "in_progress",
      plan_required: true,
      history: [
        { at: NOW, from: null, to: "pending", by: "test" },
        { at: NOW, from: "pending", to: "in_progress", by: "test" },
      ],
    }),
    "plan.json": {
      schema_version: 1,
      task_id: TASK_ID,
      status: "approved",
      created_at: NOW,
      approved_at: NOW,
      scope: ["a.js"],
      knowledge_refs: ["k-repo-structure"],
      acceptance_criteria: [{ id: "AC1", description: "works" }],
      verification: { commands: [{ cmd: "node --test", expect_exit: 0 }] },
      items: [
        {
          id: "P1",
          title: "First",
          description: "first item",
          paths: ["a.js"],
          knowledge_refs: ["k-repo-structure"],
          depends_on: [],
          completion_criterion: "node --test passes",
          status: "done",
        },
        {
          id: "P2",
          title: "Second",
          description: "second item",
          paths: ["b.js"],
          knowledge_refs: ["k-repo-structure"],
          depends_on: ["P1"],
          completion_criterion: "node --test passes",
          status: "pending",
        },
      ],
    },
    "progress.json": {
      schema_version: 1,
      task_id: TASK_ID,
      updated_at: NOW,
      items: { P1: { status: "done", attempts: 1, updated_at: NOW, evidence: "ok" } },
      next_action: { item_id: "P2", action: "Implement b.js", blocked_by: [] },
    },
  });
}

const parse = (out) => JSON.parse(out);

test("context: emits one minimal resume bundle", () => {
  const root = tmpRoot();
  makePlannedTask(root);
  const { code, out } = capture(() => run(["context", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(code, 0);
  const d = parse(out);
  assert.equal(d.ok, true);
  assert.equal(d.status, "in_progress");
  assert.equal(d.next_action.item_id, "P2");
  assert.equal(d.item.id, "P2");
  assert.deepEqual(d.item.paths, ["b.js"]);
  assert.deepEqual(d.open_items, ["P2"]);
  assert.equal(d.budget.present, false);
  assert.deepEqual(d.budget.exceeded, []);
  assert.ok(d.knowledge_refs.includes("k-repo-structure"));
});

test("context: unknown item is rejected", () => {
  const root = tmpRoot();
  makePlannedTask(root);
  const { code, out } = capture(() =>
    run(["context", "--task", TASK_ID, "--item", "P9", "--root", root, "--json"]),
  );
  assert.equal(code, 1);
  assert.equal(parse(out).ok, false);
});

test("usage add: cumulative per-item totals and exit 0 within budget", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  let r = capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "10", "--input", "1000", "--output", "500", "--cache-read", "4000", "--root", root, "--json"]),
  );
  assert.equal(r.code, 0);
  assert.ok(fs.existsSync(path.join(root, ".agent/tasks", TASK_ID, "usage.json")));

  // Same item again with higher numbers: totals reflect the maximum, not the sum.
  r = capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "15", "--input", "2000", "--output", "700", "--root", root, "--json"]),
  );
  assert.equal(r.code, 0);

  const doc = readJson(path.join(root, ".agent/tasks", TASK_ID, "usage.json"));
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].requests, 15);
  assert.equal(doc.items[0].input_tokens, 2000);
  assert.equal(doc.totals.requests, 15);
  assert.equal(doc.totals.output_tokens, 700);
  assert.equal(doc.totals.cache_read_tokens, 4000);
});

test("usage add: rejects malformed item id and non-numeric input", () => {
  const root = tmpRoot();
  makePlannedTask(root);
  let r = capture(() => run(["usage", "add", "--task", TASK_ID, "--item", "x", "--requests", "3", "--root", root, "--json"]));
  assert.equal(r.code, 2);
  r = capture(() => run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "abc", "--root", root, "--json"]));
  assert.equal(r.code, 2);
  r = capture(() => run(["usage", "add", "--task", TASK_ID, "--item", "P9", "--requests", "1", "--root", root, "--json"]));
  assert.equal(r.code, 1); // item not in the approved plan
});

test("usage check: exit 0 within budget, exit 1 when a ceiling is passed", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "5", "--input", "1000", "--output", "500", "--root", root, "--json"]),
  );
  let r = capture(() => run(["usage", "check", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(r.code, 0);
  assert.equal(parse(r.out).exceeded.length, 0);

  // Default budget: max_requests_per_item = 25.
  capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "30", "--root", root, "--json"]),
  );
  r = capture(() => run(["usage", "check", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(r.code, 1);
  const d = parse(r.out);
  assert.equal(d.exceeded[0].field, "requests");
  assert.ok(d.exceeded[0].value > d.exceeded[0].limit);
});

test("usage check: exit 0 when no usage has been recorded", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  const { code, out } = capture(() => run(["usage", "check", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(code, 0);
  assert.equal(parse(out).present, false);
});

test("context: exits 1 when the item's budget is already exceeded", () => {
  const root = tmpRoot();
  makePlannedTask(root);
  capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P2", "--requests", "30", "--root", root, "--json"]),
  );
  const { code, out } = capture(() => run(["context", "--task", TASK_ID, "--root", root, "--json"]));
  assert.equal(code, 1);
  const d = parse(out);
  assert.equal(d.ok, true);
  assert.ok(d.budget.exceeded.length > 0);
  assert.equal(d.item.id, "P2");
});

test("close: rejected while budget exceeded", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "30", "--root", root, "--json"]),
  );
  const { code, out } = capture(() => run(["close", "--task", TASK_ID, "--by", "test", "--root", root, "--json"]));
  assert.equal(code, 1);
  const d = parse(out);
  assert.ok(d.reasons.some((r) => r.startsWith("budget exceeded")));
});

test("close: passes once usage is back within budget", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "5", "--input", "100", "--output", "50", "--root", root, "--json"]),
  );
  const { code, out } = capture(() => run(["close", "--task", TASK_ID, "--by", "test", "--root", root, "--json"]));
  assert.equal(code, 0);
  assert.equal(parse(out).status, "completed");
});

test("close: gate can be disabled via budget.enforce_on_close=false", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  fs.writeFileSync(
    path.join(root, ".agent", "config.json"),
    JSON.stringify({ schema_version: 1, small_task: { max_files: 3 }, limits: { max_attempts: 3, max_spawn_depth: 1, max_children: 0 }, verify: { commands: [] }, budget: { enforce_on_close: false } }, null, 2),
  );
  capture(() =>
    run(["usage", "add", "--task", TASK_ID, "--item", "P1", "--requests", "30", "--root", root, "--json"]),
  );
  const { code } = capture(() => run(["close", "--task", TASK_ID, "--by", "test", "--root", root, "--json"]));
  assert.equal(code, 0);
});

test("validate: accepts a well-formed usage.json and rejects a malformed one", () => {
  const root = tmpRoot();
  makeSmallTask(root);
  const dir = path.join(root, ".agent", "tasks", TASK_ID);

  fs.writeFileSync(
    path.join(dir, "usage.json"),
    JSON.stringify({
      schema_version: 1,
      kind: "usage",
      task_id: TASK_ID,
      updated_at: NOW,
      items: [{ item_id: "P1", requests: 3, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, note: null }],
      totals: { requests: 3, input_tokens: 10, output_tokens: 5, cache_read_tokens: 0 },
    }, null, 2),
  );
  let r = capture(() => run(["validate", TASK_ID, "--root", root, "--json"]));
  assert.equal(r.code, 0, parse(r.out).errors?.join("; "));

  // Malformed: totals missing required counters.
  fs.writeFileSync(
    path.join(dir, "usage.json"),
    JSON.stringify({ schema_version: 1, kind: "usage", task_id: TASK_ID, updated_at: NOW, items: [], totals: {} }, null, 2),
  );
  r = capture(() => run(["validate", TASK_ID, "--root", root, "--json"]));
  assert.equal(r.code, 1);
  assert.ok(parse(r.out).errors.some((e) => e.startsWith("usage.json")));
});
