// Minimal JSONC (JSON with Comments + trailing commas) support, no dependencies.
// Removes // and /* */ comments outside of strings, then trailing commas.

export function stripJsonComments(text) {
  let out = "";
  let inStr = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += n ?? "";
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
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
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

export function stripTrailingCommas(text) {
  return text.replace(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}
