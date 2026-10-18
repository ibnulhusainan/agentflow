import path from "node:path";
import { exists, readJson, writeJsonAtomic } from "./fsutil.mjs";
import { stateRoot } from "./config.mjs";

export const USAGE_FILE = "usage.json";

// Mirrors taskDir() without importing task.mjs (avoids a module cycle).
function usagePath(root, config, id) {
  return path.join(stateRoot(root, config), "tasks", id, USAGE_FILE);
}

export function emptyUsage(id, now) {
  return {
    schema_version: 1,
    kind: "usage",
    task_id: id,
    updated_at: now || new Date().toISOString(),
    items: [],
    totals: { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
  };
}

// Loads usage.json; `ok:false` with value:null when absent or unparseable.
export function loadUsage(root, config, id) {
  const p = usagePath(root, config, id);
  if (!exists(p)) return { ok: false, error: "missing", path: p, value: null };
  const r = readJson(p);
  if (!r.ok) return { ok: false, error: r.error, path: p, value: null };
  return { ok: true, path: p, value: r.value };
}

function numeric(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
}

// Adds (or merges) one usage record for a plan item and recomputes totals.
// Returns { ok, value } for the new document.
export function addUsage(root, config, id, record, now) {
  const loaded = loadUsage(root, config, id);
  const doc = loaded.ok ? loaded.value : emptyUsage(id, now);
  const item = {
    item_id: String(record.item_id),
    requests: numeric(record.requests),
    input_tokens: numeric(record.input_tokens),
    output_tokens: numeric(record.output_tokens),
    cache_read_tokens: numeric(record.cache_read_tokens),
    note: typeof record.note === "string" && record.note ? record.note : null,
  };

  const existing = (Array.isArray(doc.items) ? doc.items : []).find(
    (i) => i && i.item_id === item.item_id,
  );
  if (existing) {
    // Cumulative per item: keep the running maximum of what has been spent.
    existing.requests = Math.max(numeric(existing.requests), item.requests);
    existing.input_tokens = Math.max(numeric(existing.input_tokens), item.input_tokens);
    existing.output_tokens = Math.max(numeric(existing.output_tokens), item.output_tokens);
    existing.cache_read_tokens = Math.max(
      numeric(existing.cache_read_tokens),
      item.cache_read_tokens,
    );
    existing.note = item.note ?? existing.note;
  } else {
    doc.items = [...(Array.isArray(doc.items) ? doc.items : []), item];
  }

  doc.task_id = id;
  doc.updated_at = now || new Date().toISOString();
  doc.totals = doc.items.reduce(
    (acc, i) => ({
      requests: acc.requests + numeric(i.requests),
      input_tokens: acc.input_tokens + numeric(i.input_tokens),
      output_tokens: acc.output_tokens + numeric(i.output_tokens),
      cache_read_tokens: acc.cache_read_tokens + numeric(i.cache_read_tokens),
    }),
    { requests: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 },
  );

  const p = usagePath(root, config, id);
  writeJsonAtomic(p, doc);
  return { ok: true, path: p, value: doc };
}

// Compares recorded usage against `config.budget`. `item_id` scopes the check
// to one plan item; omit it to check every item plus totals.
// Returns { ok, budget, exceeded: [...], warned: [...] }.
export function checkUsage(root, config, id, { item_id = null } = {}) {
  const budget = config?.budget || {};
  const warn = typeof budget.warn_ratio === "number" ? budget.warn_ratio : 0.8;
  const loaded = loadUsage(root, config, id);

  if (!loaded.ok) {
    return { ok: true, present: false, budget, exceeded: [], warned: [], items: [], recommend_compact: false };
  }

  const items = (Array.isArray(loaded.value.items) ? loaded.value.items : []).filter(
    (i) => !item_id || (i && i.item_id === item_id),
  );

  const exceeded = [];
  const warned = [];
  const row = (id_, field, value, limit) => {
    if (typeof limit !== "number" || !(limit > 0)) return;
    if (value > limit) {
      exceeded.push({ item_id: id_, field, value, limit });
    } else if (value >= limit * warn) {
      warned.push({ item_id: id_, field, value, limit });
    }
  };

  for (const i of items) {
    const k = i?.item_id || "?";
    row(k, "requests", numeric(i.requests), budget.max_requests_per_item);
    row(k, "input_tokens", numeric(i.input_tokens), budget.max_input_tokens_per_item);
    row(k, "output_tokens", numeric(i.output_tokens), budget.max_output_tokens_per_item);
  }

  const recommendCompact = exceeded.length > 0 || warned.length > 0;
  return {
    ok: exceeded.length === 0,
    present: true,
    item_id,
    budget,
    exceeded,
    warned,
    items,
    totals: loaded.value.totals || null,
    recommend_compact: recommendCompact,
  };
}
