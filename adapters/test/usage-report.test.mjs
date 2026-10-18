import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildReport, human } from "../opencode/usage-report.mjs";

const SID = "ses_test_0001";

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-report-"));
  const dbPath = path.join(dir, "opencode.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    create table session_v2 (
      id text primary key, slug text, agent text, model text, directory text, cost real,
      tokens_input integer, tokens_output integer, tokens_cache_read integer,
      tokens_cache_write integer, time_updated integer
    );
    create table session_message (
      id text primary key, session_id text, type text, seq integer,
      time_created integer, time_updated integer, data text
    );
  `);
  db.prepare(
    "insert into session_v2 values (?,?,?,?,?,?,?,?,?,?,?)",
  ).run(SID, "test-slug", "executor", '{"id":"m","providerID":"p"}', "/tmp/proj", 0, 1000, 500, 3000, 0, 2);

  const userText = "x".repeat(400);
  const toolOutput = "y".repeat(8000);
  const assistantText = "z".repeat(2000);
  const msg = (id, type, seq, data) => {
    db.prepare("insert into session_message values (?,?,?,?,?,?,?)").run(id, SID, type, seq, seq, seq, JSON.stringify(data));
  };
  msg("m1", "user", 1, { text: userText });
  msg("m2", "assistant", 2, {
    content: [
      { type: "text", text: assistantText },
      { type: "tool", id: "c1", name: "read", state: { input: { path: "a.js" }, content: [{ type: "text", text: toolOutput }] } },
    ],
  });
  db.close();
  return dbPath;
}

test("usage-report: composition, cache ratio, growth", () => {
  const dbPath = makeDb();
  const report = buildReport({ db: dbPath, session: SID });
  assert.equal(report.ok, true, report.error);
  assert.equal(report.count, 1);
  const s = report.sessions[0];
  assert.equal(s.slug, "test-slug");
  assert.equal(s.turns, 1);
  assert.equal(s.totals.cache_read, 3000);
  assert.equal(s.cache_hit_ratio, Number((3000 / 4000).toFixed(4)));

  // Tool output is the largest block and dominates the share.
  const classes = Object.keys(s.composition);
  assert.equal(classes[0], "tool_output");
  assert.ok(s.composition.tool_output.share > 0.6);
  assert.ok(s.composition.tool_output.est_tokens > s.composition.assistant_text.est_tokens);
  assert.equal(s.composition.tool_input.est_tokens, Math.round(JSON.stringify({ path: "a.js" }).length / 4));

  // Growth tracks one point per assistant message.
  assert.equal(s.growth.length, 1);
  assert.ok(s.growth[0].cumulative_est_tokens > 0);

  assert.match(human(report), /test-slug/);
});

test("usage-report: --list enumerates sessions and filters by directory", () => {
  const dbPath = makeDb();
  const list = buildReport({ db: dbPath, list: true });
  assert.equal(list.ok, true);
  assert.equal(list.list.length, 1);
  assert.equal(list.list[0].session_id, SID);
  assert.ok(human(list).includes(SID));

  const miss = buildReport({ db: dbPath, directory: "does-not-exist" });
  assert.equal(miss.ok, true);
  assert.equal(miss.count, 0);
});

test("usage-report: unknown session reports a clear error", () => {
  const dbPath = makeDb();
  const report = buildReport({ db: dbPath, session: "ses_nope" });
  assert.equal(report.ok, false);
  assert.match(report.error, /not found/);
  assert.match(human(report), /^ERROR/);
});

test("usage-report: missing database reports a clear error", () => {
  const report = buildReport({ db: "/nonexistent/opencode.db" });
  assert.equal(report.ok, false);
  assert.match(report.error, /cannot open database/);
});
