import { test } from "node:test";
import assert from "node:assert/strict";
import { matchesAny, globToRegExp } from "../lib/glob.mjs";

test("glob: exact file", () => {
  assert.equal(globToRegExp("package.json").test("package.json"), true);
  assert.equal(globToRegExp("package.json").test("a/package.json"), false);
});

test("glob: single star stays in one segment", () => {
  assert.equal(globToRegExp("src/*.js").test("src/a.js"), true);
  assert.equal(globToRegExp("src/*.js").test("src/a/b.js"), false);
});

test("glob: double star crosses segments", () => {
  assert.equal(globToRegExp("src/**").test("src/a/b/c.js"), true);
  assert.equal(globToRegExp(".agentflow/**").test(".agentflow/lib/x.mjs"), true);
});

test("glob: leading double-star", () => {
  assert.equal(globToRegExp("**/*.md").test("a/b/c.md"), true);
  assert.equal(globToRegExp("**/*.md").test("c.md"), true);
});

test("matchesAny", () => {
  assert.equal(matchesAny("src/a.js", ["src/**", "docs/**"]), true);
  assert.equal(matchesAny("other/a.js", ["src/**", "docs/**"]), false);
  assert.equal(matchesAny("x", []), false);
});
