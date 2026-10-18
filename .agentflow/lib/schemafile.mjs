import path from "node:path";
import { exists, readJson } from "./fsutil.mjs";

// Resolve the contract schema. Priority:
//   1. AGENTFLOW_SCHEMA env var
//   2. <root>/.agentflow/docs/contracts/schemas/agentflow.schema.json
//   3. bundled fallback next to the core
export function resolveSchemaPath(root) {
  const env = process.env.AGENTFLOW_SCHEMA;
  const candidates = [
    env,
    path.join(root, ".agentflow/docs/contracts/schemas/agentflow.schema.json"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "schema", "agentflow.schema.json"),
  ].filter(Boolean);
  for (const c of candidates) if (exists(c)) return c;
  return null;
}

export function loadSchema(root) {
  const p = resolveSchemaPath(root);
  if (!p) return { ok: false, error: "schema not found" };
  const r = readJson(p);
  if (!r.ok) return { ok: false, error: `schema ${r.error} at ${p}` };
  return { ok: true, schema: r.value, path: p };
}
