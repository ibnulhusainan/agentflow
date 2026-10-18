import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/frontmatter.mjs";

const ADAPTERS = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "adapters");
const CURSOR = path.join(ADAPTERS, "cursor", ".cursor");
const AGENTS_DIR = path.join(CURSOR, "agents");
const RULES_DIR = path.join(CURSOR, "rules");

const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));

test("always-apply rule exists and is valid", () => {
  const file = path.join(RULES_DIR, "agentflow.mdc");
  assert.ok(existsSync(file), "agentflow.mdc must exist");
  const { data, body } = parseFrontmatter(readFileSync(file, "utf8"));
  assert.equal(data.alwaysApply, true);
  assert.equal(typeof data.description, "string");
  assert.match(body, /docs\/agents\//);
  assert.match(body, /\.agentflow\/cli\.mjs/);
});

test("the expected set of subagents is present", () => {
  assert.deepEqual(
    [...agentFiles].sort(),
    ["analyzer.md", "consultant.md", "executor.md", "planner.md", "reviewer.md"]
  );
});

for (const file of agentFiles) {
  test(`subagent ${file} has valid frontmatter`, () => {
    const { data, body } = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, file), "utf8"));
    const expectedName = file.replace(/\.md$/, "");
    assert.equal(data.name, expectedName, "name must match the filename");
    assert.equal(typeof data.description, "string");
    assert.ok(data.description.length > 10);
    assert.equal(data.model, "inherit");
    assert.equal(typeof data.readonly, "boolean");
    assert.equal(typeof data.is_background, "boolean");
    assert.match(body, /docs\/agents\//);
  });
}

test("read-only roles are readonly:true, writing roles are readonly:false", () => {
  const role = (name) =>
    parseFrontmatter(readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf8")).data;
  assert.equal(role("reviewer").readonly, true);
  assert.equal(role("consultant").readonly, true);
  assert.equal(role("analyzer").readonly, false);
  assert.equal(role("planner").readonly, false);
  assert.equal(role("executor").readonly, false);
});

test("hooks.json is valid and wires the guard", () => {
  const cfg = JSON.parse(readFileSync(path.join(CURSOR, "hooks.json"), "utf8"));
  assert.equal(cfg.version, 1);
  const shell = cfg.hooks.beforeShellExecution;
  assert.ok(Array.isArray(shell) && shell.length >= 1);
  assert.ok(shell[0].command.includes("hooks/guard.mjs"));
  assert.equal(shell[0].failClosed, true);
  assert.ok(Array.isArray(cfg.hooks.subagentStart));
  assert.ok(cfg.hooks.subagentStart[0].command.includes("hooks/guard.mjs"));
});

test("project hook commands are project-root-relative", () => {
  const cfg = JSON.parse(readFileSync(path.join(CURSOR, "hooks.json"), "utf8"));
  for (const list of Object.values(cfg.hooks)) {
    for (const hook of list) {
      assert.ok(
        hook.command.startsWith(".cursor/") || hook.command.includes(".cursor/hooks/"),
        `project hook paths must reference .cursor/ (got ${hook.command})`
      );
    }
  }
});

test("guard script exists", () => {
  assert.ok(existsSync(path.join(CURSOR, "hooks", "guard.mjs")));
});
