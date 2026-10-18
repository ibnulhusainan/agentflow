import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These assertions are repo-only: they check the installer's own release
// metadata. Inside an installed project the parent directory is the user's
// repo, which has no VERSION/install.sh — so skip instead of failing.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IS_REPO = fs.existsSync(path.join(ROOT, "VERSION")) && fs.existsSync(path.join(ROOT, "install.sh"));
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const repoOnly = { skip: IS_REPO ? false : "repo-only test (run from the agentflow checkout)" };

// Releasing without bumping these shipped a "pinned" installer that quietly
// installed an older version: the raw URL could name any tag, but a piped
// script cannot know it, so it fell back to its own built-in default.
test("install.sh's fallback ref matches the released VERSION", repoOnly, () => {
  const version = read("VERSION").trim();
  assert.match(version, /^v\d+\.\d+\.\d+$/, `VERSION must be a vX.Y.Z tag, got ${version}`);

  const script = read("install.sh");
  const m = script.match(/AGENTFLOW_VERSION="\$\{AGENTFLOW_VERSION:-([^}]+)\}"/);
  assert.ok(m, "install.sh must define an AGENTFLOW_VERSION fallback");
  assert.equal(
    m[1],
    version,
    `install.sh fallback (${m[1]}) must equal VERSION (${version}). ` +
      `A piped script cannot see the ref in its own URL, so a stale fallback installs the wrong version.`
  );
});

test("install.sh refuses an archive whose VERSION does not match the ref", repoOnly, () => {
  const script = read("install.sh");
  assert.match(script, /version mismatch/, "install.sh must verify the downloaded archive's VERSION");
  assert.match(script, /\[ "\$got" != "\$REF" \]/);
});

test("every documented install URL uses the current VERSION", repoOnly, () => {
  const version = read("VERSION").trim();
  for (const doc of ["README.md", "install.sh"]) {
    const text = read(doc);
    // Any explicit tag in a raw.githubusercontent URL must be the released one.
    const tags = [...text.matchAll(/raw\.githubusercontent\.com\/[^/\s]+\/[^/\s]+\/([^/\s]+)\/install\.sh/g)].map(
      (m) => m[1]
    );
    for (const t of tags) {
      // `main` is a deliberate branch example, not a release pin.
      if (!/^v\d+\.\d+\.\d+$/.test(t)) continue;
      assert.equal(t, version, `${doc} references tag ${t} but VERSION is ${version}`);
    }
  }
});