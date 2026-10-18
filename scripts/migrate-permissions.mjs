#!/usr/bin/env node
// One-shot migration: OpenCode agent frontmatter and the project config used
// the internal array form `permissions: [{action, resource, effect}]`, which the
// runtime does not accept in markdown frontmatter / config files. The documented
// form is `permission:` — a map of tool key -> action, or tool key ->
// { pattern: action } where the last matching pattern wins.
//
// Idempotent: files already using `permission:` are left alone.
//
// Usage: node scripts/migrate-permissions.mjs
import fs from "node:fs";
import path from "node:path";

const ACTION_TO_KEY = {
  read: "read",
  edit: "edit",
  write: "edit",
  patch: "edit",
  bash: "bash",
  shell: "bash",
  task: "task",
  subagent: "task",
  glob: "glob",
  grep: "grep",
  list: "list",
  webfetch: "webfetch",
  websearch: "websearch",
  lsp: "lsp",
  skill: "skill",
  external_directory: "external_directory",
};

// A YAML scalar: either "double quoted" (may contain spaces) or a bare token.
function parseScalar(raw) {
  const s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return JSON.parse(s);
  }
  return s;
}

function needsQuote(v) {
  if (v === "") return true;
  if (/^[\s]|[\s]$/.test(v)) return true;
  if (/[:#{}[\],&*!|>'"%@`]/.test(v)) return true;
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(v)) return true;
  return false;
}

function scalar(v) {
  return needsQuote(v) ? JSON.stringify(v) : v;
}

function convertEntries(entries, where) {
  const byKey = new Map();
  for (const e of entries) {
    const key = ACTION_TO_KEY[e.action];
    if (!key) throw new Error(`${where}: unknown action "${e.action}"`);
    if (e.resource === undefined) throw new Error(`${where}: missing resource for action "${e.action}"`);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push([e.resource, e.effect]);
  }
  const out = {};
  for (const [key, rules] of byKey) {
    const isBare = rules.length === 1 && rules[0][0] === "*";
    if (isBare) {
      out[key] = rules[0][1];
      continue;
    }
    const obj = {};
    for (const [res, eff] of rules) obj[res] = eff;
    out[key] = obj;
  }
  return out;
}

function render(obj, indent) {
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string") {
      lines.push(`${pad}${k}: ${v}`);
    } else {
      lines.push(`${pad}${k}:`);
      for (const [rk, rv] of Object.entries(v)) lines.push(`${pad}  ${scalar(rk)}: ${rv}`);
    }
  }
  return lines;
}

// Parse the `permissions:` array block that starts at `start`.
function parseBlock(lines, start) {
  const entries = [];
  let cur = null;
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    const item = line.match(/^\s*-\s+action:\s*(.+?)\s*$/);
    if (item) {
      cur = { action: parseScalar(item[1]) };
      entries.push(cur);
      end = i + 1;
      continue;
    }
    const field = line.match(/^\s+(resource|effect):\s*(.+?)\s*$/);
    if (field && cur) {
      cur[field[1]] = parseScalar(field[2]);
      end = i + 1;
    }
  }
  return { entries, end };
}

function migrateAgent(file) {
  const text = fs.readFileSync(file, "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return false;
  const fmLines = m[1].split("\n");
  const idx = fmLines.findIndex((l) => l === "permissions:");
  if (idx === -1) return false;

  const { entries, end } = parseBlock(fmLines, idx);
  if (!entries.length) throw new Error(`${file}: could not parse permissions block`);
  const converted = convertEntries(entries, file);

  const body = [
    ...fmLines.slice(0, idx),
    "permission:",
    ...render(converted, 2),
    ...fmLines.slice(end),
  ].join("\n");

  fs.writeFileSync(file, `---\n${body}\n---\n${text.slice(m[0].length)}`);
  return true;
}

function migrateConfig(file) {
  let text = fs.readFileSync(file, "utf8");
  const lines = text.split("\n");
  const idx = lines.findIndex((l) => /^\s*"permissions":\s*\[\s*$/.test(l));
  if (idx === -1) return false;
  const indent = lines[idx].match(/^\s*/)[0];
  const { entries, end } = parseBlock(lines, idx);
  if (!entries.length) throw new Error(`${file}: could not parse permissions array`);
  const converted = convertEntries(entries, file);

  const block = [`${indent}"permission": {`];
  const inner = Object.entries(converted);
  inner.forEach(([k, v], i) => {
    if (typeof v === "string") {
      block.push(`${indent}  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    } else {
      block.push(`${indent}  ${JSON.stringify(k)}: {`);
      const rows = Object.entries(v);
      rows.forEach(([rk, rv], j) => {
        block.push(`${indent}    ${JSON.stringify(rk)}: ${JSON.stringify(rv)}${j === rows.length - 1 ? "" : ","}`);
      });
      block.push(`${indent}  }${i === inner.length - 1 ? "" : ","}`);
    }
  });
  block.push(`${indent}}`);

  const out = [...lines.slice(0, idx), ...block, ...lines.slice(end)];
  text = out.join("\n");
  // The array form ended with a trailing comma on its last element; drop a
  // dangling comma before a closing bracket that now no longer exists.
  text = text.replace(/,(\s*)\]/g, "$1]");
  fs.writeFileSync(file, text);
  return true;
}

const root = path.resolve(import.meta.dirname, "..");
let n = 0;

const agentDir = path.join(root, "adapters/opencode/agents");
for (const f of fs.readdirSync(agentDir).filter((f) => f.endsWith(".md"))) {
  if (migrateAgent(path.join(agentDir, f))) {
    console.log("agent  ", f);
    n++;
  }
}

const cfg = path.join(root, "adapters/opencode/opencode.jsonc");
if (migrateConfig(cfg)) {
  console.log("config ", path.relative(root, cfg));
  n++;
}

console.log(`${n} file(s) migrated`);