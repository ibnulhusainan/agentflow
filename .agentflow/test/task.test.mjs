import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpRoot, makeTask, baseState, baseResult, TASK_ID, readJson } from "./helpers.mjs";
import { canTransition, applyTransition, validateTask, checkClosure } from "../lib/task.mjs";
import { loadConfig } from "../lib/config.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SCHEMA = readJson(path.join(HERE, "..", "schema", "agentflow.schema.json"));
const cfg = () => loadConfig(tmpRoot()).config;

test("allowed transitions", () => {
  assert.equal(canTransition("pending", "in_progress"), true);
  assert.equal(canTransition("in_progress", "review"), true);
  assert.equal(canTransition("in_progress", "blocked"), true);
  assert.equal(canTransition("blocked", "in_progress"), true);
  assert.equal(canTransition("review", "completed"), true);
  assert.equal(canTransition("review", "in_progress"), true);
  assert.equal(canTransition("completed", "reopened"), true);
});

test("illegal transitions rejected", () => {
  assert.equal(canTransition("pending", "completed"), false);
  assert.equal(canTransition("pending", "review"), false);
  assert.equal(canTransition("completed", "in_progress"), false);
  assert.equal(canTransition("blocked", "completed"), false);
});

test("applyTransition mutates state and records history", () => {
  const st = baseState();
  const r = applyTransition(st, "in_progress", { by: "test", at: "2026-10-16T01:00:00Z" });
  assert.equal(r.ok, true);
  assert.equal(st.status, "in_progress");
  assert.equal(st.history.length, 2);
  assert.equal(st.updated_at, "2026-10-16T01:00:00Z");
});

test("applyTransition rejects illegal move", () => {
  const st = baseState();
  const r = applyTransition(st, "completed", {});
  assert.equal(r.ok, false);
  assert.match(r.error, /illegal transition/);
});

test("validateTask: well-formed task passes", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, {
    "state.json": baseState({ status: "in_progress", history: [
      { at: "2026-10-16T00:00:00Z", from: null, to: "pending", by: "t" },
      { at: "2026-10-16T00:01:00Z", from: "pending", to: "in_progress", by: "t" },
    ] }),
  });
  const res = validateTask(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test("validateTask: illegal history detected", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, {
    "state.json": baseState({
      status: "completed",
      history: [
        { at: "2026-10-16T00:00:00Z", from: null, to: "pending", by: "t" },
        { at: "2026-10-16T00:01:00Z", from: "pending", to: "completed", by: "t" },
      ],
    }),
  });
  const res = validateTask(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /illegal transition/.test(e)));
});

test("validateTask: dangling dependency detected", () => {
  const root = tmpRoot();
  const plan = {
    schema_version: 1,
    task_id: TASK_ID,
    status: "approved",
    created_at: "2026-10-16T00:00:00Z",
    approved_at: "2026-10-16T00:00:00Z",
    scope: ["src/**"],
    knowledge_refs: [],
    acceptance_criteria: ["AC1.1 x"],
    verification: ["node --test"],
    items: [
      { id: "P1", title: "a", description: "a", paths: ["a.js"], knowledge_refs: [], depends_on: ["P9"], completion_criterion: "x", status: "todo" },
    ],
  };
  makeTask(root, TASK_ID, { "state.json": baseState({ plan_required: true }), "plan.json": plan });
  const res = validateTask(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /unknown P9/.test(e)));
});

test("validateTask: dependency cycle detected", () => {
  const root = tmpRoot();
  const plan = {
    schema_version: 1,
    task_id: TASK_ID,
    status: "approved",
    created_at: "2026-10-16T00:00:00Z",
    approved_at: "2026-10-16T00:00:00Z",
    scope: ["src/**"],
    knowledge_refs: [],
    acceptance_criteria: ["AC1.1 x"],
    verification: ["node --test"],
    items: [
      { id: "P1", title: "a", description: "a", paths: ["a.js"], knowledge_refs: [], depends_on: ["P2"], completion_criterion: "x", status: "todo" },
      { id: "P2", title: "b", description: "b", paths: ["b.js"], knowledge_refs: [], depends_on: ["P1"], completion_criterion: "x", status: "todo" },
    ],
  };
  makeTask(root, TASK_ID, { "state.json": baseState({ plan_required: true }), "plan.json": plan });
  const res = validateTask(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /cycle/.test(e)));
});

