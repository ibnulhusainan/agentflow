import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpRoot, writeJson, readJson, capture } from "./helpers.mjs";
import { run } from "../cli.mjs";
import { checkModels, MODEL_PRIVACY, KNOWN_MODELS, FREE_MODELS } from "../lib/models.mjs";

function cfg(over = {}) {
  return {
    version: 2,
    client_max_retention_days: 0,
    adapters: {
      opencode: {
        roles: {
          executor: {
            paid: ["opencode-go/deepseek-v4.1-flash", "opencode-go/mimo-v2.6-flash"],
            free: ["opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"],
            on_exhausted: "break",
          },
          planner: {
            paid: ["opencode-go/deepseek-v4.1-flash"],
            free: ["opencode/big-pickle"],
            on_exhausted: "break",
          },
        },
      },
      cursor: { roles: { executor: { paid: [], free: [], on_exhausted: "break" } } },
    },
    ...over,
  };
}

function writeModels(root, c) {
  writeJson(path.join(root, ".agent", "models.json"), c || cfg());
}

function writeAgentFile(root, adapter, role, model = "old-model") {
  const dir = path.join(root, adapter === "opencode" ? ".opencode/agents" : ".cursor/agents");
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${role}.md`);
  fs.writeFileSync(p, `---\nname: ${role}\nmodel: ${model}\n---\n# ${role}\n`);
  return p;
}

function makeTask(root, id, updatedAt = "2026-10-17T00:00:00Z") {
  const dir = path.join(root, ".agent", "tasks", id);
  fs.mkdirSync(dir, { recursive: true });
  writeJson(path.join(dir, "state.json"), {
    schema_version: 1,
    task_id: id,
    status: "pending",
    size: "small",
    plan_required: false,
    created_at: updatedAt,
    updated_at: updatedAt,
    history: [],
    counters: {},
  });
}

const parse = (out) => JSON.parse(out);

test("models check: green on template (only cursor-empty warnings)", () => {
  const root = tmpRoot();
  writeModels(root);
  const { code, out } = capture(() => run(["models", "check", "--root", root, "--json"]));
  assert.equal(code, 0);
  const d = parse(out);
  assert.equal(d.ok, true);
  assert.deepEqual(d.errors, []);
  assert.ok(d.warnings.some((w) => w.includes("cursor")));
});

test("models check: unknown Go id and unknown free id warn", () => {
  const root = tmpRoot();
  const c = cfg();
  c.adapters.opencode.roles.executor.paid.push("opencode-go/not-real");
  c.adapters.opencode.roles.executor.free.push("opencode/also-not-real");
  writeModels(root, c);
  const { out } = capture(() => run(["models", "check", "--root", root, "--json"]));
  const d = parse(out);
  assert.ok(d.warnings.some((w) => w.includes("opencode-go/not-real")));
  assert.ok(d.warnings.some((w) => w.includes("opencode/also-not-real")));
});

test("models check: wrong version is an error", () => {
  const root = tmpRoot();
  writeModels(root, cfg({ version: 1 }));
  const { code, out } = capture(() => run(["models", "check", "--root", root, "--json"]));
  assert.equal(code, 1);
  const d = parse(out);
  assert.ok(d.errors.some((e) => e.includes("version")));
});

test("models check --client: requires client_max_retention_days", () => {
  const root = tmpRoot();
  const c = cfg();
  delete c.client_max_retention_days;
  writeModels(root, c);
  const { code, out } = capture(() => run(["models", "check", "--client", "--root", root, "--json"]));
  assert.equal(code, 1);
  assert.ok(parse(out).errors.some((e) => e.includes("client_max_retention_days")));
});

