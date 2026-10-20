// agentflow web viewer (read-only). Launched via: node .agentflow/cli.mjs serve
// or (if wrapper installed): agentflow serve
//
// Viewer only: it reads state and shells out to the core CLI for data. It never
// writes to .agent/ or runs mutating commands.

import http from "node:http";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const PREFERRED_PORTS = [3773, 3737, 3377, 7337, 7373, 7733];

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port" || a === "-p") { flags.port = Number(argv[++i]); }
    else if (a === "--root") { flags.root = argv[++i]; }
    else if (a === "--host") { flags.host = argv[++i]; }
  }
  return flags;
}

export function runServe(root, flags = {}) {
  const cli = path.join(root, ".agentflow", "cli.mjs");
  const host = flags.host || "127.0.0.1";

  function runCli(args) {
    const r = spawnSync(process.execPath, [cli, ...args, "--json"], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
    if (r.error) return { ok: false, error: String(r.error.message || r.error) };
    const out = (r.stdout || "").trim();
    if (!out) return { ok: false, error: r.stderr || "no output" };
    try {
      return JSON.parse(out);
    } catch {
      return { ok: false, error: "invalid json: " + out.slice(0, 200) };
    }
  }

  const routes = {
    "/api/status": () => runCli(["status"]),
    "/api/tasks": () => runCli(["task", "list"]),
    "/api/models": () => {
      // read files directly for speed
      const cfg = safeReadJson(path.join(root, ".agent", "models.json"));
      const st = safeReadJson(path.join(root, ".agent", "models.state.json"));
      return { ok: true, config: cfg, state: st };
    },
    "/api/knowledge": () => safeReadJson(path.join(root, ".agent", "knowledge", "index.json")),
    "/api/config": () => safeReadJson(path.join(root, ".agent", "config.json")),
  };

  function safeReadJson(p) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      return { ok: false, error: String(e.message || e), path: p };
    }
  }

  function send(res, status, body, type = "application/json") {
    res.writeHead(status, {
      "Content-Type": type + "; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    if (pathname === "/" || pathname === "/index.html") {
      return send(res, 200, HTML, "text/html");
    }

    if (pathname === "/api/file") {
      const rel = url.searchParams.get("path") || "";
      // restrict to .agent/ for safety
      const normalized = path.normalize(rel).replace(/^\/+/, "");
      if (!normalized.startsWith(".agent/") && !normalized.startsWith(".agent\\\\")) {
        return send(res, 403, { ok: false, error: "path not allowed" });
      }
      const full = path.join(root, normalized);
      if (!fs.existsSync(full)) return send(res, 404, { ok: false, error: "not found" });
      try {
        const content = fs.readFileSync(full, "utf8");
        return send(res, 200, { ok: true, path: normalized, content });
      } catch (e) {
        return send(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    if (pathname.startsWith("/api/task/")) {
      const id = decodeURIComponent(pathname.slice("/api/task/".length));
      if (!id) return send(res, 400, { ok: false, error: "missing id" });
      const ctx = runCli(["context", "--task", id]);
      // attach full plan/progress items for the viewer
      try {
        const plan = safeReadJson(path.join(root, ".agent", "tasks", id, "plan.json"));
        const prog = safeReadJson(path.join(root, ".agent", "tasks", id, "progress.json"));
        const progItems = (prog && prog.items) || {};
        if (plan && Array.isArray(plan.items)) {
          ctx.items = plan.items.map((it) => {
            const p = progItems[it.id] || {};
            return {
              id: it.id,
              title: it.title,
              description: it.description || "",
              status: p.status || it.status || "todo",
              paths: it.paths || [],
              depends_on: it.depends_on || [],
              completion_criterion: it.completion_criterion || "",
              knowledge_refs: it.knowledge_refs || [],
            };
          });
        }
      } catch (e) {
        ctx.items = [];
      }
      return send(res, 200, ctx);
    }

    if (routes[pathname]) {
      return send(res, 200, routes[pathname]());
    }

    // history = completed tasks sorted desc
    if (pathname === "/api/history") {
      const list = runCli(["task", "list"]);
      const tasks = Array.isArray(list.tasks) ? list.tasks : (Array.isArray(list) ? list : []);
      const completed = tasks
        .filter((t) => t && t.status === "completed")
        .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
      return send(res, 200, { ok: true, tasks: completed });
    }

    send(res, 404, { ok: false, error: "not found" });
  });

  function tryListen(ports, idx = 0) {
    if (idx >= ports.length) {
      // random fallback
      const randomPort = 10000 + Math.floor(Math.random() * 50000);
      ports = [randomPort];
      idx = 0;
    }
    const port = ports[idx];
    const onError = (err) => {
      server.removeListener("listening", onListening);
      if (err && err.code === "EADDRINUSE") {
        tryListen(ports, idx + 1);
      } else {
        console.error("serve failed:", err);
        process.exit(1);
      }
    };
    const onListening = () => {
      server.removeListener("error", onError);
      console.log(`agentflow serve: http://${host}:${port}`);
      console.log("read-only viewer. Ctrl+C to stop.");
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  }

  const requested = flags.port ? [flags.port] : PREFERRED_PORTS;
  tryListen(requested);
  return server;
}

const HTML_PATH = new URL("./serve.html", import.meta.url);
function loadHtml() {
  try { return fs.readFileSync(HTML_PATH, "utf8"); }
  catch (e) { return "<pre>serve.html missing: " + String(e.message||e) + "</pre>"; }
}
const HTML = loadHtml();

if (import.meta.url === `file://${process.argv[1]}`) {
  // allow running directly
  const flags = parseArgs(process.argv.slice(2));
  const root = flags.root || process.cwd();
  runServe(root, flags);
}

// Export for CLI
export { runServe as default };
