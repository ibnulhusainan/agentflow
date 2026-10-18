import path from "node:path";
import { exists, readText, readJson, sha256, mtimeMs, walkFiles } from "./fsutil.mjs";
import { matchesAny } from "./glob.mjs";

export const KNOWLEDGE_STATUSES = ["missing", "fresh", "stale", "incomplete", "invalid"];

export function extractH2(text) {
  return text
    .split("\n")
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, "").trim().toLowerCase());
}

const REQUIRED_NOTE_HEADINGS = ["scope", "verified facts", "interpretation", "assumptions", "unknowns"];

// True when a repo-relative path is covered by an exclusion glob.
function isExcluded(file, exclude) {
  return exclude.length > 0 && matchesAny(file, exclude);
}

// Deterministic knowledge classification. Order: missing → invalid →
// incomplete → stale → fresh (first match wins).
//
// ctx:
//   indexById:   Map<id, entry>            (for dependency checks)
//   changedFiles: Set<string> | null       (Git or fallback change list)
//   nowMs:        number | undefined       (fallback mtime comparison)
//   staleBefore:  ISO string | undefined   (defaults to entry.last_validated)
export function classifyEntry(entry, root, ctx = {}) {
  if (!entry || typeof entry.path !== "string") return "invalid";
  const abs = path.join(root, entry.path);

  if (!exists(abs)) return "missing";
  const text = readText(abs);
  if (text === null) return "missing";

  if (entry.path.endsWith(".json")) {
    const r = readJson(abs);
    if (!r.ok) return "invalid";
    if (entry.type === "facts") {
      if (!r.value || r.value.schema_version !== 1 || r.value.kind !== "facts") return "invalid";
    }
  } else if (entry.path.endsWith(".md")) {
    if (!text.trimStart().startsWith("# ")) return "invalid";
    const headings = extractH2(text);
    if (!REQUIRED_NOTE_HEADINGS.every((h) => headings.includes(h))) return "incomplete";
  }

  // Dependencies must exist and not be broken.
  if (Array.isArray(entry.depends_on) && entry.depends_on.length && ctx.indexById) {
    for (const depId of entry.depends_on) {
      if (!ctx.indexById.has(depId)) return "incomplete";
    }
  }

  // Staleness: scope-relevant changed paths. Excluded paths (`.agent/**`,
  // `node_modules/**`, ...) are filtered here too: Git change detection must
  // obey the same exclusions as the mtime fallback, or the workflow's own
  // artifacts mark knowledge stale on every run (self-invalidation).
  const changed = ctx.changedFiles;
  if (changed && changed.size) {
    for (const f of changed) {
      if (isExcluded(f, ctx.exclude || [])) continue;
      if (matchesAny(f, entry.scope || [])) return "stale";
    }
  }

  // Staleness fallback: scope file mtime newer than last_validated.
  if (ctx.nowMs !== undefined && entry.last_validated) {
    const lv = Date.parse(entry.last_validated);
    if (!Number.isNaN(lv)) {
      const staleBefore = ctx.staleBefore ?? entry.last_validated;
      if (scopeModifiedSince(root, entry.scope || [], staleBefore, ctx.exclude || [])) return "stale";
    }
  }

  return "fresh";
}

export function scopeModifiedSince(root, scope, iso, exclude = []) {
  const threshold = Date.parse(iso);
  if (Number.isNaN(threshold)) return false;
  const files = walkFiles(root, { exclude });
  for (const f of files) {
    if (!matchesAny(f, scope)) continue;
    const m = mtimeMs(path.join(root, f));
    if (m !== null && m > threshold + 1000) return true; // 1s tolerance
  }
  return false;
}

// Recompute a content hash over the files matching a scope (fallback revision).
export function recomputeRevision(root, scope, exclude = []) {
  const files = walkFiles(root, { exclude }).filter((f) => matchesAny(f, scope)).sort();
  if (files.length === 0) return null;
  const h = sha256(files.map((f) => `${f}:${readText(path.join(root, f)) ?? ""}`).join("\n"));
  return h;
}

// Classify every entry in a knowledge index. Returns { entries, summary }.
export function classifyIndex(root, index, ctx = {}) {
  const indexById = new Map((index?.entries || []).map((e) => [e.id, e]));
  const merged = { ...ctx, indexById };
  const entries = (index?.entries || []).map((e) => ({
    id: e.id,
    path: e.path,
    scope: e.scope,
    status: classifyEntry(e, root, merged),
  }));
  const summary = {};
  for (const s of KNOWLEDGE_STATUSES) summary[s] = 0;
  for (const e of entries) summary[e.status] = (summary[e.status] || 0) + 1;
  return { entries, summary };
}
