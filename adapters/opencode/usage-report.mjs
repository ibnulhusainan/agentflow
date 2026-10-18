#!/usr/bin/env node
// OpenCode adapter: context-composition report.
//
// Answers "measure before trimming": for each session, how much of the context
// sent per request is system/assistant text vs tool input vs tool output, and
// how much of the input was served from prompt cache.
//
// Reads the OpenCode SQLite store read-only. Zero external dependencies: uses
// the bundled `node:sqlite` module (Node >= 22.5, verified on Node 24).
//
// Limitations (honest):
//  - The store keeps token totals per *session*, not per block. Composition is
//    therefore derived from block character counts (chars/4 as a token proxy),
//    which is a ratio estimate, not exact billing data.
//  - `session_v2` totals include all requests; per-request tokens are not stored.
//  - read-only; never writes to the database.

import os from "node:os";
import path from "node:path";

// `node:sqlite` is bundled but experimental; load it defensively so the script
// degrades to a clear message instead of crashing on older runtimes.
let DatabaseSync = null;
let sqliteLoadError = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch (e) {
  sqliteLoadError = e;
}

const CHARS_PER_TOKEN = 4;

const USAGE = {
  ok: false,
  error: "usage",
  commands: [
    "usage-report [--db <path>] [--session <id>] [--directory <substring>] [--limit <n>] [--json]",
    "usage-report --list [--directory <substring>] [--limit <n>] [--json]",
  ],
  defaults: { db: "~/.local/share/opencode/opencode.db" },
};

function defaultDbPath() {
  return process.env.OPENCODE_DB || path.join(os.homedir(), ".local/share/opencode/opencode.db");
}

function parseArgs(argv) {
  const flags = {};
  const BOOL = new Set(["json", "list", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    if (BOOL.has(key)) {
      flags[key] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith("--")) flags[key] = true;
    else {
      flags[key] = v;
      i++;
    }
  }
  return flags;
}

const estTokens = (chars) => Math.round(chars / CHARS_PER_TOKEN);

function textOf(v) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(textOf).join("");
  if (v && typeof v === "object") return textOf(v.text ?? v.content ?? "");
  return "";
}

// Classifies one message's content blocks into context categories.
// Returns { class: chars } for the message.
function classifyMessage(type, data) {
  const out = {};
  const add = (k, chars) => {
    if (!chars) return;
    out[k] = (out[k] || 0) + chars;
  };

  if (type === "user") {
    add("user_text", textOf(data.text).length + textOf(data.files).length);
    return out;
  }
  if (type !== "assistant") {
    add("other", JSON.stringify(data ?? {}).length);
    return out;
  }

  for (const block of data.content || []) {
    if (block.type === "text") add("assistant_text", textOf(block.text).length);
    else if (block.type === "reasoning") add("reasoning", textOf(block.text).length);
    else if (block.type === "tool") {
      add("tool_input", JSON.stringify(block.state?.input ?? {}).length);
      add("tool_output", textOf(block.state?.content).length);
    } else add("other", JSON.stringify(block).length);
  }
  return out;
}

function loadSqlite(dbPath) {
  if (!DatabaseSync) {
    return {
      ok: false,
      error: `node:sqlite unavailable (needs Node >= 22.5): ${sqliteLoadError?.message || "unknown"}`,
    };
  }
  try {
    return { ok: true, db: new DatabaseSync(dbPath, { readOnly: true }) };
  } catch (e) {
    return { ok: false, error: `cannot open database ${dbPath}: ${e.message}` };
  }
}

function listSessions(db, { directory = null, limit = 10 }) {
  const sql = [
    "select id, slug, agent, model, directory, cost,",
    "tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_updated",
    "from session_v2",
    directory ? "where directory like ?" : "",
    "order by time_updated desc limit ?",
  ].join(" ");
  const args = directory ? [`%${directory}%`, limit] : [limit];
  return db.prepare(sql).all(...args);
}

