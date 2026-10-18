import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { walkFiles, readText, readJson, exists, writeJsonAtomic } from "./fsutil.mjs";
import { matchesAny } from "./glob.mjs";
import { headCommit } from "./git.mjs";

const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|go\.mod|Cargo\.toml|requirements\.txt|Gemfile|composer\.json)$/;

// Ordered registry of deterministic fact kinds. Every kind is project-agnostic:
// behaviour is driven by `config.facts.<kind>` (see DEFAULTS in config.mjs).
export const FACT_KINDS = ["repo-structure", "inventory", "imports", "routes", "schema", "verify-state"];

// What each kind covers (used as the knowledge-index summary on --register).
const FACT_SUMMARIES = {
  "repo-structure": "Top-level layout, manifest files and scoped file counts for the repository.",
  inventory: "Per-file inventory with role classification, line counts and tsconfig membership.",
  imports: "Import graph edges (importer to imported) for in-repo code files, plus unresolved and external counts.",
  routes: "HTTP handler and page modules with exported methods, derived routes and configured guard/validation signals.",
  schema: "Declared schema definitions, migration files in order and tracked database file existence.",
  "verify-state": "Recorded verification commands, exit codes and acceptance-criterion results per task.",
};

const FACT_FILENAMES = { "repo-structure": "repo.json" };
export function factFilename(kind) {
  return FACT_FILENAMES[kind] || `${kind}.json`;
}

// Incremental equivalent of sha256(parts.join("\n")) — same digest, without
// materialising one giant string (which overflows on large roots).
function hashSources(root, files) {
  const h = crypto.createHash("sha256");
  const list = files || [];
  list.forEach((f, i) => {
    if (i) h.update("\n");
    h.update(`${f}:${readText(path.join(root, f)) ?? ""}`);
  });
  return "sha256:" + h.digest("hex");
}

function factDoc(root, { id, scope, data, sources, now }) {
  return {
    schema_version: 1,
    kind: "facts",
    id,
    generated_at: now || new Date().toISOString(),
    generator: "agentflow facts",
    source_revision: { git_commit: headCommit(root), content_hash: hashSources(root, sources) },
    scope,
    data,
  };
}

function pickScope(cfgScope, fallback) {
  return Array.isArray(cfgScope) && cfgScope.length ? cfgScope : fallback;
}

function countLoc(text) {
  if (text === null) return 0;
  return text.split("\n").length;
}

// ---------------------------------------------------------------- repo-structure

function genRepoStructure(root, config, cfg, { scope, now }) {
  const exclude = config?.exclude || [];
  const files = walkFiles(root, { exclude });
  const relScope = pickScope(scope.length ? scope : cfg.scope, ["**/*"]);
  const scoped = files.filter((f) => matchesAny(f, relScope)).sort();
  return factDoc(root, {
    id: cfg.id,
    scope: relScope,
    sources: scoped,
    now,
    data: {
      top_level: [...new Set(files.map((f) => f.split("/")[0]))].sort(),
      file_count: files.length,
      manifests: files.filter((f) => MANIFEST_RE.test(f)).sort(),
      scoped_file_count: scoped.length,
    },
  });
}

// Keep the historical single-doc API working for existing callers/tests.
export function generateFacts(root, config, { scope = [], now } = {}) {
  const cfg = config?.facts?.["repo-structure"] || { id: "k-repo-structure", scope: [] };
  return genRepoStructure(root, config, { id: cfg.id || "k-repo-structure", scope: cfg.scope }, { scope, now });
}

// ---------------------------------------------------------------- inventory

// JSONC-tolerant parse: strip // and /* */ comments WITHOUT touching string
// literals (a naive regex eats glob strings like "src/**/*").
function stripJsonComments(text) {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// Returns { include: string[] | null, } — null include means "no include field"
// (TypeScript then includes every source file: membership = true).
function tsconfigIncludes(root, tsconfigPath) {
  const abs = path.join(root, tsconfigPath || "tsconfig.json");
  if (!exists(abs)) return null;
  const text = readText(abs);
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(text));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed?.include)) return { include: null };
  return { include: parsed.include.filter((p) => typeof p === "string") };
}

