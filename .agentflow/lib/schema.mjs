// Minimal JSON Schema (draft 2020-12 subset) validator. Supports the keywords
// actually used in .agentflow/docs/contracts/schemas/agentflow.schema.json:
// $ref (local), const, enum, type (incl. arrays), required, properties,
// additionalProperties (boolean | schema), items, minItems, minLength,
// maxLength, pattern. This is intentionally small and dependency-free.

export function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

export function matchType(actual, value, want) {
  if (want === "number") return actual === "number" || actual === "integer";
  if (want === "integer") return actual === "integer";
  return actual === want;
}

function resolveRef(ref, root) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  const parts = ref.slice(2).split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = root;
  for (const p of parts) cur = cur?.[p];
  return cur;
}

function validateNode(node, schema, root, pointer, errors) {
  if (!schema) return;
  if (schema.$ref) {
    validateNode(node, resolveRef(schema.$ref, root), root, pointer, errors);
    return;
  }

  if (Object.prototype.hasOwnProperty.call(schema, "const") && node !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(node)) {
    errors.push(`${pointer}: value ${JSON.stringify(node)} not in enum`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = typeOf(node);
    if (!types.some((w) => matchType(actual, node, w))) {
      errors.push(`${pointer}: expected type ${types.join("|")}, got ${actual}`);
      return;
    }
  }

  if (typeof node === "string") {
    if (schema.minLength !== undefined && node.length < schema.minLength) {
      errors.push(`${pointer}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && node.length > schema.maxLength) {
      errors.push(`${pointer}: longer than maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(node)) {
      errors.push(`${pointer}: does not match pattern ${schema.pattern}`);
    }
  }

  if (Array.isArray(node)) {
    if (schema.minItems !== undefined && node.length < schema.minItems) {
      errors.push(`${pointer}: fewer than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      node.forEach((item, i) => validateNode(item, schema.items, root, `${pointer}[${i}]`, errors));
    }
  }

  if (typeOf(node) === "object" && node !== null) {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!(req in node)) errors.push(`${pointer}: missing required "${req}"`);
    }
    for (const [k, v] of Object.entries(node)) {
      if (props[k]) {
        validateNode(v, props[k], root, `${pointer}.${k}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer}: additional property "${k}" not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateNode(v, schema.additionalProperties, root, `${pointer}.${k}`, errors);
      }
    }
  }
}

export function validateDef(instance, root, defName) {
  const errors = [];
  const def = root?.$defs?.[defName];
  if (!def) return [`unknown schema def "${defName}"`];
  validateNode(instance, def, root, "$", errors);
  return errors;
}