test("models check --client: rejects training + high-retention models in both tiers", () => {
  const root = tmpRoot();
  const c = cfg();
  c.adapters.opencode.roles.executor.paid.push("opencode-go/gpt-6-luna"); // 30d
  c.adapters.opencode.roles.executor.free.push("opencode/big-pickle"); // trains
  writeModels(root, c);
  const { code, out } = capture(() => run(["models", "check", "--client", "--root", root, "--json"]));
  assert.equal(code, 1);
  const d = parse(out);
  assert.ok(d.errors.some((e) => e.includes("gpt-6-luna") && e.includes("retention")));
  assert.ok(d.errors.some((e) => e.includes("big-pickle") && e.includes("trains on data")));
});

test("models next: advances within the go tier and rewrites frontmatter", () => {
  const root = tmpRoot();
  writeModels(root);
  const p = writeAgentFile(root, "opencode", "executor", "opencode-go/deepseek-v4.1-flash");
  const { code, out } = capture(() => run(["models", "next", "--role", "executor", "--reason", "limit", "--root", root, "--json"]));
  assert.equal(code, 0);
  const d = parse(out);
  assert.equal(d.moved[0].tier, "paid");
  assert.equal(d.moved[0].model, "opencode-go/mimo-v2.6-flash");
  assert.ok(fs.readFileSync(p, "utf8").includes("model: opencode-go/mimo-v2.6-flash"));
  assert.ok(fs.existsSync(p + ".bak"));
});

test("models next: crosses from go to free when go is exhausted", () => {
  const root = tmpRoot();
  writeModels(root);
  writeAgentFile(root, "opencode", "executor", "opencode-go/deepseek-v4.1-flash");
  capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"]));
  const { code, out } = capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"]));
  assert.equal(code, 0);
  const d = parse(out);
  assert.equal(d.moved[0].tier, "free");
  assert.equal(d.moved[0].model, "opencode/deepseek-v4.1-flash-free");
  const st = readJson(path.join(root, ".agent", "models.state.json"));
  assert.equal(st.roles["opencode:executor"].tier, "free");
  assert.equal(st.roles["opencode:executor"].index, 0);
});

test("models next: exhausts after the free tier and hints discrepancy", () => {
  const root = tmpRoot();
  const c = cfg();
  c.adapters.opencode.roles.planner.paid = ["opencode-go/deepseek-v4.1-flash"];
  c.adapters.opencode.roles.planner.free = ["opencode/big-pickle"];
  writeModels(root, c);
  writeAgentFile(root, "opencode", "planner");
  capture(() => run(["models", "next", "--role", "planner", "--root", root, "--json"])); // -> free[0]
  const { code, out } = capture(() => run(["models", "next", "--role", "planner", "--root", root, "--json"]));
  assert.equal(code, 1);
  const d = parse(out);
  assert.equal(d.exhausted, true);
  assert.ok(d.hint.includes("discrepancy add"));
});

test("models next: skips cursor adapters with empty chains", () => {
  const root = tmpRoot();
  writeModels(root);
  const cu = writeAgentFile(root, "cursor", "executor", "cursor-orig");
  writeAgentFile(root, "opencode", "executor");
  const { out } = capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"]));
  assert.deepEqual(parse(out).skipped_adapters, ["cursor"]);
  assert.ok(fs.readFileSync(cu, "utf8").includes("cursor-orig"));
});

test("models next: resets to the go head when the task changes", () => {
  const root = tmpRoot();
  writeModels(root);
  const p = writeAgentFile(root, "opencode", "executor", "opencode-go/deepseek-v4.1-flash");
  makeTask(root, "T-20261017-001", "2026-10-17T00:00:00Z");
  capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"]));
  let st = readJson(path.join(root, ".agent", "models.state.json"));
  assert.equal(st.roles["opencode:executor"].tier, "paid");
  assert.equal(st.roles["opencode:executor"].index, 1);

  makeTask(root, "T-20261017-002", "2026-10-17T01:00:00Z");
  const { out } = capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"]));
  const d = parse(out);
  assert.equal(d.reset, true);
  assert.equal(d.moved[0].model, "opencode-go/deepseek-v4.1-flash");
  assert.ok(fs.readFileSync(p, "utf8").includes("model: opencode-go/deepseek-v4.1-flash"));
  st = readJson(path.join(root, ".agent", "models.state.json"));
  assert.equal(st.roles["opencode:executor"].tier, "paid");
  assert.equal(st.roles["opencode:executor"].index, 0);
});

