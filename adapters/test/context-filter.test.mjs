import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planTrim, applyTrim, readConfig, makeContextHook, messageChars, placeholder } from "../opencode/plugins/context-filter.js";

const BIG = "Y".repeat(9000);

function tmpLog() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ctx-filter-")), "log.jsonl");
}

// Log lines are `<ISO timestamp> <json>`; strip the timestamp before parsing.
function lastLog(logPath) {
  const line = fs.readFileSync(logPath, "utf8").trim().split("\n").pop();
  return JSON.parse(line.slice(line.indexOf("{")));
}

// Two turns: turn 0 holds an oversized tool result, turn 1 is the active one.
function fixture() {
  return {
    messages: [
      { role: "user", content: [{ type: "text", text: "task brief" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reading" },
          { type: "tool-call", toolCallId: "c1", toolName: "read", input: { path: "a.js" } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: BIG }] },
      { role: "user", content: [{ type: "text", text: "next: do X" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ],
  };
}

test("readConfig: defaults, modes, invalid fallback", () => {
  assert.equal(readConfig({}).mode, "dry");
  assert.equal(readConfig({}).keepTurns, 3);
  assert.equal(readConfig({ OPENCODE_CTX_FILTER: "ON" }).mode, "on");
  assert.equal(readConfig({ OPENCODE_CTX_FILTER: "nonsense" }).mode, "dry");
  assert.equal(readConfig({ OPENCODE_CTX_FILTER: "off" }).mode, "off");
  assert.equal(readConfig({ OPENCODE_CTX_KEEP_TURNS: "2" }).keepTurns, 2);
  assert.equal(readConfig({ OPENCODE_CTX_KEEP_TURNS: "-1" }).keepTurns, 3);
  assert.equal(readConfig({ OPENCODE_CTX_KEEP_TURNS: "abc" }).keepTurns, 3);
  assert.equal(readConfig({ OPENCODE_CTX_DROP_TURNS: "on" }).dropTurns, true);
  assert.equal(readConfig({}).dropTurns, false);
});

test("planTrim: keeps the newest turn(s) intact and plans only older payloads", () => {
  const { messages } = fixture();
  const { actions, stats } = planTrim(messages, { keepTurns: 1, maxChars: 4000 });
  assert.equal(stats.keepFrom, 3);
  assert.equal(actions.length, 1);
  const a = actions[0];
  assert.equal(a.kind, "trim_part");
  assert.equal(a.messageIndex, 2);
  assert.equal(a.partIndex, 0);
  assert.equal(a.field, "output");
  assert.ok(a.chars >= BIG.length);
  assert.ok(stats.savedChars > 0);
  // Newest turn (index 3+) is untouched.
  assert.ok(actions.every((x) => x.messageIndex < 3));
});

test("planTrim: respects maxChars and leaves small payloads alone", () => {
  const { messages } = fixture();
  const { actions } = planTrim(messages, { keepTurns: 1, maxChars: 100000 });
  assert.equal(actions.length, 0);
});

test("planTrim: only trims at turn boundaries (stable between user turns)", () => {
  const { messages } = fixture();
  const cfg = { keepTurns: 1, maxChars: 4000 };
  const before = planTrim(messages, cfg).actions;
  // Tool-driven continuations append assistant/tool messages without a new user
  // turn: the plan for the older region must not change.
  messages.push({ role: "assistant", content: [{ type: "text", text: "more" }] });
  messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: "c2", output: "z".repeat(50) }] });
  const after = planTrim(messages, cfg).actions;
  assert.deepEqual(after, before);
});

test("applyTrim: replaces payloads without removing parts (tool pairing preserved)", () => {
  const { messages } = fixture();
  const { actions } = planTrim(messages, { keepTurns: 1, maxChars: 4000 });
  const countsBefore = messages.map((m) => (Array.isArray(m.content) ? m.content.length : -1));
  applyTrim(messages, actions);

  assert.equal(messages[2].content[0].output, actions[0].placeholder);
  assert.equal(messages[2].content[0].toolCallId, "c1"); // pairing identity kept
  assert.deepEqual(messages.map((m) => (Array.isArray(m.content) ? m.content.length : -1)), countsBefore);
  assert.equal(messages.length, 5);
});

test("applyTrim: trims prose parts and array-of-text payloads", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "brief" }] },
    { role: "assistant", content: [{ type: "reasoning", text: "r".repeat(6000) }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: "c9", content: [{ type: "text", text: "t".repeat(6000) }] }] },
    { role: "user", content: [{ type: "text", text: "now" }] },
  ];
  const { actions } = planTrim(messages, { keepTurns: 1, maxChars: 1000 });
  assert.equal(actions.length, 2);
  applyTrim(messages, actions);
  assert.match(messages[1].content[0].text, /context-filter/);
  assert.match(messages[2].content[0].content[0].text, /context-filter/);
  assert.equal(messages[2].content[0].toolCallId, "c9");
});

