// Concise output for humans and adapters. `--json` emits stable machine-readable
// JSON; the default is a short human summary.
export function jsonLine(data) {
  return JSON.stringify(data, null, 2);
}

export function human(data) {
  if (data == null) return "";
  if (Array.isArray(data.entries) && data.summary) {
    const lines = data.entries.map((e) => `${pad(e.status)} ${e.id}  (${e.path})`);
    lines.push(
      `summary: fresh=${data.summary.fresh || 0} stale=${data.summary.stale || 0} missing=${data.summary.missing || 0} incomplete=${data.summary.incomplete || 0} invalid=${data.summary.invalid || 0}`,
    );
    return lines.join("\n");
  }
  if (Array.isArray(data.reasons) && data.reasons.length) {
    return [data.ok ? "OK" : `FAILED (${data.reasons.length})`, ...data.reasons.map((r) => `- ${r}`)].join("\n");
  }
  if (Array.isArray(data.errors) && data.errors.length) {
    return [`INVALID (${data.errors.length} errors)`, ...data.errors.map((e) => `- ${e}`)].join("\n");
  }
  if (typeof data === "object") return jsonLine(data);
  return String(data);
}

function pad(s) {
  return String(s).padEnd(10);
}

export function emit(data, asJson) {
  process.stdout.write((asJson ? jsonLine(data) : human(data)) + "\n");
}
