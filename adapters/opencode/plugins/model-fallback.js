// OpenCode v2 adapter: automatic model fallback on provider failure (opt-in).
//
// Retries a provider failure up to AGENTFLOW_FALLBACK_RETRIES times (default 2),
// then advances the role's model chain via `agentflow models next` + `models apply`
// and retries once more on the new model. Rate limits (HTTP 429 / quota) skip the
// retry budget and switch immediately.
//
// This is an OpenCode-only, opt-in plugin. It is OFF by default; enable with
// AGENTFLOW_AUTO_FALLBACK=on. It never runs for Cursor (no equivalent hook).
//
// Env:
//   AGENTFLOW_AUTO_FALLBACK=on|off        (default off)
//   AGENTFLOW_FALLBACK_RETRIES=<n>        (default 2)
//   AGENTFLOW_FALLBACK_LOG=<path>         (default /tmp/opencode/model-fallback.log)
//
// Copy to `.opencode/plugins/model-fallback.js` (auto-discovered by OpenCode v2).

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

const DEFAULTS = {
  enabled: false,
  retries: 2,
  logPath: "/tmp/opencode/model-fallback.log",
};

function readConfig(env = process.env) {
  const n = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) && x >= 0 ? Math.floor(x) : d;
  };
  return {
    enabled: String(env.AGENTFLOW_AUTO_FALLBACK || "").toLowerCase() === "on",
    retries: n(env.AGENTFLOW_FALLBACK_RETRIES, DEFAULTS.retries),
    logPath: env.AGENTFLOW_FALLBACK_LOG || DEFAULTS.logPath,
  };
}

function log(cfg, obj) {
  try {
    mkdirSync(dirname(cfg.logPath), { recursive: true });
    appendFileSync(cfg.logPath, JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
  } catch {
    // never throw from logging
  }
}

function isRateLimit(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || "").toLowerCase();
  return status === 429 || msg.includes("rate limit") || msg.includes("quota") || msg.includes("too many requests");
}

function isTimeout(err) {
  const status = err && err.status;
  const msg = String((err && err.message) || "").toLowerCase();
  return msg.includes("timed out") || msg.includes("timeout") || status === 408 || status === 504;
}

function readModelFromAgentFile(root, agent) {
  try {
    const content = readFileSync(join(root, ".opencode", "agents", `${agent}.md`), "utf8");
    const m = content.match(/^model:\s*(.+)$/m);
    if (!m) return null;
    const s = m[1].trim();
    const slash = s.indexOf("/");
    if (slash <= 0) return null;
    return { providerID: s.slice(0, slash), id: s.slice(slash + 1) };
  } catch {
    return null;
  }
}

export const ModelFallbackPlugin = async (ctx) => {
  const cfg = readConfig();
  if (!cfg.enabled) {
    log(cfg, { plugin: "agentflow.model-fallback", status: "disabled" });
    return;
  }

  const root = (ctx && ctx.location && ctx.location.directory) || process.cwd();
  const cli = join(root, ".agentflow", "cli.mjs");

  await ctx.session.hook("retry", async (event) => {
    const agent = event.agent;
    const err = event.error || {};
    const attempt = event.attempt || 1;

    const rateLimit = isRateLimit(err);
    const timeout = isTimeout(err);

    // Decide whether to switch model.
    let shouldSwitch = false;
    let reason = "";
    if (rateLimit) {
      shouldSwitch = true;
      reason = "rate limit";
    } else if (timeout && attempt > cfg.retries) {
      // retries exhausted (initial + N retries)
      shouldSwitch = true;
      reason = `timeout after ${attempt} attempts`;
    }

    if (!shouldSwitch) {
      // let OpenCode's default retry policy handle it
      return;
    }

    // Switch model via agentflow CLI.
    try {
      execSync(`node ${JSON.stringify(cli)} models next --role ${agent} --reason ${JSON.stringify(reason)} --root ${JSON.stringify(root)}`, {
        stdio: "ignore",
      });
      execSync(`node ${JSON.stringify(cli)} models apply --root ${JSON.stringify(root)}`, {
        stdio: "ignore",
      });
      const model = readModelFromAgentFile(root, agent);
      if (model) {
        await ctx.session.switchModel({ sessionID: event.sessionID, model });
      }
      log(cfg, { plugin: "agentflow.model-fallback", action: "switched", agent, attempt, reason, model });
      // retry once on the new model
      event.decision = { retry: true, delay: 0 };
    } catch (e) {
      log(cfg, { plugin: "agentflow.model-fallback", action: "switch-failed", agent, attempt, error: String(e && e.message ? e.message : e) });
      event.decision = { retry: false };
    }
  });

  log(cfg, { plugin: "agentflow.model-fallback", status: "enabled", retries: cfg.retries });
};

export default {
  id: "agentflow.model-fallback",
  setup: ModelFallbackPlugin,
};