test("planTrim: dropTurns removes whole old turns but never the first (task brief)", () => {
  const mk = (i) => [
    { role: "user", content: [{ type: "text", text: `turn ${i}` }] },
    { role: "assistant", content: [{ type: "text", text: `a${i}` }] },
    { role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, output: "x".repeat(20) }] },
  ];
  const messages = [...mk(0), ...mk(1), ...mk(2), ...mk(3)];
  const { actions } = planTrim(messages, { keepTurns: 1, maxChars: 4000, dropTurns: true });
  const drops = actions.filter((a) => a.kind === "drop_message").map((a) => a.messageIndex);
  assert.ok(drops.length > 0);
  assert.ok(!drops.includes(0)); // first turn = task brief, always kept
  assert.ok(drops.every((i) => i >= 3)); // turn 0 occupies 0..2
  applyTrim(messages, actions);
  assert.equal(messages[0].role, "user");
  assert.ok(messages.length < 12);
});

test("messageChars: defensive on odd shapes", () => {
  assert.equal(messageChars(null), 0);
  assert.equal(messageChars({}), 0);
  assert.equal(messageChars({ content: "abc" }), 3);
  assert.equal(messageChars({ content: [{ type: "text", text: "abcd" }] }), 4);
  assert.equal(messageChars({ content: [{ type: "tool-call", input: { a: 1 } }] }), 0);
});

test("hook: dry mode logs but never mutates", () => {
  const logPath = tmpLog();
  const { messages } = fixture();
  const snapshot = JSON.stringify(messages);
  makeContextHook({ OPENCODE_CTX_FILTER: "dry", OPENCODE_CTX_KEEP_TURNS: "1", OPENCODE_CTX_LOG: logPath })({
    messages,
    sessionID: "ses_x",
    agent: "executor",
  });
  assert.equal(JSON.stringify(messages), snapshot);
  const logged = lastLog(logPath);
  assert.equal(logged.actions, 1);
  assert.equal(logged.mode, "dry");
});

test("hook: on mode applies the trim and logs savings", () => {
  const logPath = tmpLog();
  const { messages } = fixture();
  makeContextHook({ OPENCODE_CTX_FILTER: "on", OPENCODE_CTX_KEEP_TURNS: "1", OPENCODE_CTX_LOG: logPath })({
    messages,
    sessionID: "ses_x",
  });
  assert.match(messages[2].content[0].output, /context-filter/);
  const logged = lastLog(logPath);
  assert.equal(logged.mode, "on");
  assert.ok(logged.savedChars > 0);
});

test("hook: off mode does nothing at all", () => {
  const logPath = tmpLog();
  const { messages } = fixture();
  makeContextHook({ OPENCODE_CTX_FILTER: "off", OPENCODE_CTX_KEEP_TURNS: "1", OPENCODE_CTX_LOG: logPath })({ messages });
  assert.equal(messages[2].content[0].output, BIG);
  assert.equal(fs.existsSync(logPath), false);
});

test("hook: fail-safe on malformed input and unwritable log", () => {
  const logPath = path.join(tmpLog(), "nested", "log.jsonl");
  const env = { OPENCODE_CTX_FILTER: "on", OPENCODE_CTX_KEEP_TURNS: "1", OPENCODE_CTX_LOG: logPath };
  const hook = makeContextHook(env);
  assert.doesNotThrow(() => hook(undefined));
  assert.doesNotThrow(() => hook({ messages: "not-an-array" }));
  assert.doesNotThrow(() => hook({ messages: [null, 42, { role: "user", content: null }] }));

  // Unwritable log: a regular file as the parent directory makes mkdir fail
  // immediately with ENOTDIR. Portable across platforms — pseudo-filesystems
  // like /proc are not: they can block instead of erroring.
  const notADir = tmpLog(); // .../log.jsonl — created as a regular file below
  fs.writeFileSync(notADir, "x");
  const unwritable = path.join(notADir, "nested", "log.jsonl");
  assert.doesNotThrow(() => makeContextHook({ ...env, OPENCODE_CTX_LOG: unwritable })({ messages: [] }));
});

test("planTrim: maxActions is a safety valve", () => {
  const messages = [];
  for (let t = 0; t < 40; t++) {
    messages.push({ role: "user", content: [{ type: "text", text: `t${t}` }] });
    for (let p = 0; p < 10; p++) {
      messages.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${t}-${p}`, output: "x".repeat(5000) }] });
    }
  }
  const { actions } = planTrim(messages, { keepTurns: 1, maxChars: 1000, maxActions: 25 });
  assert.ok(actions.length <= 25);
});

test("placeholder is short and self-describing", () => {
  const p = placeholder(9000);
  assert.ok(p.length < 200);
  assert.match(p, /context-filter/);
});
