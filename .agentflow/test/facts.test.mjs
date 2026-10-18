import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { tmpRoot, writeJson, writeText, makeTask, baseState, baseResult, TASK_ID, readJson, capture } from "./helpers.mjs";
import { loadConfig } from "../lib/config.mjs";
import { generateFacts, generateFactDoc, generateFactsAll, registerFactEntries, FACT_KINDS } from "../lib/facts.mjs";
import { run } from "../cli.mjs";

// Generic fixture project (JS/TS web app conventions only — no project-specific names).
function fixtureRoot() {
  const root = tmpRoot();
  writeJson(path.join(root, "package.json"), { name: "fixture" });
  writeText(path.join(root, "tsconfig.json"), JSON.stringify({ include: ["src/**/*"] }));
  writeText(
    path.join(root, "src/app/api/things/route.ts"),
    ['import { getSession } from "../../../lib/session";', "export async function GET() {}", "export async function POST() {}"].join("\n"),
  );
  writeText(path.join(root, "src/app/api/things/[id]/route.ts"), "export async function PATCH() {}");
  writeText(path.join(root, "src/app/admin/page.tsx"), "export default function Page() {}");
  writeText(path.join(root, "src/lib/session.ts"), "export const getSession = () => null;");
  writeText(
    path.join(root, "src/lib/broken.ts"),
    ['import { x } from "./nope";', 'import "lodash";', 'const y = require("node:path");'].join("\n"),
  );
  writeText(
    path.join(root, "src/db/schema.ts"),
    ['export const things = pgTable("things", {});', 'export const users = pgTable("users", {});'].join("\n"),
  );
  writeText(path.join(root, "migrations/0001_init.sql"), "CREATE TABLE things;");
  writeText(path.join(root, "data/app.db"), "sqlite-fake");
  writeJson(path.join(root, ".agent/config.json"), {
    schema_version: 1,
    facts: {
      routes: {
        signals: {
          auth: [{ pattern: "getSession", value: "session" }],
          input_validated_by: [{ pattern: "zod", value: "zod" }],
        },
      },
      schema: {
        extractors: [{ id: "tables", include: ["src/db/**"], pattern: 'pgTable\\(\\s*"([^"]+)"' }],
        migration_globs: ["migrations/*.sql"],
        db_files: ["data/app.db"],
      },
    },
  });
  return root;
}

test("repo-structure facts keep the historical shape", () => {
  const root = fixtureRoot();
  const doc = generateFacts(root, {});
  assert.equal(doc.schema_version, 1);
  assert.equal(doc.kind, "facts");
  assert.equal(doc.id, "k-repo-structure");
  assert.ok(doc.data.top_level.includes("src"));
  assert.ok(doc.data.manifests.includes("package.json"));
  assert.ok(doc.data.file_count > 0);
  assert.match(doc.source_revision.content_hash, /^sha256:/);
});

test("inventory: role, loc and tsconfig membership per file", () => {
  const root = fixtureRoot();
  const { config } = loadConfig(root);
  const doc = generateFactDoc(root, config, "inventory");
  const byPath = Object.fromEntries(doc.data.files.map((f) => [f.path, f]));
  assert.equal(byPath["src/app/api/things/route.ts"].role, "route");
  assert.equal(byPath["src/app/admin/page.tsx"].role, "page");
  assert.equal(byPath["src/lib/session.ts"].role, "lib");
  assert.equal(byPath["migrations/0001_init.sql"].role, "migration");
  assert.equal(byPath["src/db/schema.ts"].role, "other");
  assert.ok(byPath["src/app/api/things/route.ts"].loc >= 2);
  assert.equal(byPath["src/app/api/things/route.ts"].in_tsconfig, true);
  assert.equal(byPath["migrations/0001_init.sql"].in_tsconfig, false);
});

test("imports: relative edges, unresolved specs and external count", () => {
  const root = fixtureRoot();
  const { config } = loadConfig(root);
  const doc = generateFactDoc(root, config, "imports");
  const edges = doc.data.edges;
  assert.ok(edges.some((e) => e.from === "src/app/api/things/route.ts" && e.to === "src/lib/session.ts"), "relative import edge");
  assert.ok(doc.data.unresolved.some((u) => u.from === "src/lib/broken.ts" && u.spec === "./nope"), "unresolved spec");
  assert.ok(doc.data.external_imports >= 2, "external imports counted");
});

test("routes: methods, derived path, dynamic segment and configured signals", () => {
  const root = fixtureRoot();
  const { config } = loadConfig(root);
  const doc = generateFactDoc(root, config, "routes");
  assert.equal(doc.data.app_dir, "src/app");
  const things = doc.data.handlers.find((h) => h.path === "src/app/api/things/route.ts");
  assert.deepEqual(things.methods, ["GET", "POST"]);
  assert.equal(things.route, "/api/things");
  assert.equal(things.dynamic, false);
  assert.equal(things.auth, "session");
  assert.equal(things.input_validated_by, null);
  const one = doc.data.handlers.find((h) => h.path === "src/app/api/things/[id]/route.ts");
  assert.equal(one.route, "/api/things/[id]");
  assert.equal(one.dynamic, true);
  assert.deepEqual(one.methods, ["PATCH"]);
  assert.equal(one.auth, null);
  assert.ok(doc.data.pages.some((p) => p.path === "src/app/admin/page.tsx" && p.route === "/admin"));
});

