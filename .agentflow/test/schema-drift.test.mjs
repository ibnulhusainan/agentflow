import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { existsSync } from "node:fs";
import { readJson } from "./helpers.mjs";

const HERE = path.dirname(new URL(import.meta.url).pathname);
// The contract copy ships with the core next to the bundled schema, so this
// drift check runs everywhere — including in an installed project. If only one
// of the two exists, the install is broken and must fail loudly.
const CANONICAL = path.join(HERE, "..", "docs", "contracts", "schemas", "agentflow.schema.json");
if (existsSync(CANONICAL)) {
  test("bundled schema matches .agentflow/docs/contracts/schemas/agentflow.schema.json", () => {
    const bundled = readJson(path.join(HERE, "..", "schema", "agentflow.schema.json"));
    const canonical = readJson(CANONICAL);
    assert.deepEqual(bundled, canonical);
  });

  const CANONICAL_MODELS = path.join(HERE, "..", "docs", "contracts", "schemas", "models.schema.json");
  test("bundled models schema matches .agentflow/docs/contracts/schemas/models.schema.json", () => {
    const bundled = readJson(path.join(HERE, "..", "schema", "models.schema.json"));
    const canonical = readJson(CANONICAL_MODELS);
    assert.deepEqual(bundled, canonical);
  });
} else {
  test(".agentflow/docs/contracts/schemas/ is missing — the core install is incomplete", () => {
    assert.ok(false, "the contract schema ships with the core; a missing copy means a broken install");
  });
}