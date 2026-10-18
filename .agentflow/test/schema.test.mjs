import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { readJson } from "./helpers.mjs";
import { validateDef } from "../lib/schema.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
// Contract fixtures ship with the core (`docs/contracts/`), so they are present
// in an installed project too. The skip below only guards a hand-copied core
// that lost the docs tree — a broken install should fail loudly, not silently
// pass with zero contract coverage.
const EXAMPLES = path.join(HERE, "..", "docs", "contracts", "examples");
const SCHEMA = readJson(path.join(HERE, "..", "schema", "agentflow.schema.json"));
const HAS_FIXTURES = existsSync(EXAMPLES);
const maybe = HAS_FIXTURES ? test : test.skip;
if (!HAS_FIXTURES) {
  test("schema fixtures unavailable (core installed standalone) — contract tests skipped", () => {
    assert.ok(true);
  });
}

function check(rel, def) {
  const obj = readJson(path.join(EXAMPLES, rel));
  return validateDef(obj, SCHEMA, def);
}

maybe("valid examples pass schema", () => {
  assert.deepEqual(check("valid/index.json", "KnowledgeIndex"), []);
  assert.deepEqual(check("valid/facts.json", "FactsDoc"), []);
  assert.deepEqual(check("valid/plan.json", "Plan"), []);
  assert.deepEqual(check("valid/progress.json", "Progress"), []);
  assert.deepEqual(check("valid/state.json", "State"), []);
  assert.deepEqual(check("valid/discrepancies.json", "DiscrepancyList"), []);
  assert.deepEqual(check("valid/result.json", "Result"), []);
});

maybe("invalid: bad item id fails schema", () => {
  assert.ok(check("invalid/plan-bad-item-id.json", "Plan").length > 0);
});

maybe("invalid: bad knowledge status fails schema", () => {
  assert.ok(check("invalid/index-bad-knowledge-status.json", "KnowledgeIndex").length > 0);
});

maybe("invalid: progress without next_action fails schema", () => {
  assert.ok(check("invalid/progress-no-next-action.json", "Progress").length > 0);
});

maybe("semantic-only fixtures remain schema-valid", () => {
  // These are caught by semantic checks, not the schema.
  assert.deepEqual(check("invalid/plan-dangling-dependency.json", "Plan"), []);
  assert.deepEqual(check("invalid/state-illegal-transition.json", "State"), []);
  assert.deepEqual(check("invalid/result-closure-rejected.json", "Result"), []);
});
