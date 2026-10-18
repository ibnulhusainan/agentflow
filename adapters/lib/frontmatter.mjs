// Minimal YAML frontmatter parser for the subset used by platform adapters.
// No dependencies. Supports:
//   - top-level `key: value` scalars (strings, numbers, booleans, null)
//   - nested mappings under `key:` with deeper indentation
//   - lists of scalars (`- value`) and lists of mappings (`- key: value`)
//   - double/single quoted strings, `#` comments outside quotes
// It is deliberately small: adapters only need the fields their platforms
// document. It never evaluates YAML tags, anchors, or multi-line scalars.

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

function tokenize(src) {
  const tokens = [];
  for (const rawLine of src.split(/\r?\n/)) {
    const line = stripComment(rawLine);
    if (line.trim() === "") continue;
    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length;
    tokens.push({ indent, text: line.trim() });
  }
  return tokens;
}

function parseNode(tokens, i, indent) {
  if (i < tokens.length && tokens[i].text.startsWith("- ")) {
    return parseList(tokens, i, indent);
  }
  return parseMap(tokens, i, indent);
}

function parseMap(tokens, i, indent) {
  const obj = {};
  while (i < tokens.length && tokens[i].indent === indent && !tokens[i].text.startsWith("- ")) {
    const text = tokens[i].text;
    const colon = text.indexOf(":");
    if (colon === -1) {
      i++;
      continue;
    }
    // Keys go through parseScalar too: permission maps use quoted glob keys
    // (`"*": deny`, `"node .agentflow/cli.mjs *": allow`) and an unparsed
    // key would keep its quotes, so `permission.task["*"]` would never match.
    const key = parseScalar(text.slice(0, colon).trim());
    const rest = text.slice(colon + 1).trim();
    if (rest === "") {
      if (i + 1 < tokens.length && tokens[i + 1].indent > indent) {
        const child = parseNode(tokens, i + 1, tokens[i + 1].indent);
        obj[key] = child.value;
        i = child.i;
      } else {
        obj[key] = null;
        i++;
      }
    } else {
      obj[key] = parseScalar(rest);
      i++;
    }
  }
  return { value: obj, i };
}

function parseList(tokens, i, indent) {
  const arr = [];
  while (i < tokens.length && tokens[i].indent === indent && tokens[i].text.startsWith("- ")) {
    const first = tokens[i].text.slice(2).trim();
    const itemTokens = first === "" ? [] : [{ indent: indent + 2, text: first }];
    let j = i + 1;
    while (j < tokens.length && tokens[j].indent > indent) {
      itemTokens.push(tokens[j]);
      j++;
    }
    i = j;
    if (itemTokens.length === 0) {
      arr.push(null);
    } else if (itemTokens.length === 1) {
      const t = itemTokens[0];
      // scalar item
      if (t.text.startsWith("- ")) {
        const parsed = parseNode(itemTokens, 0, t.indent);
        arr.push(parsed.value);
      } else if (t.text.indexOf(":") !== -1) {
        const parsed = parseNode(itemTokens, 0, t.indent);
        arr.push(parsed.value);
      } else {
        arr.push(parseScalar(t.text));
      }
    } else {
      // multi-line item: mapping/list under it
      const parsed = parseNode(itemTokens, 0, itemTokens[0].indent);
      arr.push(parsed.value);
    }
  }
  return { value: arr, i };
}

export function parseYamlSubset(src) {
  const tokens = tokenize(src);
  if (tokens.length === 0) return {};
  const parsed = parseNode(tokens, 0, tokens[0].indent);
  return parsed.value;
}

// Splits a Markdown document into its YAML frontmatter and body.
// Returns { data, body }. Throws if there is no leading `---` block.
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error("missing YAML frontmatter");
  return { data: parseYamlSubset(match[1]), body: match[2] ?? "" };
}