function roleFor(file, rolePatterns) {
  for (const rp of rolePatterns || []) {
    if (matchesAny(file, rp.patterns || [])) return rp.role;
  }
  return "other";
}

function genInventory(root, config, cfg, { scope, now }) {
  const exclude = config?.exclude || [];
  const relScope = pickScope(scope.length ? scope : cfg.scope, ["**/*"]);
  const files = walkFiles(root, { exclude }).filter((f) => matchesAny(f, relScope)).sort();
  const ts = tsconfigIncludes(root, cfg.tsconfig);
  const entries = files.map((f) => {
    const include = ts === null ? null : ts.include;
    return {
      path: f,
      role: roleFor(f, cfg.role_patterns),
      loc: countLoc(readText(path.join(root, f))),
      in_tsconfig: include === null ? null : include.length === 0 ? true : matchesAny(f, include),
    };
  });
  return factDoc(root, {
    id: cfg.id,
    scope: relScope,
    sources: files,
    now,
    data: { file_count: entries.length, files: entries },
  });
}

// ---------------------------------------------------------------- imports

const IMPORT_RES = [
  /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
  /require\(\s*['"]([^'"]+)['"]\s*\)/g,
];

const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

// Resolve a relative specifier to an existing repo file (extension inference
// for extensionless TS/JS imports). Returns null when nothing matches.
function resolveRelative(root, importer, spec) {
  const base = path.posix.dirname(importer);
  const norm = path.posix.normalize(`${base}/${spec}`).replace(/^\.\//, "");
  for (const ext of RESOLVE_EXTS) {
    if (exists(path.join(root, norm + ext))) return norm + ext;
  }
  return null;
}

function genImports(root, config, cfg, { scope, now }) {
  const exclude = config?.exclude || [];
  const relScope = pickScope(scope.length ? scope : cfg.scope, ["**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]);
  const files = walkFiles(root, { exclude }).filter((f) => matchesAny(f, relScope)).sort();
  const edges = [];
  const unresolved = [];
  let external = 0;
  for (const f of files) {
    const text = readText(path.join(root, f));
    if (text === null) continue;
    const specs = new Set();
    for (const re of IMPORT_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) specs.add(m[1]);
    }
    for (const spec of specs) {
      if (!spec.startsWith("./") && !spec.startsWith("../")) {
        external++;
        continue;
      }
      const to = resolveRelative(root, f, spec);
      if (to) edges.push({ from: f, to });
      else unresolved.push({ from: f, spec });
    }
  }
  edges.sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
  unresolved.sort((a, b) => (a.from === b.from ? a.spec.localeCompare(b.spec) : a.from.localeCompare(b.from)));
  return factDoc(root, {
    id: cfg.id,
    scope: relScope,
    sources: files,
    now,
    data: { files_scanned: files.length, edges, unresolved, external_imports: external },
  });
}

// ---------------------------------------------------------------- routes

function detectAppDir(files) {
  for (const cand of ["src/app", "app"]) {
    if (files.some((f) => f.startsWith(cand + "/"))) return cand;
  }
  return null;
}

function routeOf(rel, appDir) {
  let p = rel;
  if (appDir && p.startsWith(appDir + "/")) p = p.slice(appDir.length + 1);
  p = p.replace(/\/(route|page)\.[^.]+$/, "");
  const segs = p.split("/").filter((s) => s && !/^\(.*\)$/.test(s));
  const route = "/" + segs.join("/");
  return { route, dynamic: segs.some((s) => s.includes("[")) };
}

function matchSignals(text, signalRules) {
  const out = {};
  for (const [name, rules] of Object.entries(signalRules || {})) {
    out[name] = null;
    for (const r of rules || []) {
      let re;
      try {
        re = new RegExp(r.pattern, "m");
      } catch {
        continue;
      }
      if (re.test(text)) {
        out[name] = r.value ?? true;
        break;
      }
    }
  }
  return out;
}

function genRoutes(root, config, cfg, { scope, now }) {
  const exclude = config?.exclude || [];
  const handlerScope = pickScope(scope.length ? scope : cfg.scope, ["**/route.ts", "**/route.tsx", "**/route.js", "**/route.jsx"]);
  const pageScope = pickScope(cfg.page_scope, ["**/page.ts", "**/page.tsx", "**/page.js", "**/page.jsx"]);
  const all = walkFiles(root, { exclude });
  const handlerFiles = all.filter((f) => matchesAny(f, handlerScope)).sort();
  const pageFiles = all.filter((f) => matchesAny(f, pageScope)).sort();
  const appDir = cfg.app_dir || detectAppDir(all);

  let methodRe;
  try {
    methodRe = new RegExp(cfg.method_pattern, "gm");
  } catch {
    methodRe = null;
  }

  const handlers = handlerFiles.map((f) => {
    const text = readText(path.join(root, f)) ?? "";
    const methods = new Set();
    if (methodRe) {
      methodRe.lastIndex = 0;
      let m;
      while ((m = methodRe.exec(text)) !== null) methods.add(m[1] || m[0]);
    }
    const { route, dynamic } = routeOf(f, appDir);
    return { path: f, route, dynamic, methods: [...methods].sort(), ...matchSignals(text, cfg.signals) };
  });
  const pages = pageFiles.map((f) => {
    const { route, dynamic } = routeOf(f, appDir);
    return { path: f, route, dynamic };
  });

  return factDoc(root, {
    id: cfg.id,
    scope: handlerScope,
    sources: [...handlerFiles, ...pageFiles],
    now,
    data: { app_dir: appDir, handlers, pages },
  });
}

// ---------------------------------------------------------------- schema

function genSchema(root, config, cfg, { scope, now }) {
  const exclude = config?.exclude || [];
  const all = walkFiles(root, { exclude });
  const extractors = Array.isArray(cfg.extractors) ? cfg.extractors : [];
  const migrationGlobs = Array.isArray(cfg.migration_globs) ? cfg.migration_globs : [];

  const definitions = [];
  const definitionFiles = [];
  for (const ex of extractors) {
    let re;
    try {
      re = new RegExp(ex.pattern, "g");
    } catch {
      continue;
    }
    const files = all.filter((f) => matchesAny(f, ex.include || [])).sort();
    for (const f of files) {
      definitionFiles.push(f);
      const text = readText(path.join(root, f));
      if (text === null) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) definitions.push({ extractor: ex.id, file: f, name: m[1] || m[0] });
    }
  }
  const migrations = all.filter((f) => matchesAny(f, migrationGlobs)).sort();
  const dbFiles = (Array.isArray(cfg.db_files) ? cfg.db_files : []).map((p) => ({ path: p, exists: exists(path.join(root, p)) }));

  const relScope = pickScope(scope.length ? scope : cfg.scope, [
    ...extractors.flatMap((e) => e.include || []),
    ...migrationGlobs,
  ]);
  const scoped = all.filter((f) => matchesAny(f, relScope)).sort();
  return factDoc(root, {
    id: cfg.id,
    scope: relScope.length ? relScope : ["**/*"],
    sources: [...new Set([...definitionFiles, ...scoped])].sort(),
    now,
    data: { definitions, migrations, db_files: dbFiles },
  });
}

// ---------------------------------------------------------------- verify-state

function genVerifyState(root, config, cfg, { scope, now }) {
  const stateRootRel = config?.state_root ?? ".agent";
  const tasksDir = path.join(root, cfg.tasks_dir || `${stateRootRel}/tasks`);
  const sources = [];
  const tasks = [];
  let entries = [];
  try {
    entries = fs
      .readdirSync(tasksDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    entries = [];
  }
  let lastVerification = null;
  for (const id of entries) {
    const stateR = readJson(path.join(tasksDir, id, "state.json"));
    const resultR = readJson(path.join(tasksDir, id, "result.json"));
    if (stateR.ok) sources.push(`${stateRootRel}/tasks/${id}/state.json`);
    if (resultR.ok) sources.push(`${stateRootRel}/tasks/${id}/result.json`);
    const performedAt = resultR.ok ? resultR.value?.verification?.performed_at ?? null : null;
    if (performedAt && (!lastVerification || performedAt > lastVerification)) lastVerification = performedAt;
    tasks.push({
      task_id: id,
      status: stateR.ok ? stateR.value?.status ?? null : null,
      last_verification: performedAt,
      commands: (resultR.ok ? resultR.value?.verification?.commands : null)?.map((c) => ({
        cmd: c.cmd,
        exit_code: c.exit_code,
        result: c.result,
      })) ?? [],
      acceptance_criteria: (resultR.ok ? resultR.value?.acceptance_criteria : null)?.map((a) => ({
        id: a.id,
        met: a.met,
      })) ?? [],
    });
  }
  return factDoc(root, {
    id: cfg.id,
    scope: scope.length ? scope : [`${stateRootRel}/tasks/**`],
    sources,
    now,
    data: { task_count: tasks.length, last_verification: lastVerification, tasks },
  });
}

// ---------------------------------------------------------------- registry

const GENERATORS = {
  "repo-structure": genRepoStructure,
  inventory: genInventory,
  imports: genImports,
  routes: genRoutes,
  schema: genSchema,
  "verify-state": genVerifyState,
};

export function generateFactDoc(root, config, kind, { scope = [], now } = {}) {
  const gen = GENERATORS[kind];
  if (!gen) return null;
  const cfg = config?.facts?.[kind] || {};
  const defaults = { id: `k-${kind}`, scope: [] };
  return gen(root, config, { ...defaults, ...cfg }, { scope, now });
}

// Generate one document per requested kind. `scope` (from --scope) overrides the
// configured scope of file-scoped kinds; verify-state always reads the task tree.
export function generateFactsAll(root, config, { kinds = FACT_KINDS, scope = [], now } = {}) {
  const out = [];
  for (const kind of kinds) {
    if (!GENERATORS[kind]) continue;
    const override = kind === "verify-state" ? [] : scope;
    const doc = generateFactDoc(root, config, kind, { scope: override, now });
    out.push({ kind, id: doc.id, filename: factFilename(kind), doc });
  }
  return out;
}

// Upsert one knowledge-index entry per generated doc: each kind keeps its own
// scope and content_hash, so a change in one domain does not stale the others.
export function registerFactEntries(root, config, results) {
  const stateRootRel = config?.state_root ?? ".agent";
  const idxPath = path.join(root, stateRootRel, "knowledge", "index.json");
  const cur = readJson(idxPath);
  const index =
    cur.ok && cur.value && Array.isArray(cur.value.entries)
      ? cur.value
      : { schema_version: 1, generated_at: new Date().toISOString(), entries: [] };
  const registered = [];
  for (const r of results) {
    const entryPath = path.relative(root, path.join(root, stateRootRel, "knowledge", "facts", r.filename)).split(path.sep).join("/");
    const entry = {
      id: r.id,
      path: entryPath,
      type: "facts",
      scope: r.doc.scope,
      depends_on: [],
      owner: "analyzer",
      revision: r.doc.source_revision,
      status: "fresh",
      last_validated: r.doc.generated_at,
      summary: FACT_SUMMARIES[r.kind] || "Deterministic repository facts.",
    };
    const i = index.entries.findIndex((e) => e.id === r.id);
    if (i >= 0) index.entries[i] = entry;
    else index.entries.push(entry);
    registered.push(r.id);
  }
  index.generated_at = new Date().toISOString();
  writeJsonAtomic(idxPath, index);
  return { idxPath, index, registered };
}
