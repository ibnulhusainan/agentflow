import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { matchesAny } from "./glob.mjs";

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

const MISSING = "missing";
const PARSE = "parse";

export function readJson(p) {
  if (!exists(p)) return { ok: false, error: MISSING, value: null };
  const t = readText(p);
  if (t === null) return { ok: false, error: MISSING, value: null };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false, error: PARSE, value: null };
  }
}

// Atomic write: temp file + rename (atomic on the same filesystem).
export function writeTextAtomic(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

export function writeJsonAtomic(p, obj) {
  writeTextAtomic(p, JSON.stringify(obj, null, 2) + "\n");
}

export function sha256(str) {
  return "sha256:" + crypto.createHash("sha256").update(str).digest("hex");
}

export function fileHash(p) {
  const t = readText(p);
  return t === null ? null : sha256(t);
}

export function mtimeMs(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

// List files relative to root (forward-slash), skipping excluded globs, .git and
// temporary files.
export function walkFiles(root, { exclude = [".git/**", "node_modules/**"], max = 20000 } = {}) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    const abs = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.name.endsWith(".tmp")) continue;
      if (matchesAny(childRel, exclude)) continue;
      if (matchesAny(childRel + "/**", exclude)) continue;
      if (ent.isDirectory()) {
        stack.push(childRel);
      } else if (ent.isFile()) {
        out.push(childRel);
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}