test("schema: extractor definitions, migrations and db file existence", () => {
  const root = fixtureRoot();
  const { config } = loadConfig(root);
  const doc = generateFactDoc(root, config, "schema");
  const names = doc.data.definitions.map((d) => d.name);
  assert.ok(names.includes("things"));
  assert.ok(names.includes("users"));
  assert.deepEqual(doc.data.migrations, ["migrations/0001_init.sql"]);
  assert.deepEqual(doc.data.db_files, [{ path: "data/app.db", exists: true }]);
});

test("verify-state: commands, exit codes and acceptance criteria per task", () => {
  const root = fixtureRoot();
  makeTask(root, TASK_ID, { "state.json": baseState({ status: "review" }), "result.json": baseResult() });
  const { config } = loadConfig(root);
  const doc = generateFactDoc(root, config, "verify-state");
  assert.equal(doc.data.task_count, 1);
  const t = doc.data.tasks[0];
  assert.equal(t.task_id, TASK_ID);
  assert.equal(t.status, "review");
  assert.equal(t.last_verification, "2026-10-16T00:00:00Z");
  assert.deepEqual(t.commands, [{ cmd: "node --test", exit_code: 0, result: "pass" }]);
  assert.deepEqual(t.acceptance_criteria, [{ id: "AC1.1", met: true }]);
  assert.equal(doc.data.last_verification, "2026-10-16T00:00:00Z");
  assert.deepEqual(doc.scope, [".agent/tasks/**"]);
});

test("facts CLI: default run writes one file per kind", () => {
  const root = fixtureRoot();
  const res = capture(() => run(["facts", "--root", root, "--json"]));
  assert.equal(res.code, 0);
  const data = JSON.parse(res.out);
  assert.deepEqual(data.kinds, FACT_KINDS);
  const dir = path.join(root, ".agent/knowledge/facts");
  for (const f of ["repo.json", "inventory.json", "imports.json", "routes.json", "schema.json", "verify-state.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `${f} written`);
    const doc = readJson(path.join(dir, f));
    assert.equal(doc.kind, "facts");
    assert.match(doc.source_revision.content_hash, /^sha256:/);
  }
});

test("facts CLI: enabled=false excludes a kind from the default run", () => {
  const root = fixtureRoot();
  writeJson(path.join(root, ".agent/config.json"), {
    schema_version: 1,
    facts: { "repo-structure": { enabled: false } },
  });
  const data = JSON.parse(capture(() => run(["facts", "--root", root, "--json"])).out);
  assert.ok(!data.kinds.includes("repo-structure"));
  assert.ok(!fs.existsSync(path.join(root, ".agent/knowledge/facts/repo.json")));
});

test("facts CLI --register: one index entry per kind, own scope and hash", () => {
  const root = fixtureRoot();
  const first = capture(() => run(["facts", "--kind", "routes", "--register", "--root", root, "--json"]));
  assert.equal(first.code, 0);
  const second = capture(() => run(["facts", "--kind", "verify-state", "--register", "--root", root, "--json"]));
  assert.equal(second.code, 0);

  const idx = readJson(path.join(root, ".agent/knowledge/index.json"));
  assert.equal(idx.entries.length, 2);
  const routes = idx.entries.find((e) => e.id === "k-routes");
  const verify = idx.entries.find((e) => e.id === "k-verify-state");
  assert.equal(routes.path, ".agent/knowledge/facts/routes.json");
  assert.equal(routes.type, "facts");
  assert.equal(routes.owner, "analyzer");
  assert.equal(routes.status, "fresh");
  assert.notDeepEqual(routes.scope, verify.scope, "split scopes");
  assert.notEqual(routes.revision.content_hash, verify.revision.content_hash, "split content hashes");
  assert.match(routes.summary, /handler/);

  // Re-register updates in place instead of duplicating.
  capture(() => run(["facts", "--kind", "routes", "--register", "--root", root, "--json"]));
  const idx2 = readJson(path.join(root, ".agent/knowledge/index.json"));
  assert.equal(idx2.entries.length, 2);

  const st = JSON.parse(capture(() => run(["status", "--root", root, "--json"])).out);
  assert.equal(st.entries.find((e) => e.id === "k-routes").status, "fresh");
});

test("facts CLI: --kind accepts k- prefixed ids, unknown kind exits 2", () => {
  const root = fixtureRoot();
  const ok = capture(() => run(["facts", "--kind", "k-inventory", "--root", root, "--json"]));
  assert.equal(ok.code, 0);
  assert.deepEqual(JSON.parse(ok.out).kinds, ["inventory"]);
  const bad = capture(() => run(["facts", "--kind", "bogus", "--root", root, "--json"]));
  assert.equal(bad.code, 2);
});

test("registerFactEntries returns registered ids and writes atomically", () => {
  const root = fixtureRoot();
  const { config } = loadConfig(root);
  const results = generateFactsAll(root, config, { kinds: ["inventory"] });
  const res = registerFactEntries(root, config, results);
  assert.deepEqual(res.registered, ["k-inventory"]);
  const idx = readJson(res.idxPath);
  assert.equal(idx.entries[0].id, "k-inventory");
  assert.equal(idx.entries[0].summary.includes("inventory") || idx.entries[0].summary.includes("file"), true);
});

test("content hash matches sha256 of joined 'path:content' parts (no giant string)", () => {
  const root = fixtureRoot();
  const doc = generateFacts(root, {}, { scope: ["src/lib/session.ts"] });
  const content = fs.readFileSync(path.join(root, "src/lib/session.ts"), "utf8");
  const expected = crypto.createHash("sha256").update(`src/lib/session.ts:${content}`).digest("hex");
  assert.equal(doc.source_revision.content_hash, "sha256:" + expected);
});
