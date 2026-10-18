import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every role prompt tells the model "Full contract: .agentflow/docs/agents/<role>.md".
// Those contracts used to live in `docs/` at the repo root, which the installer
// never shipped — so in every installed project the pointer dangled and the model
// was told to read a file that was not there. The contracts now ship with the
// core; these tests fail the moment a pointer or a contract goes missing again.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACTS_DIR = path.join(ROOT, ".agentflow", "docs", "agents");

const ROLES = ["conductor", "analyzer", "planner", "executor", "reviewer", "consultant"];

const PROMPT_FILES = [
  ...ROLES.map((r) => path.join("adapters", "opencode", "agents", `${r}.md`)),
  ...["analyzer", "planner", "executor", "reviewer", "consultant"].map((r) =>
    path.join("adapters", "cursor", ".cursor", "agents", `${r}.md`)
  ),
  path.join("adapters", "cursor", ".cursor", "rules", "agentflow.mdc"),
];

test("the core ships a contract for every role", () => {
  for (const role of ROLES) {
    const file = path.join(CONTRACTS_DIR, `${role}.md`);
    assert.ok(fs.existsSync(file), `.agentflow/docs/agents/${role}.md must exist`);
    assert.match(
      fs.readFileSync(file, "utf8"),
      new RegExp(`Contract id: \`role/${role}@`),
      `${role}.md must declare its contract id`
    );
  }
  assert.ok(fs.existsSync(path.join(CONTRACTS_DIR, "README.md")), "shared rules README must ship too");
});

test("no role prompt points at a contract that does not exist", () => {
  for (const rel of PROMPT_FILES) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} must exist`);
    const text = fs.readFileSync(file, "utf8");
    for (const [, ref] of text.matchAll(/`(\.agentflow\/docs\/[a-z]+\/[a-zA-Z0-9._/-]+)`/g)) {
      assert.ok(
        fs.existsSync(path.join(ROOT, ref)),
        `${rel} references ${ref}, which is not shipped with the core`
      );
    }
  }
});

test("each role prompt names its own contract", () => {
  // The Cursor rule file points at the contracts directory rather than one role
  // (it covers all of them); per-role prompts must name their own.
  const files = PROMPT_FILES.filter((f) => !f.endsWith(".mdc"));
  for (const rel of files) {
    const file = path.join(ROOT, rel);
    const text = fs.readFileSync(file, "utf8");
    const refs = [...text.matchAll(/`\.agentflow\/docs\/agents\/([a-z]+)\.md`/g)].map((m) => m[1]);
    assert.ok(refs.length > 0, `${rel} must reference its role contract`);
    for (const role of refs) {
      assert.ok(fs.existsSync(path.join(CONTRACTS_DIR, `${role}.md`)), `${rel} references missing ${role}.md`);
    }
  }
});

test("every shipped doc reference inside the contracts resolves", () => {
  // The contracts cite spec/contract files by section; a dangling citation is
  // how the Planner ended up reasoning from a rule that never shipped.
  const check = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".md")) continue;
      const file = path.join(dir, name);
      for (const [, ref] of fs.readFileSync(file, "utf8").matchAll(/`(\.agentflow\/docs\/[a-z]+\/[a-zA-Z0-9._/-]+)`/g)) {
        assert.ok(fs.existsSync(path.join(ROOT, ref)), `${rel2(file)} cites missing ${ref}`);
      }
    }
  };
  const rel2 = (p) => path.relative(ROOT, p);
  for (const dir of [CONTRACTS_DIR, path.join(ROOT, ".agentflow", "docs", "contracts")]) {
    check(dir);
  }
});