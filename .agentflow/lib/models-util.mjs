// Generic YAML frontmatter utilities for platform-agnostic file edits.
// Deliberately minimal: it only sets one top-level scalar key (e.g. `model:`)
// inside a `---`-delimited frontmatter block, creating the block when absent.
// It is not a YAML parser and does not touch the document body.
import { readText, writeTextAtomic } from "./fsutil.mjs";

const DELIM = "---";

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Quote a scalar only when it needs it; model ids are plain strings.
function formatValue(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function setFrontmatterKey(filePath, key, value) {
  const content = readText(filePath);
  if (content === null) return { ok: false, error: "missing" };
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return { ok: false, error: `invalid key: ${key}` };

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const line = `${key}: ${formatValue(value)}`;
  const keyRegex = new RegExp(`^\\s*${escapeRegex(key)}\\s*:`);

  if (lines.length > 0 && lines[0].trim() === DELIM) {
    let closeIndex = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === DELIM) {
        closeIndex = i;
        break;
      }
    }
    if (closeIndex === -1) {
      // Unterminated frontmatter: append the key and close the block.
      lines.push(line, DELIM);
    } else {
      let found = false;
      for (let i = 1; i < closeIndex; i++) {
        if (keyRegex.test(lines[i])) {
          lines[i] = line;
          found = true;
          break;
        }
      }
      if (!found) lines.splice(closeIndex, 0, line);
    }
  } else {
    // No frontmatter: prepend a fresh block.
    lines.unshift(DELIM, line, DELIM);
  }

  writeTextAtomic(filePath, lines.join(eol));
  return { ok: true };
}
