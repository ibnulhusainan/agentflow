// Minimal glob matching (supports *, **, ?). Paths use forward slashes.
const SPECIAL = new Set(["+", ".", "^", "$", "(", ")", "{", "}", "|", "[", "]", "\\"]);

export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (SPECIAL.has(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

export function matchesGlob(path, glob) {
  return globToRegExp(glob).test(path);
}

export function matchesAny(path, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  return globs.some((g) => matchesGlob(path, g));
}
