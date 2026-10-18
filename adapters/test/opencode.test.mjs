import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "../lib/frontmatter.mjs";
import { parseJsonc } from "../lib/jsonc.mjs";

const ADAPTERS = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "adapters");
const OC = path.join(ADAPTERS, "opencode");
const AGENTS_DIR = path.join(OC, "agents");
const COMMANDS_DIR = path.join(OC, "commands");

const EFFECTS = new Set(["allow", "deny", "ask"]);
const MODES = new Set(["primary", "subagent", "all"]);

const agentFiles = readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
const commandFiles = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith(".md"));

test("the expected set of agents is present", () => {
  assert.deepEqual(
    [...agentFiles].sort(),
    ["analyzer.md", "conductor.md", "consultant.md", "executor.md", "planner.md", "reviewer.md"]
  );
});

for (const file of agentFiles) {
  test(`agent ${file} has valid frontmatter`, () => {
    const { data, body } = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, file), "utf8"));
    assert.equal(typeof data.description, "string");
    assert.ok(data.description.length > 10, "description should be meaningful");
    assert.ok(MODES.has(data.mode), `mode must be one of primary/subagent/all (got ${data.mode})`);
    assert.equal(data.permissions, undefined, "agent frontmatter must not use the internal array form");
    assert.ok(data.permission && typeof data.permission === "object", "agent needs a `permission` map");
    assert.ok(Object.keys(data.permission).length > 0);
    for (const [key, value] of Object.entries(data.permission)) {
      assert.match(key, /^(read|edit|glob|grep|list|bash|task|external_directory|webfetch|websearch|lsp|skill)$/,
        `unknown permission key ${key}`);
      for (const eff of typeof value === "string" ? [value] : Object.values(value)) {
        assert.ok(EFFECTS.has(eff), `bad effect ${eff} under ${key}`);
      }
    }
    assert.match(body, /docs\/agents\//, "body should reference the role contract");
    assert.match(body, /\.agentflow\/cli\.mjs/, "body should reference the core CLI");
  });
}

test("conductor is primary and only allows the four role subagents", () => {
  const { data } = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, "conductor.md"), "utf8"));
  assert.equal(data.mode, "primary");
  const sub = data.permission.task;
  assert.equal(typeof sub, "object", "conductor must gate subagents with a permission.task map");
  assert.equal(sub["*"], "deny", "conductor must deny all subagents by default");
  const allowed = Object.entries(sub).filter(([, e]) => e === "allow").map(([r]) => r).sort();
  assert.deepEqual(allowed, ["analyzer", "executor", "planner", "reviewer"]);
});

test("reviewer and consultant are read-only (edit + shell denied)", () => {
  // `permission.edit` may be either the shorthand "deny" or a pattern map whose
  // catch-all is "deny"; both express the same boundary.
  const catchAll = (v) => (typeof v === "string" ? v : v?.["*"]);
  for (const name of ["reviewer", "consultant"]) {
    const { data } = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, `${name}.md`), "utf8"));
    assert.equal(catchAll(data.permission.edit), "deny", `${name} must deny edits`);
    assert.equal(catchAll(data.permission.bash), "deny", `${name} must deny shell`);
  }
});

test("analyzer may only write under .agent/knowledge", () => {
  const { data } = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, "analyzer.md"), "utf8"));
  assert.equal(data.permission.edit["*"], "deny");
  assert.equal(data.permission.edit[".agent/knowledge/**"], "allow");
});

test("executor cannot edit knowledge or the plan", () => {
  const { data } = parseFrontmatter(readFileSync(path.join(AGENTS_DIR, "executor.md"), "utf8"));
  assert.equal(data.permission.edit[".agent/knowledge/**"], "deny");
  assert.equal(data.permission.edit["*plan.json"], "deny");
});

test("commands exist and invoke the core CLI", () => {
  assert.ok(commandFiles.length >= 4);
  for (const file of commandFiles) {
    const text = readFileSync(path.join(COMMANDS_DIR, file), "utf8");
    const { data, body } = parseFrontmatter(text);
    assert.equal(typeof data.description, "string");
    assert.match(body, /node \.agentflow\/cli\.mjs/, `${file} must call the core CLI`);
    assert.match(body, /!\`/, `${file} must use a shell block`);
  }
});

test("commands are NOT duplicated in opencode.jsonc", () => {
  const cfg = parseJsonc(readFileSync(path.join(OC, "opencode.jsonc"), "utf8"));
  assert.equal("commands" in cfg, false, "commands should be files, not JSON config entries");
});

test("adapter does not reimplement workflow logic (no freshness/validation code)", () => {
  // The adapter may only *reference* the core CLI; it must not re-export or
  // reimplement its behaviour. The only JS shipped is JSONC + frontmatter parsing.
  const lib = readdirSync(path.join(ADAPTERS, "lib"));
  assert.deepEqual([...lib].sort(), ["frontmatter.mjs", "jsonc.mjs"]);
});
