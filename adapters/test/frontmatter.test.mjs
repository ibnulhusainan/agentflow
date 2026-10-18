import { test } from "node:test";
import assert from "node:assert/strict";
import { parseYamlSubset, parseFrontmatter } from "../lib/frontmatter.mjs";

test("parses scalars, booleans, numbers and null", () => {
  const data = parseYamlSubset(
    ["description: hello", "mode: all", "steps: 24", "readonly: true", "flag: false", "empty: null"].join("\n")
  );
  assert.equal(data.description, "hello");
  assert.equal(data.mode, "all");
  assert.equal(data.steps, 24);
  assert.equal(data.readonly, true);
  assert.equal(data.flag, false);
  assert.equal(data.empty, null);
});

test("keeps # inside quoted strings, strips trailing comments", () => {
  const data = parseYamlSubset(
    ['color: "#4c9be8"   # a color', "note: plain # comment removed"].join("\n")
  );
  assert.equal(data.color, "#4c9be8");
  assert.equal(data.note, "plain");
});

test("parses a nested list of mappings (permissions)", () => {
  const data = parseYamlSubset(
    [
      "permissions:",
      "  - action: edit",
      "    resource: '*'",
      "    effect: deny",
      "  - action: shell",
      "    resource: 'node .agentflow/cli.mjs *'",
      "    effect: allow",
    ].join("\n")
  );
  assert.equal(data.permissions.length, 2);
  assert.deepEqual(data.permissions[0], { action: "edit", resource: "*", effect: "deny" });
  assert.deepEqual(data.permissions[1], {
    action: "shell",
    resource: "node .agentflow/cli.mjs *",
    effect: "allow",
  });
});

test("parses a list of scalars", () => {
  const data = parseYamlSubset(["globs:", "  - '**/*.ts'", "  - '**/*.tsx'"].join("\n"));
  assert.deepEqual(data.globs, ["**/*.ts", "**/*.tsx"]);
});

test("splits frontmatter from body", () => {
  const { data, body } = parseFrontmatter("---\nname: x\n---\n\nHello body\n");
  assert.equal(data.name, "x");
  assert.match(body, /Hello body/);
});

test("throws when frontmatter is missing", () => {
  assert.throws(() => parseFrontmatter("no frontmatter here"), /frontmatter/);
});
