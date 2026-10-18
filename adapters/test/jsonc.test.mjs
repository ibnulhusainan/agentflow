import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseJsonc, stripJsonComments, stripTrailingCommas } from "../lib/jsonc.mjs";

const ADAPTERS = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "adapters");

test("stripJsonComments removes line and block comments but keeps strings", () => {
  const src = '{ // line\n "a": "http://x/*not*/y", /* block */ "b": 1 }';
  const out = stripJsonComments(src);
  assert.match(out, /http:\/\/x\/\*not\*\/y/);
  assert.equal(out.includes("line"), false);
  assert.equal(out.includes("block"), false);
});

test("stripTrailingCommas removes trailing commas", () => {
  assert.equal(stripTrailingCommas('{"a":1,}'), '{"a":1}');
  assert.equal(stripTrailingCommas('{"a":[1,2,],}'), '{"a":[1,2]}');
});

test("parses the OpenCode opencode.jsonc", () => {
  const text = readFileSync(path.join(ADAPTERS, "opencode", "opencode.jsonc"), "utf8");
  const cfg = parseJsonc(text);
  assert.equal(cfg.default_agent, "conductor");
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");

  // Documented shape is `permission`: a map of tool key -> action (or -> pattern
  // map, last match wins). The internal array form (`permissions: [...]` with
  // action/resource/effect) is not accepted in config files.
  assert.equal(cfg.permissions, undefined, "config must not use the internal array form");
  assert.ok(cfg.permission && typeof cfg.permission === "object");

  const bash = cfg.permission.bash;
  assert.ok(bash && typeof bash === "object");
  assert.equal(bash["*"], "ask", "broad bash rule must come first");
  assert.equal(bash["git push *"], "deny", "expected a bash deny rule for git push");
  assert.equal(bash["node .agentflow/cli.mjs *"], "allow", "expected a bash allow rule for the core CLI");

  // Ordering matters: the catch-all must precede the specific patterns, because
  // the last matching pattern wins.
  const keys = Object.keys(bash);
  assert.equal(keys[0], "*");
});

test("every permission entry has a known key and a valid action", () => {
  const text = readFileSync(path.join(ADAPTERS, "opencode", "opencode.jsonc"), "utf8");
  const cfg = parseJsonc(text);
  const keys = new Set([
    "read", "edit", "glob", "grep", "list", "bash", "task",
    "external_directory", "webfetch", "websearch", "lsp", "skill",
  ]);
  for (const [key, value] of Object.entries(cfg.permission)) {
    assert.ok(keys.has(key), `unknown permission key: ${key}`);
    for (const eff of typeof value === "string" ? [value] : Object.values(value)) {
      assert.ok(["allow", "deny", "ask"].includes(eff), `bad effect ${eff} under ${key}`);
    }
  }
});
