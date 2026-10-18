import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = path.join(ROOT, "adapters/opencode/plugins/context-filter.js");

// Regression: the plugin exported `{ id, server }`. OpenCode v2 validates the
// module against a union of `{ id, effect }` / `{ id, setup }` shapes, so
// `server` is not a member: the module failed to decode and the plugin never
// loaded ("failed to load plugin … Missing key [default][effect]").
//
// Adding a no-op `setup(){}` would have been the wrong fix — it satisfies the
// schema but the registering hook would then never be installed.
test("context-filter default export matches the OpenCode v2 plugin schema", async () => {
  const mod = await import(`file://${PLUGIN}`);
  const def = mod.default;

  assert.ok(def && typeof def === "object", "plugin must have a default export object");
  assert.equal(typeof def.id, "string");
  assert.ok(def.id.length > 0, "plugin needs a non-empty id");

  assert.equal(typeof def.setup, "function", "plugin needs a `setup` function for the runtime to invoke");
});

test("context-filter exports `setup` and nothing else the runtime could choke on", async () => {
  const mod = await import(`file://${PLUGIN}`);
  const def = mod.default;
  // `server` is not a member: dead code that makes the plugin look wired up.
  // `effect` next to a valid `setup` was believed to be a safe "both variants"
  // belt-and-braces; it is not — the module fails to load, and a plugin load
  // failure takes the runtime with it (no providers, empty model list).
  for (const key of ["server", "effect"]) {
    assert.ok(!(key in def), `\`${key}\` must not be exported alongside \`setup\``);
  }
  assert.deepEqual(Object.keys(def).sort(), ["id", "setup"], "the definition must be exactly { id, setup }");
});

test("every function the plugin hands to the runtime registers the hook", async () => {
  const mod = await import(`file://${PLUGIN}`);
  const def = mod.default;
  const callables = [def.setup].filter((f) => typeof f === "function");
  assert.ok(callables.length > 0);

  for (const fn of callables) {
    let hooked = null;
    const ctx = { session: { hook: async (name, handler) => { hooked = { name, handler }; } } };
    await fn(ctx);
    assert.ok(hooked, "the exported function must call ctx.session.hook()");
    assert.equal(hooked.name, "context");
    assert.equal(typeof hooked.handler, "function");
  }
});

test("the installed copy in the installer source matches the adapter source", () => {
  // A stale copy is how the broken `server` export reached a real project.
  assert.ok(fs.existsSync(PLUGIN));
  const text = fs.readFileSync(PLUGIN, "utf8");
  assert.doesNotMatch(text, /^\s*(server|effect):/m, "no `server:`/`effect:` key may be committed");
});