function sessionReport(db, row) {
  const totals = {
    input: row.tokens_input || 0,
    output: row.tokens_output || 0,
    cache_read: row.tokens_cache_read || 0,
    cache_write: row.tokens_cache_write || 0,
  };
  const promptSide = totals.input + totals.cache_read;
  const cache_hit_ratio = promptSide ? totals.cache_read / promptSide : 0;

  const msgs = db
    .prepare("select type, data from session_message where session_id=? order by seq")
    .all(row.id);

  const messageCounts = {};
  const totalsByClass = {};
  const growth = [];
  let cumulative = 0;

  for (const m of msgs) {
    let data = {};
    try {
      data = JSON.parse(m.data);
    } catch {
      data = {};
    }
    messageCounts[m.type] = (messageCounts[m.type] || 0) + 1;

    const byClass = classifyMessage(m.type, data);
    let turnChars = 0;
    for (const [k, chars] of Object.entries(byClass)) {
      totalsByClass[k] = (totalsByClass[k] || 0) + chars;
      turnChars += chars;
    }
    cumulative += turnChars;
    if (m.type === "assistant") growth.push({ seq: growth.length + 1, cumulative_est_tokens: estTokens(cumulative) });
  }

  const composedChars = Object.values(totalsByClass).reduce((a, b) => a + b, 0);
  const composition = {};
  for (const [k, chars] of Object.entries(totalsByClass).sort((a, b) => b[1] - a[1])) {
    composition[k] = {
      chars,
      est_tokens: estTokens(chars),
      share: composedChars ? Number((chars / composedChars).toFixed(4)) : 0,
    };
  }

  const promptChars = estTokens(composedChars);
  return {
    session_id: row.id,
    slug: row.slug,
    agent: row.agent,
    model: row.model,
    directory: row.directory,
    cost: row.cost ?? 0,
    totals,
    cache_hit_ratio: Number(cache_hit_ratio.toFixed(4)),
    uncached_input: totals.input,
    prompt_side_tokens: promptSide,
    messages: messageCounts,
    turns: messageCounts.assistant || 0,
    composition,
    context_estimate: {
      blocks_est_tokens: promptChars,
      vs_reported_prompt_tokens: promptSide ? Number((promptChars / promptSide).toFixed(3)) : null,
    },
    growth,
  };
}

export function buildReport(opts = {}) {
  const dbPath = opts.db || defaultDbPath();
  const limit = Number(opts.limit || 10);
  const directory = opts.directory || null;
  const loaded = loadSqlite(dbPath);
  if (!loaded.ok) return { ok: false, error: loaded.error, db: dbPath };
  const db = loaded.db;

  const rows = listSessions(db, { directory, limit });
  if (opts.list) {
    return {
      ok: true,
      db: dbPath,
      list: rows.map((r) => ({
        session_id: r.id,
        slug: r.slug,
        agent: r.agent,
        directory: r.directory,
        input: r.tokens_input,
        output: r.tokens_output,
        cache_read: r.tokens_cache_read,
      })),
    };
  }

  const wanted = opts.session ? rows.filter((r) => r.id === opts.session) : rows;
  const chosen = opts.session && !wanted.length ? [] : wanted;
  const sessions = chosen.map((r) => sessionReport(db, r));
  if (opts.session && !sessions.length) {
    return { ok: false, error: `session ${opts.session} not found (try --list)`, db: dbPath };
  }
  return { ok: true, db: dbPath, count: sessions.length, sessions };
}

export function human(report) {
  if (!report.ok) return `ERROR: ${report.error}`;
  if (report.list) {
    return [
      `db: ${report.db}`,
      ...report.list.map(
        (s) => `${s.session_id}  ${String(s.agent).padEnd(9)} in=${s.input} out=${s.output} cache=${s.cache_read}  ${s.slug}`,
      ),
    ].join("\n");
  }
  const lines = [`db: ${report.db}`, `sessions: ${report.count}`];
  for (const s of report.sessions) {
    lines.push("");
    lines.push(`${s.slug} (${s.session_id})  agent=${s.agent}  turns=${s.turns}  cost=${s.cost}`);
    lines.push(`  tokens: input=${s.totals.input} cache_read=${s.totals.cache_read} output=${s.totals.output}`);
    lines.push(`  cache hit ratio: ${(s.cache_hit_ratio * 100).toFixed(1)}% (uncached input ${s.uncached_input})`);
    const top = Object.entries(s.composition).slice(0, 6);
    lines.push("  context composition (est. tokens / share):");
    for (const [k, v] of top) lines.push(`    ${k.padEnd(16)} ${String(v.est_tokens).padStart(8)}  ${(v.share * 100).toFixed(1)}%`);
    const g = s.growth;
    if (g.length) {
      const last = g[g.length - 1];
      const first = g[0];
      lines.push(`  context per turn (est. tokens): first=${first.cumulative_est_tokens} last=${last.cumulative_est_tokens}`);
    }
  }
  return lines.join("\n");
}

// CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(JSON.stringify(USAGE, null, 2));
    process.exit(2);
  }
  const report = buildReport({
    db: flags.db && flags.db !== true ? flags.db : undefined,
    session: flags.session && flags.session !== true ? flags.session : undefined,
    directory: flags.directory && flags.directory !== true ? flags.directory : undefined,
    limit: flags.limit && flags.limit !== true ? flags.limit : undefined,
    list: !!flags.list,
  });
  console.log(flags.json ? JSON.stringify(report, null, 2) : human(report));
  process.exit(report.ok ? 0 : 1);
}
