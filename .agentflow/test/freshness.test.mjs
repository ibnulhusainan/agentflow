import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpRoot, writeJson, writeText } from "./helpers.mjs";
import { classifyEntry, classifyIndex, extractH2 } from "../lib/freshness.mjs";
import { DEFAULTS } from "../lib/config.mjs";

const NOTE = `# Area

## Scope
- \`src/**\`

## Verified facts
- \`src/a.js\` exists

## Interpretation
- trivial

## Assumptions
- none

## Unknowns
- none

## References
- \`src/a.js\`
`;

test("missing file -> missing", () => {
  const root = tmpRoot();
  const s = classifyEntry({ id: "k-x", path: ".agent/knowledge/facts/x.json", type: "facts", scope: ["a/**"] }, root, {});
  assert.equal(s, "missing");
});

test("malformed JSON -> invalid", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/facts/x.json"), "{oops");
  const s = classifyEntry(
    { id: "k-x", path: ".agent/knowledge/facts/x.json", type: "facts", scope: ["a/**"] },
    root,
    {},
  );
  assert.equal(s, "invalid");
});

test("facts without kind -> invalid", () => {
  const root = tmpRoot();
  writeJson(path.join(root, ".agent/knowledge/facts/x.json"), { schema_version: 1, data: {} });
  const s = classifyEntry(
    { id: "k-x", path: ".agent/knowledge/facts/x.json", type: "facts", scope: ["a/**"] },
    root,
    {},
  );
  assert.equal(s, "invalid");
});

test("analysis note missing required headings -> incomplete", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), "# Title\n\n## Notes\n- x\n");
  const s = classifyEntry(
    { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["src/**"] },
    root,
    {},
  );
  assert.equal(s, "incomplete");
});

test("valid note -> fresh", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const s = classifyEntry(
    { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["src/**"] },
    root,
    {},
  );
  assert.equal(s, "fresh");
});

test("scope-relevant change -> stale", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const s = classifyEntry(
    { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["src/**"] },
    root,
    { changedFiles: new Set(["src/a.js"]) },
  );
  assert.equal(s, "stale");
});

test("unrelated change -> stays fresh", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const s = classifyEntry(
    { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["src/**"] },
    root,
    { changedFiles: new Set(["docs/readme.md"]) },
  );
  assert.equal(s, "fresh");
});

test("excluded paths never mark knowledge stale (no self-invalidation)", () => {
  // Regression: Git change detection listed `.agent/**` files, so the
  // workflow's own writes (facts regeneration, index updates) marked knowledge
  // stale on the very next `status` run. Exclusions must apply to Git-derived
  // change lists exactly as they do to the mtime fallback.
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const exclude = [".agent/**", "node_modules/**"];
  const entry = { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["**/*"] };

  const own = classifyEntry(entry, root, {
    changedFiles: new Set([".agent/knowledge/facts/repo.json", ".agent/knowledge/index.json"]),
    exclude,
  });
  assert.equal(own, "fresh");

  const real = classifyEntry(entry, root, { changedFiles: new Set(["src/a.js"]), exclude });
  assert.equal(real, "stale");
});

test("installer backup dir does not invalidate knowledge", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const s = classifyEntry(
    { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["**/*"] },
    root,
    {
      changedFiles: new Set([".agentflow-backup/20260101-000000/opencode.jsonc"]),
      exclude: [".agent/**", ".agentflow-backup/**"],
    },
  );
  assert.equal(s, "fresh");
});

test("installed adapter files do not invalidate knowledge by default", () => {
  // Regression: editing `.opencode/plugins/*.js` or `.cursor/**` marked broad
  // knowledge stale, so a plugin tweak looked like application drift. The tripwire
  // must react to the project's code, not to the workflow's own installation.
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const entry = { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["**/*"] };
  const exclude = DEFAULTS.exclude;

  const adapter = classifyEntry(entry, root, {
    changedFiles: new Set([".opencode/plugins/context-filter.js", ".cursor/hooks/guard.mjs"]),
    exclude,
  });
  assert.equal(adapter, "fresh");

  const app = classifyEntry(entry, root, { changedFiles: new Set(["src/app/main.ts"]), exclude });
  assert.equal(app, "stale");
});

test("defaults exclude the workflow's own trees", () => {
  for (const p of [
    ".agent/**",
    ".opencode/**",
    ".cursor/**",
    ".agentflow-backup/**",
    "opencode.jsonc",
    "node_modules/**",
    ".git/**",
  ]) {
    assert.ok(DEFAULTS.exclude.includes(p), `default exclude must contain ${p}`);
  }
});

test("editing the root opencode.jsonc does not invalidate knowledge", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const entry = { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["**/*"] };
  const s = classifyEntry(entry, root, { changedFiles: new Set(["opencode.jsonc"]), exclude: DEFAULTS.exclude });
  assert.equal(s, "fresh");
});

test("mtime fallback -> stale when scoped file newer", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  writeText(path.join(root, "src/a.js"), "// changed");
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const s = classifyEntry(
    { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["src/**"], last_validated: old },
    root,
    { nowMs: Date.now(), exclude: [] },
  );
  assert.equal(s, "stale");
});

test("missing dependency -> incomplete", () => {
  const root = tmpRoot();
  writeJson(path.join(root, ".agent/knowledge/facts/x.json"), { schema_version: 1, kind: "facts", data: {} });
  const s = classifyEntry(
    { id: "k-x", path: ".agent/knowledge/facts/x.json", type: "facts", scope: ["a/**"], depends_on: ["k-missing"] },
    root,
    { indexById: new Map([["k-x", {}]]) },
  );
  assert.equal(s, "incomplete");
});

test("extractH2 lowercases headings", () => {
  assert.deepEqual(extractH2(NOTE).slice(0, 2), ["scope", "verified facts"]);
});

test("classifyIndex summary counts statuses", () => {
  const root = tmpRoot();
  writeText(path.join(root, ".agent/knowledge/notes/n-x.md"), NOTE);
  const index = {
    entries: [
      { id: "n-x", path: ".agent/knowledge/notes/n-x.md", type: "analysis", scope: ["src/**"] },
      { id: "k-y", path: ".agent/knowledge/facts/y.json", type: "facts", scope: ["b/**"] },
    ],
  };
  const { summary, entries } = classifyIndex(root, index, {});
  assert.equal(entries.length, 2);
  assert.equal(summary.fresh, 1);
  assert.equal(summary.missing, 1);
});
