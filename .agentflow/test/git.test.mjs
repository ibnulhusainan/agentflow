import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { workingTreeChanges } from "../lib/git.mjs";

function gitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wf-git-"));
  const g = (...a) => execFileSync("git", a, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q", "-b", "main", ".");
  g("config", "user.email", "t@e.st");
  g("config", "user.name", "t");
  return { root, g };
}

function write(root, rel, content) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

// Regression: `git()` trimmed its output, which ate the leading space of a
// `" M path"` porcelain record. The fixed 3-char prefix slice then cut into the
// path — `.opencode/plugins/x.js` became `opencode/plugins/x.js`. Every path
// under a dot-directory then failed its scope match, so exclusions never applied
// and knowledge looked stale forever after any dot-file edit.
test("workingTreeChanges keeps dot-directory paths intact", () => {
  const { root, g } = gitRepo();
  write(root, ".opencode/plugins/p.js", "a");
  write(root, "src/main.ts", "a");
  g("add", "-A");
  g("commit", "-qm", "init");

  write(root, ".opencode/plugins/p.js", "b"); // unstaged modification
  write(root, "src/main.ts", "b");
  g("add", ".opencode/plugins/p.js"); // staged modification

  const changed = workingTreeChanges(root);
  assert.ok(changed.includes(".opencode/plugins/p.js"), `dot path lost: ${JSON.stringify(changed)}`);
  assert.ok(changed.includes("src/main.ts"));
  assert.ok(!changed.includes("opencode/plugins/p.js"));
});

test("workingTreeChanges reports untracked dotfiles verbatim", () => {
  const { root, g } = gitRepo();
  write(root, "src/a.ts", "a");
  g("add", "-A");
  g("commit", "-qm", "init");

  write(root, ".cursor/rules/x.mdc", "r");
  const changed = workingTreeChanges(root);
  assert.deepEqual(changed, [".cursor/rules/x.mdc"]);
});

test("workingTreeChanges handles filenames with spaces and unicode", () => {
  const { root, g } = gitRepo();
  write(root, "src/a b.ts", "a");
  write(root, "src/ünïcode.ts", "a");
  g("add", "-A");
  g("commit", "-qm", "init");

  write(root, "src/a b.ts", "b");
  write(root, "src/ünïcode.ts", "b");

  const changed = workingTreeChanges(root);
  assert.ok(changed.includes("src/a b.ts"), `space path lost: ${JSON.stringify(changed)}`);
  assert.ok(changed.includes("src/ünïcode.ts"), `unicode path lost: ${JSON.stringify(changed)}`);
});

test("workingTreeChanges lists untracked files, not their directory", () => {
  // `git status --porcelain` defaults to collapsing untracked directories, so a
  // brand-new source file was reported as `feature/` and matched no scope.
  const { root, g } = gitRepo();
  write(root, "src/a.ts", "a");
  g("add", "-A");
  g("commit", "-qm", "init");

  write(root, "feature/new-thing.ts", "n");
  const changed = workingTreeChanges(root);
  assert.ok(changed.includes("feature/new-thing.ts"), `untracked file collapsed: ${JSON.stringify(changed)}`);
  assert.ok(!changed.includes("feature/"));
});

test("workingTreeChanges returns the rename destination", () => {
  const { root, g } = gitRepo();
  write(root, "src/old.ts", "a");
  g("add", "-A");
  g("commit", "-qm", "init");

  g("mv", "src/old.ts", "src/new.ts");
  const changed = workingTreeChanges(root);
  assert.ok(changed.includes("src/new.ts"), `rename dest lost: ${JSON.stringify(changed)}`);
});