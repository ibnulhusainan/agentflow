import { execFileSync } from "node:child_process";

export function git(root, args) {
  const r = gitRaw(root, args);
  return { ok: r.ok, out: r.out.trim() };
}

// Untrimmed output for machine-parsed formats (`-z`, `--porcelain`).
export function gitRaw(root, args) {
  try {
    const out = execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return { ok: true, out };
  } catch {
    return { ok: false, out: "" };
  }
}

export function isRepo(root) {
  const r = git(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out === "true";
}

export function headCommit(root) {
  const r = git(root, ["rev-parse", "HEAD"]);
  return r.ok ? r.out : null;
}

// Returns an array of changed repo-relative paths since `ref`, or null when Git
// is unavailable / the ref is invalid (callers fall back to hash+mtime).
export function changedFiles(root, ref) {
  if (!ref) return null;
  const r = git(root, ["diff", "--name-only", ref]);
  if (!r.ok) return null;
  return r.out ? r.out.split("\n").filter(Boolean) : [];
}

// Uncommitted changes (staged + unstaged + untracked).
//
// Uses `--porcelain -z`: NUL-separated records with no quoting or path escaping,
// so paths are returned verbatim. The newline form cannot be used here — `git()`
// trims its output, which eats the leading space of a `" M path"` record, and
// the fixed 3-char prefix slice then cuts into the path itself (`.opencode/x`
// became `opencode/x`). Dot-directories silently stopped matching their scopes.
export function workingTreeChanges(root) {
  // `-uall` lists untracked files individually; the default collapses them into
  // the directory (`new-feature/`), which never matches a `**/*.ts`-style scope,
  // so freshly added sources were invisible to the freshness tripwire.
  const r = gitRaw(root, ["status", "--porcelain", "-z", "-uall"]);
  if (!r.ok) return null;
  const out = [];
  // Records are `XY <path>`; a rename/copy appends ` -> <dest>`. Both paths are
  // relevant, so keep the destination and ignore the source arrow pair.
  for (const rec of r.out.split("\0")) {
    if (rec.length <= 3) continue;
    const path = rec.slice(3);
    if (path.startsWith('"')) continue; // cannot occur with -z; be safe
    const arrow = path.indexOf(" -> ");
    out.push(arrow === -1 ? path : path.slice(arrow + 4));
  }
  return out.filter(Boolean);
}