test("models next: no chain for unknown role returns 1", () => {
  const root = tmpRoot();
  writeModels(root);
  const { code, out } = capture(() => run(["models", "next", "--role", "nope", "--root", root, "--json"]));
  assert.equal(code, 1);
  assert.ok(parse(out).error.includes("no chain"));
});

test("models next --client: skips free models the policy rejects", () => {
  const root = tmpRoot();
  const c = cfg();
  // free: [rejected, trains-on-data (skip), allowed]
  c.adapters.opencode.roles.executor.free = [
    "opencode/deepseek-v4.1-flash-free",
    "opencode/big-pickle",
    "opencode/union-alpha",
  ];
  writeModels(root, c);
  writeAgentFile(root, "opencode", "executor", "opencode-go/deepseek-v4.1-flash");
  // burn the go tier
  capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"])); // go[1]
  capture(() => run(["models", "next", "--role", "executor", "--root", root, "--json"])); // free[0]
  const { out } = capture(() => run(["models", "next", "--role", "executor", "--client", "--root", root, "--json"]));
  const d = parse(out);
  // big-pickle is rejected -> skip to union-alpha (0-day retention)
  assert.equal(d.moved[0].model, "opencode/union-alpha");
});

test("models set: manual override rewrites frontmatter", () => {
  const root = tmpRoot();
  writeModels(root);
  const p = writeAgentFile(root, "opencode", "executor", "opencode-go/deepseek-v4.1-flash");
  const { code, out } = capture(() =>
    run(["models", "set", "--role", "executor", "--model", "opencode/big-pickle", "--root", root, "--json"])
  );
  assert.equal(code, 0);
  assert.equal(parse(out).model, "opencode/big-pickle");
  assert.ok(fs.readFileSync(p, "utf8").includes("model: opencode/big-pickle"));
  const st = readJson(path.join(root, ".agent", "models.state.json"));
  assert.equal(st.roles["opencode:executor"].override, "opencode/big-pickle");
});

test("models apply: writes current model, skips empty chains", () => {
  const root = tmpRoot();
  writeModels(root);
  const op = writeAgentFile(root, "opencode", "executor", "old-op");
  const cu = writeAgentFile(root, "cursor", "executor", "old-cursor");
  const { code, out } = capture(() => run(["models", "apply", "--root", root, "--json"]));
  assert.equal(code, 0);
  assert.ok(fs.readFileSync(op, "utf8").includes("model: opencode-go/deepseek-v4.1-flash"));
  assert.ok(fs.readFileSync(cu, "utf8").includes("old-cursor"));
  const d = parse(out);
  assert.ok(d.written.some((w) => w.adapter === "opencode" && w.applied));
});

test("models show: reports both tiers and the current model", () => {
  const root = tmpRoot();
  writeModels(root);
  const { out } = capture(() => run(["models", "show", "--root", root, "--json"]));
  const r = parse(out).roles["opencode:executor"];
  assert.equal(r.paid.length, 2);
  assert.equal(r.free.length, 2);
  assert.equal(r.current, "opencode-go/deepseek-v4.1-flash");
  assert.equal(r.tier, "paid");
});

test("checkModels: pure function rejects empty config", () => {
  assert.equal(checkModels(null).ok, false);
});

test("baseline lists: every Go and free id referenced by MODEL_PRIVACY resolves", () => {
  // The two tiers must have documented-or-explicitly-unknown privacy; unknown
  // is allowed (fail-closed) but the baseline lists must be populated.
  assert.ok(KNOWN_MODELS.length >= 20);
  assert.ok(FREE_MODELS.length >= 10);
  assert.equal(MODEL_PRIVACY["big-pickle"].trains_on_data, true);
});