test("closure rejected when result missing", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, { "state.json": baseState({ status: "review" }) });
  const res = checkClosure(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.passed, false);
  assert.ok(res.reasons.some((r) => /result.json missing/.test(r)));
});

test("closure rejected on failed verification", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, {
    "state.json": baseState({ status: "review" }),
    "result.json": baseResult({ verification: { commands: [], passed: false, performed_at: "2026-10-16T00:00:00Z" } }),
  });
  const res = checkClosure(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.passed, false);
  assert.ok(res.reasons.some((r) => /verification.passed/.test(r)));
});

test("closure rejected on partial completion", () => {
  const root = tmpRoot();
  const plan = {
    schema_version: 1,
    task_id: TASK_ID,
    status: "approved",
    created_at: "2026-10-16T00:00:00Z",
    approved_at: "2026-10-16T00:00:00Z",
    scope: ["src/**"],
    knowledge_refs: [],
    acceptance_criteria: ["AC1.1 x"],
    verification: ["node --test"],
    items: [
      { id: "P1", title: "a", description: "a", paths: ["a.js"], knowledge_refs: [], depends_on: [], completion_criterion: "x", status: "done" },
      { id: "P2", title: "b", description: "b", paths: ["b.js"], knowledge_refs: [], depends_on: [], completion_criterion: "x", status: "todo" },
    ],
  };
  makeTask(root, TASK_ID, {
    "state.json": baseState({ status: "review", plan_required: true }),
    "plan.json": plan,
    "progress.json": {
      schema_version: 1,
      task_id: TASK_ID,
      updated_at: "2026-10-16T00:00:00Z",
      items: {
        P1: { status: "done", attempts: 1, updated_at: "2026-10-16T00:00:00Z" },
        P2: { status: "todo", attempts: 0, updated_at: "2026-10-16T00:00:00Z" },
      },
      next_action: { item_id: "P2", action: "do b", blocked_by: [] },
    },
    "result.json": baseResult(),
  });
  const res = checkClosure(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.passed, false);
  assert.ok(res.reasons.some((r) => /P2: status "todo"/.test(r)));
});

test("closure rejected on open blocker discrepancy", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, {
    "state.json": baseState({ status: "review" }),
    "result.json": baseResult(),
    "discrepancies.json": {
      schema_version: 1,
      task_id: TASK_ID,
      items: [
        { id: "D1", severity: "blocker", type: "implementation", summary: "s", evidence: "e", affected: { paths: [], knowledge_refs: [], plan_items: [] }, status: "open", created_at: "2026-10-16T00:00:00Z", resolved_at: null, resolution: null },
      ],
    },
  });
  const res = checkClosure(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.passed, false);
  assert.ok(res.reasons.some((r) => /blocker discrepancy/.test(r)));
});

test("closure passes for a well-formed small task", () => {
  const root = tmpRoot();
  makeTask(root, TASK_ID, {
    "state.json": baseState({ status: "review" }),
    "result.json": baseResult(),
  });
  const res = checkClosure(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.passed, true, JSON.stringify(res.reasons));
});

test("closure rejected when counters exceed limits", () => {
  const root = tmpRoot();
  const st = baseState({ status: "review" });
  st.counters.attempts_total = 5;
  makeTask(root, TASK_ID, { "state.json": st, "result.json": baseResult() });
  const res = checkClosure(root, cfg(), TASK_ID, SCHEMA);
  assert.equal(res.passed, false);
  assert.ok(res.reasons.some((r) => /attempts_total/.test(r)));
});
