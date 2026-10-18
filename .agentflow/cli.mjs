#!/usr/bin/env node
import path from "node:path";
import { mkdirSync, readdirSync } from "node:fs";
import { exists, readJson, writeJsonAtomic, writeTextAtomic as writeFileAtomic } from "./lib/fsutil.mjs";
import { loadConfig, stateRoot } from "./lib/config.mjs";
import { taskDir } from "./lib/task.mjs";
import { isRepo, changedFiles, workingTreeChanges } from "./lib/git.mjs";
import { classifyIndex } from "./lib/freshness.mjs";
import { loadSchema } from "./lib/schemafile.mjs";
import { loadTask, validateTask, checkClosure, applyTransition, listTasks, currentTaskId } from "./lib/task.mjs";
import { addUsage, checkUsage } from "./lib/usage.mjs";
import { generateFactsAll, registerFactEntries, FACT_KINDS } from "./lib/facts.mjs";
import { emit } from "./lib/output.mjs";
import { modelsCommand } from "./lib/models.mjs";

const BOOLEANS = new Set(["json", "dry-run", "cross-module", "contract-change", "register", "help"]);

function camel(k) {
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf("=");
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (BOOLEANS.has(key)) {
        val = true;
      } else {
        val = argv[i + 1];
        if (val === undefined || String(val).startsWith("--")) val = true;
        else i++;
      }
      const k = camel(key);
      if (k in flags) flags[k] = [].concat(flags[k], val);
      else flags[k] = val;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function asArray(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function resolveRoot(flags) {
  return path.resolve(flags.root || process.env.AGENTFLOW_ROOT || process.cwd());
}

// `T-YYYYMMDD-NNN`, monotonically increasing within a day, gap-free.
function nextTaskId(tasksBase) {
  const d = new Date();
  const day = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("");
  const prefix = `T-${day}-`;
  let max = 0;
  let names = [];
  try {
    names = readdirSync(tasksBase);
  } catch {
    /* no tasks yet */
  }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const n2 = Number(n.slice(prefix.length));
    if (Number.isInteger(n2) && n2 > max) max = n2;
  }
  return `${prefix}${String(max + 1).padStart(3, "0")}`;
}

function mkdirp(p) {
  mkdirSync(p, { recursive: true });
}

// `--task current` resolves to the most recently updated open task, so a manual
// run (one role at a time, no Conductor) never has to remember an ID. An
// explicit ID always wins; only the keyword is resolved. Returns the sentinel
// NO_CURRENT_TASK when there is nothing to resolve, so each command can report
// "no task found" instead of a bare usage error.
const NO_CURRENT_TASK = Symbol("no-current-task");

function resolveTaskRef(ref, root, config) {
  if (!ref) return ref;
  if (ref !== "current") return ref;
  return currentTaskId(root, config) ?? NO_CURRENT_TASK;
}

// Emit the standard "nothing to work on" error for the sentinel.
function noCurrentTask(json) {
  emit(
    {
      ok: false,
      error: "no current task",
      hint: "create one: node .agentflow/cli.mjs task new --request <text> --files <n>",
    },
    json
  );
  return 1;
}

function usage() {
  return {
    ok: false,
    error: "usage",
    commands: [
      "status [--changed <ref>] [--json]",
      "task new [--id <T-YYYYMMDD-NNN>] [--request <text>] [--size <s>] [--files <n>] [--json]",
      "task list [--json]",
      "task current [--json]",
      "(every --task <id> also accepts --task current)",
      "facts [--kind <name>]... [--scope <glob>]... [--register] [--dry-run] [--json]",
      "classify --files <n> [--cross-module] [--contract-change] [--json]",
      "validate <task-id> [--json]",
      "transition --task <id> --to <status> [--by <role>] [--note <text>] [--json]",
      "close --task <id> [--by <role>] [--json]",
      "attempt --task <id> --item <P> [--json]",
      "spawn --task <id> [--json]",
      "discrepancy add --task <id> --severity <s> --type <t> --summary <s> --evidence <e> [--json]",
      "context --task <id> [--item <P>] [--json]",
      "usage add --task <id> --item <P> --requests <n> --input <n> --output <n> [--cache-read <n>] [--note <text>] [--json]",
      "usage check --task <id> [--item <P>] [--json]",
      "models show|check|next|set|apply [--role <r>] [--model <id>] [--reason <text>] [--json]",
      "init [--json]",
    ],
  };
}

export function run(argv, deps = {}) {
  const { positional, flags } = parseArgs(argv);
  const root = resolveRoot(flags);
  const json = !!flags.json;
  const cmd = positional[0];
  const { config, warnings } = loadConfig(root);
  const needSchema = () => {
    const s = loadSchema(root);
    return s.ok ? s.schema : null;
  };

  switch (cmd) {
    case "status": {
      const idxPath = path.join(stateRoot(root, config), "knowledge", "index.json");
      const idx = readJson(idxPath);
      if (!idx.ok) {
        emit({ ok: false, error: `knowledge index ${idx.error}`, path: idxPath, warnings }, json);
        return 1;
      }
      let changedSet = null;
      let source = "mtime";
      if (flags.changed) {
        const cf = changedFiles(root, flags.changed);
        if (cf) {
          changedSet = new Set(cf);
          source = "git";
        }
      } else if (isRepo(root)) {
        const wt = workingTreeChanges(root);
        if (wt) {
          changedSet = new Set(wt);
          source = "git";
        }
      }
      const ctx = {
        changedFiles: changedSet,
        nowMs: changedSet ? undefined : Date.now(),
        exclude: config.exclude,
      };
      const { entries, summary } = classifyIndex(root, idx.value, ctx);
      emit({ ok: true, source, entries, summary, warnings }, json);
      return 0;
    }

    case "facts": {
      const kindsFlag = asArray(flags.kind).map((k) => String(k).replace(/^k-/, ""));
      const unknown = [...new Set(kindsFlag)].filter((k) => !FACT_KINDS.includes(k));
      if (unknown.length) {
        emit({ ok: false, error: `unknown fact kind(s): ${unknown.join(", ")}`, kinds: FACT_KINDS }, json);
        return 2;
      }
      // Explicit --kind forces a kind; otherwise run everything enabled in config.
      const requested = kindsFlag.length
        ? [...new Set(kindsFlag)]
        : FACT_KINDS.filter((k) => config.facts?.[k]?.enabled !== false);
      const results = generateFactsAll(root, config, { kinds: requested, scope: asArray(flags.scope) });
      const base = path.join(stateRoot(root, config), "knowledge", "facts");
      const written = [];
      for (const r of results) {
        const out = path.join(base, r.filename);
        if (!flags.dryRun) writeJsonAtomic(out, r.doc);
        written.push(path.relative(root, out).split(path.sep).join("/"));
      }
      let registered = [];
      if (flags.register && !flags.dryRun) {
        registered = registerFactEntries(root, config, results).registered;
      }
      const repo = results.find((r) => r.kind === "repo-structure");
      emit({
        ok: true,
        ...(flags.dryRun ? { dry_run: true } : { status: "fresh" }),
        kinds: results.map((r) => r.kind),
        written,
        ...(registered.length ? { registered } : {}),
        ...(repo ? { file_count: repo.doc.data.file_count } : {}),
      }, json);
      return 0;
    }

    case "classify": {
      const files = Number(flags.files || 0);
      const st = config.small_task;
      const mediumMax = config.medium_max_files ?? 15;
      const smallOk =
        files <= st.max_files &&
        !(flags.crossModule && st.forbid_cross_module) &&
        !(flags.contractChange && st.forbid_contract_change);
      let size;
      let plan_required;
      if (smallOk) {
        size = "small";
        plan_required = false;
      } else if (files <= mediumMax) {
        size = "medium";
        plan_required = true;
      } else {
        size = "complex";
        plan_required = true;
      }
      emit({ ok: true, files, size, plan_required, threshold: st.max_files }, json);
      return 0;
    }

    // Create the task record. The Conductor owns `state.json`; without it every
    // lifecycle gate (validate/transition/attempt/close/context) refuses to run,
    // so this is the first thing a workflow must do — not a hand-written file.
    case "task": {
      if ((flags.help || positional[1]) === "new") {
        const base = taskDir(root, config, "");
        const id = flags.id || nextTaskId(base);
        if (flags.id && exists(path.join(base, flags.id, "state.json"))) {
          emit({ ok: false, error: `task ${flags.id} already exists` }, json);
          return 1;
        }
        const dir = taskDir(root, config, id);
        if (exists(path.join(dir, "state.json"))) {
          emit({ ok: false, error: `task ${id} already exists` }, json);
          return 1;
        }

        // Size is derived unless asserted, so `plan_required` cannot silently
        // disagree with the thresholds the core will later enforce.
        const files = flags.files !== undefined ? Number(flags.files) : 0;
        const mediumMax = config.medium_max_files ?? 15;
        const st = config.small_task;
        let size = flags.size;
        let planRequired;
        if (size === "small" || size === "medium" || size === "complex") {
          planRequired = size !== "small";
        } else {
          const smallOk =
            files <= st.max_files &&
            !(flags.crossModule && st.forbid_cross_module) &&
            !(flags.contractChange && st.forbid_contract_change);
          size = smallOk ? "small" : files <= mediumMax ? "medium" : "complex";
          planRequired = !smallOk;
        }
        if (flags.planRequired !== undefined) planRequired = flags.planRequired === "true" || flags.planRequired === true;

        const now = new Date().toISOString();
        const state = {
          schema_version: 1,
          task_id: id,
          reopened_from: null,
          status: "pending",
          size,
          plan_required: planRequired,
          created_at: now,
          updated_at: now,
          history: [{ at: now, from: null, to: "pending", by: flags.by || "conductor", note: "created" }],
          counters: {
            attempts_total: 0,
            max_attempts: config.limits.max_attempts,
            spawn_depth: 0,
            max_spawn_depth: config.limits.max_spawn_depth,
            children: 0,
            max_children: config.limits.max_children,
          },
          verification: { required: planRequired, passed: null },
          closure_check: { last_checked: null, passed: false, reasons: [] },
        };
        mkdirp(dir);
        writeJsonAtomic(path.join(dir, "state.json"), state);
        if (flags.request) writeFileAtomic(path.join(dir, "request.md"), `# ${id}\n\n${flags.request}\n`);
        emit(
          {
            ok: true,
            task_id: id,
            task_dir: path.relative(root, dir),
            status: state.status,
            size,
            plan_required: planRequired,
            next: planRequired ? "planner" : "executor",
          },
          json
        );
        return 0;
      }
      if (positional[1] === "list") {
        const tasks = listTasks(root, config);
        emit({ ok: true, count: tasks.length, tasks }, json);
        return 0;
      }

      if (positional[1] === "current") {
        const id = currentTaskId(root, config);
        if (!id) {
          emit({ ok: false, error: "no task found", hint: "create one: task new --request <text> --files <n>" }, json);
          return 1;
        }
        const state = loadTask(root, config, id).state.value;
        emit({ ok: true, task_id: id, status: state.status, plan_required: state.plan_required, next_action: state.plan_required ? "planner" : "executor" }, json);
        return 0;
      }

      emit(usage(), json);
      return 2;
    }

    case "validate": {
      const id = resolveTaskRef(positional[1] || flags.task, root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      if (!id) {
        emit(usage(), json);
        return 2;
      }
      const schema = needSchema();
      if (!schema) {
        emit({ ok: false, error: "contract schema not found" }, json);
        return 2;
      }
      const res = validateTask(root, config, id, schema);
      emit(res, json);
      return res.ok ? 0 : 1;
    }

    case "transition":
    case "close": {
      const id = resolveTaskRef(flags.task || positional[1], root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      const to = cmd === "close" ? "completed" : flags.to;
      if (!id || !to) {
        emit(usage(), json);
        return 2;
      }
      const t = loadTask(root, config, id);
      if (!t.state.ok) {
        emit({ ok: false, error: `state.json ${t.state.error} for ${id}` }, json);
        return 1;
      }
      if (to === "completed") {
        const schema = needSchema();
        const closure = schema ? checkClosure(root, config, id, schema) : { passed: false, reasons: ["schema not found"] };
        if (!closure.passed) {
          emit({ ok: false, error: "closure gates failed", task_id: id, reasons: closure.reasons }, json);
          return 1;
        }
      }
      const r = applyTransition(t.state.value, to, { by: flags.by || "unknown", note: flags.note });
      if (!r.ok) {
        emit({ ok: false, error: r.error, task_id: id }, json);
        return 1;
      }
      writeJsonAtomic(path.join(t.dir, "state.json"), r.state);
      emit({ ok: true, task_id: id, status: r.state.status }, json);
      return 0;
    }

    case "attempt": {
      const id = resolveTaskRef(flags.task || positional[1], root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      const item = flags.item;
      if (!id || !item) {
        emit(usage(), json);
        return 2;
      }
      const t = loadTask(root, config, id);
      if (!t.state.ok) {
        emit({ ok: false, error: `state.json ${t.state.error}` }, json);
        return 1;
      }
      const state = t.state.value;
      const maxA = state.counters?.max_attempts ?? config.limits.max_attempts;
      state.counters = state.counters || {};
      state.counters.attempts_total = (state.counters.attempts_total || 0) + 1;
      const now = new Date().toISOString();
      state.updated_at = now;
      if (t.progress.ok) {
        const prog = t.progress.value;
        prog.items = prog.items || {};
        const pi = prog.items[item] || { status: "in_progress", attempts: 0, updated_at: now };
        pi.attempts = (pi.attempts || 0) + 1;
        pi.updated_at = now;
        if (pi.attempts > maxA) pi.status = "blocked";
        prog.items[item] = pi;
        prog.updated_at = now;
        writeJsonAtomic(path.join(t.dir, "progress.json"), prog);
      }
      const allowed = state.counters.attempts_total <= maxA;
      if (!allowed) applyTransition(state, "blocked", { by: "core", note: "retry limit exceeded", at: now });
      writeJsonAtomic(path.join(t.dir, "state.json"), state);
      emit({ ok: allowed, allowed, task_id: id, item, attempts_total: state.counters.attempts_total, max_attempts: maxA }, json);
      return allowed ? 0 : 1;
    }

    case "spawn": {
      const id = resolveTaskRef(flags.task || positional[1], root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      if (!id) {
        emit(usage(), json);
        return 2;
      }
      const t = loadTask(root, config, id);
      if (!t.state.ok) {
        emit({ ok: false, error: `state.json ${t.state.error}` }, json);
        return 1;
      }
      const state = t.state.value;
      state.counters = state.counters || {};
      const maxDepth = state.counters.max_spawn_depth ?? config.limits.max_spawn_depth;
      const maxChildren = state.counters.max_children ?? config.limits.max_children;
      const depth = (state.counters.spawn_depth || 0) + 1;
      const children = (state.counters.children || 0) + 1;
      if (depth > maxDepth) {
        emit({ ok: false, allowed: false, reason: "max_spawn_depth exceeded", max_spawn_depth: maxDepth }, json);
        return 1;
      }
      if (children > maxChildren) {
        emit({ ok: false, allowed: false, reason: "max_children exceeded", max_children: maxChildren }, json);
        return 1;
      }
      state.counters.children = children;
      state.updated_at = new Date().toISOString();
      writeJsonAtomic(path.join(t.dir, "state.json"), state);
      emit({ ok: true, allowed: true, children, max_children: maxChildren }, json);
      return 0;
    }

    case "discrepancy": {
      const sub = positional[1];
      if (sub !== "add") {
        emit(usage(), json);
        return 2;
      }
      const id = resolveTaskRef(flags.task, root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      if (!id) {
        emit(usage(), json);
        return 2;
      }
      const t = loadTask(root, config, id);
      if (!t.dir) {
        emit({ ok: false, error: "task not found" }, json);
        return 1;
      }
      const file = path.join(t.dir, "discrepancies.json");
      const cur = readJson(file);
      const doc = cur.ok && cur.value?.items ? cur.value : { schema_version: 1, task_id: id, items: [] };
      const n = doc.items.length + 1;
      doc.items.push({
        id: `D${n}`,
        severity: flags.severity || "minor",
        type: flags.type || "implementation",
        summary: flags.summary || "(no summary)",
        evidence: flags.evidence || "(no evidence)",
        affected: { paths: asArray(flags.paths), knowledge_refs: asArray(flags.refs), plan_items: asArray(flags.items) },
        status: flags.status || "open",
        created_at: new Date().toISOString(),
        resolved_at: null,
        resolution: null,
      });
      writeJsonAtomic(file, doc);
      emit({ ok: true, task_id: id, discrepancy_id: `D${n}`, total: doc.items.length }, json);
      return 0;
    }

    // Minimal resume bundle: one cheap call that replaces reading state.json,
    // progress.json, plan.json, config.json and discrepancies.json separately.
    case "context": {
      const id = resolveTaskRef(flags.task || positional[1], root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      if (!id) {
        emit(usage(), json);
        return 2;
      }
      const t = loadTask(root, config, id);
      if (!t.state.ok) {
        emit({ ok: false, error: `state.json ${t.state.error} for ${id}` }, json);
        return 1;
      }
      const state = t.state.value;
      const plan = t.plan.ok ? t.plan.value : null;
      const prog = t.progress.ok ? t.progress.value : null;
      const items = (plan && plan.items) || [];

      // Resolve which plan item this session should work on.
      let itemId = flags.item || (prog && prog.next_action && prog.next_action.item_id) || null;
      if (itemId && !items.some((i) => i.id === itemId) && items.length) {
        emit({ ok: false, error: `item ${itemId} not in plan`, task_id: id }, json);
        return 1;
      }
      if (!itemId) {
        const next = items.find((i) => {
          const p = prog && prog.items && prog.items[i.id];
          return !p || (p.status !== "done" && p.status !== "skipped");
        });
        itemId = next ? next.id : null;
      }
      const item = items.find((i) => i.id === itemId) || null;
      const itemProgress = itemId && prog && prog.items && prog.items[itemId] ? prog.items[itemId] : null;

      const budget = checkUsage(root, config, id, itemId ? { item_id: itemId } : {});
      const used = (budget.items || []).find((i) => i.item_id === itemId) || null;

      const blockers = [];
      if (t.discrepancies.ok) {
        for (const d of t.discrepancies.value.items || []) {
          if (d.status === "open") blockers.push({ id: d.id, severity: d.severity, summary: d.summary });
        }
      }

      const knowledgeRefs = item
        ? item.knowledge_refs
        : [...new Set(items.flatMap((i) => i.knowledge_refs || []))];

      emit({
        ok: true,
        task_id: id,
        task_dir: path.relative(root, t.dir),
        status: state.status,
        size: state.size,
        plan_required: state.plan_required,
        next_action: prog ? prog.next_action : null,
        item: item
          ? {
              id: item.id,
              title: item.title,
              paths: item.paths,
              knowledge_refs: item.knowledge_refs,
              depends_on: item.depends_on,
              completion_criterion: item.completion_criterion,
            }
          : null,
        item_progress: itemProgress,
        open_items: items
          .filter((i) => {
            const p = prog && prog.items && prog.items[i.id];
            return !p || (p.status !== "done" && p.status !== "skipped");
          })
          .map((i) => i.id),
        counters: state.counters,
        knowledge_refs: knowledgeRefs,
        verify_commands: (config.verify && config.verify.commands) || [],
        open_discrepancies: blockers,
        budget: {
          present: budget.present,
          limits: config.budget || null,
          item_id: itemId,
          used,
          totals: budget.totals || null,
          exceeded: budget.exceeded,
          warned: budget.warned,
        },
        context_limits: config.context || null,
        warnings,
      }, json);
      return budget.exceeded.length > 0 ? 1 : 0;
    }

    // Record / verify self-reported token+request usage against config.budget.
    case "usage": {
      const sub = positional[1];
      const id = resolveTaskRef(flags.task || positional[2], root, config);
      if (id === NO_CURRENT_TASK) return noCurrentTask(json);
      if ((sub !== "add" && sub !== "check") || !id) {
        emit(usage(), json);
        return 2;
      }

      if (sub === "check") {
        const chk = checkUsage(root, config, id, flags.item ? { item_id: flags.item } : {});
        emit({ ...chk, task_id: id, command: "usage check" }, json);
        return chk.exceeded.length > 0 ? 1 : 0;
      }

      // add
      const item = flags.item;
      const num = (k) => {
        if (flags[k] === undefined) return 0;
        const n = Number(flags[k]);
        return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : NaN;
      };
      if (!item || !/^P\d+(\.\d+)*$/.test(item)) {
        emit({ ok: false, error: "usage add requires --item <Pn> (e.g. P2)" }, json);
        return 2;
      }
      const record = {
        item_id: item,
        requests: num("requests"),
        input_tokens: num("input"),
        output_tokens: num("output"),
        cache_read_tokens: num("cacheRead"),
        note: flags.note || null,
      };
      if (Object.values(record).some((v) => Number.isNaN(v))) {
        emit({ ok: false, error: "usage add: --requests/--input/--output/--cache-read must be non-negative numbers" }, json);
        return 2;
      }
      const t = loadTask(root, config, id);
      if (!t.state.ok) {
        emit({ ok: false, error: `state.json ${t.state.error} for ${id}` }, json);
        return 1;
      }
      if (t.plan.ok && !t.plan.value.items.some((i) => i.id === item)) {
        emit({ ok: false, error: `item ${item} not in plan`, task_id: id }, json);
        return 1;
      }
      const res = addUsage(root, config, id, record);
      const chk = checkUsage(root, config, id, { item_id: item });
      emit({
        ok: chk.exceeded.length === 0,
        written: res.path,
        task_id: id,
        item_id: item,
        totals: res.value.totals,
        exceeded: chk.exceeded,
        warned: chk.warned,
        hint: chk.exceeded.length ? "budget exceeded: stop the affected item and hand off" : undefined,
      }, json);
      return chk.exceeded.length > 0 ? 1 : 0;
    }

    case "init": {
      const base = stateRoot(root, config);
      const created = [];
      const ensure = (p, content) => {
        if (!exists(p)) {
          writeJsonAtomic(p, content);
          created.push(path.relative(root, p));
        }
      };
      ensure(path.join(base, "knowledge", "index.json"), {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        entries: [],
      });
      emit({ ok: true, root, created, state_root: path.relative(root, base) }, json);
      return 0;
    }

    case "models": {
      // Models chain command (manual fallback, phase 1).
      return modelsCommand(root, config, { ...flags, sub: positional[1] || "show" }, json, { emit, currentTaskId });
    }

    default:
      emit(usage(), json);
      return 2;
  }
}

// Allow `node cli.mjs ...` directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = run(process.argv.slice(2));
}
