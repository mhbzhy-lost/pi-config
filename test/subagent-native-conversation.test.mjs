import assert from "node:assert/strict";
import * as fs from "node:fs";
import { appendFile, lstat, mkdtemp, mkdir, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti, codingAgent, piTui } = await loadPiTestRuntime(import.meta.url);
const { getMarkdownTheme, initTheme, SessionManager } = codingAgent;
const { Text } = piTui;

initTheme("dark", false);
const native = await jiti.import("../packages/pi-subagents-enhanced/src/tui/native-conversation.ts");

function stripAnsi(value) {
  return value.replace(/\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~])/g, "");
}

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "native-child-conversation-"));
  const sessions = join(root, "sessions");
  const cwd = join(root, "project");
  await Promise.all([mkdir(sessions), mkdir(cwd)]);
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, sessions, cwd };
}

function appendConversation(manager) {
  manager.appendMessage({ role: "user", content: "investigate child state", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [
      { type: "thinking", thinking: "reasoning detail" },
      { type: "text", text: "# Rendered heading" },
      { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "fixture.txt" } },
    ],
    api: "test",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "tool-1",
    toolName: "read",
    content: [{ type: "text", text: "fixture output" }],
    isError: false,
    timestamp: Date.now(),
  });
}

function appendPerformanceConversation(manager) {
  for (let index = 0; index < 60; index += 1) {
    manager.appendMessage({ role: "user", content: `performance user ${index}`, timestamp: Date.now() });
  }
  for (let index = 0; index < 20; index += 1) {
    const toolCallId = `performance-tool-${index}`;
    manager.appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: `performance reasoning ${index}` },
        { type: "text", text: `performance assistant ${index}` },
        { type: "toolCall", id: toolCallId, name: "read", arguments: { path: `performance-${index}.txt` } },
      ],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: "toolResult",
      toolCallId,
      toolName: "read",
      content: [{ type: "text", text: `performance tool output ${index}` }],
      isError: false,
      timestamp: Date.now(),
    });
  }
}

async function waitForFingerprintChange(sessionFile, previousFingerprint) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const stat = await lstat(sessionFile);
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (fingerprint !== previousFingerprint) return fingerprint;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("session append did not flush a new fingerprint");
}

function render(renderer, sessionFile, sessions, cwd, overrides = {}) {
  return renderer.render({
    sessionFile,
    trustedRoots: [sessions],
    width: 80,
    cwd,
    markdownTheme: getMarkdownTheme(),
    ui: { requestRender() {} },
    expandedTools: false,
    hideThinking: false,
    outputPad: 1,
    ...overrides,
  });
}

test("uses the parent tool definition renderer without mutating child tool arguments or results", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  appendConversation(manager);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);

  const observed = { names: [], args: [], results: [] };
  const renderer = new native.NativeChildConversationRenderer({
    resolveToolRenderer(name) {
      observed.names.push(name);
      if (name !== "read") return undefined;
      return {
        renderCall(args) {
          observed.args.push(args);
          return new Text(`parent read: ${args.path}`, 0, 0);
        },
        renderResult(result, options) {
          observed.results.push(result);
          return new Text(options.expanded ? `parent expanded: ${result.content[0].text}` : "parent collapsed", 0, 0);
        },
      };
    },
  });
  const collapsed = stripAnsi(render(renderer, sessionFile, sessions, cwd).lines.join("\n"));
  assert.match(collapsed, /parent read: fixture\.txt/);
  assert.match(collapsed, /parent collapsed/);
  assert.doesNotMatch(collapsed, /fixture output/);

  const expanded = stripAnsi(render(renderer, sessionFile, sessions, cwd, { expandedTools: true }).lines.join("\n"));
  assert.match(expanded, /parent expanded: fixture output/);
  assert.deepEqual(observed.names, ["read", "read"]);
  for (const args of observed.args) assert.deepEqual(args, { path: "fixture.txt" });
  for (const result of observed.results) {
    assert.deepEqual(result.content, [{ type: "text", text: "fixture output" }]);
  }
});

test("renders a real SessionManager conversation with native user, assistant, and tool components", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  appendConversation(manager);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);

  const result = render(new native.NativeChildConversationRenderer(), sessionFile, sessions, cwd, { expandedTools: true });
  const plain = stripAnsi(result.lines.join("\n"));
  assert.match(plain, /investigate child state/);
  assert.match(plain, /reasoning detail/);
  assert.match(plain, /Rendered heading/);
  assert.match(plain, /read/);
  assert.match(plain, /fixture output/);
  assert.doesNotMatch(plain, /◆ Assistant|◇ Supervisor|├─/);
});

test("uses compaction-aware context entries and renders planned session entry types", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  const userId = manager.appendMessage({ role: "user", content: "before compaction", timestamp: Date.now() });
  manager.appendCompaction("compaction summary", userId, 42);
  manager.appendCustomEntry("custom-entry", { value: "custom entry" });
  manager.branchWithSummary(manager.getLeafId(), "branch summary");
  manager.appendMessage({ role: "bashExecution", command: "printf bash output", output: "bash output", exitCode: 0, timestamp: Date.now() });
  manager.appendMessage({ role: "user", content: "<skill name=\"test-driven-development\">skill body</skill>", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "flush" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const result = render(new native.NativeChildConversationRenderer(), sessionFile, sessions, cwd, { expandedTools: true });
  assert.equal(result.warning, undefined, result.warning);
  const plain = stripAnsi(result.lines.join("\n"));
  assert.match(plain, /compaction summary/);
  assert.match(plain, /custom entry/);
  assert.match(plain, /branch summary/);
  assert.match(plain, /printf bash output/);
  assert.match(plain, /bash output/);
  assert.match(plain, /test-driven-development/);
});

test("refuses outside roots, final symlinks, and files over the 64 MiB limit", async (t) => {
  const { root, sessions, cwd } = await createFixture(t);
  const renderer = new native.NativeChildConversationRenderer();
  const outside = join(root, "outside.jsonl");
  await writeFile(outside, "secret");
  const linked = join(sessions, "linked.jsonl");
  await symlink(outside, linked);
  const oversized = join(sessions, "oversized.jsonl");
  await writeFile(oversized, Buffer.alloc(64 * 1024 * 1024 + 1));

  for (const file of [outside, linked, oversized]) {
    const result = render(renderer, file, sessions, cwd);
    assert.ok(result.warning, file);
    assert.deepEqual(result.lines, []);
  }
});

test("accepts an exact 64 MiB session through a private snapshot", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const exact = join(sessions, "exact.jsonl");
  await writeFile(exact, "");
  await truncate(exact, 64 * 1024 * 1024);
  let openedPath;
  const renderer = new native.NativeChildConversationRenderer({
    openSession(snapshot) {
      openedPath = snapshot;
      return { buildContextEntries: () => [] };
    },
  });

  const result = render(renderer, exact, sessions, cwd);
  assert.equal(result.warning, undefined, result.warning);
  assert.notEqual(openedPath, exact);
  await assert.rejects(lstat(openedPath), /ENOENT/);
});

test("fails closed when a checked session path is replaced after open", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const sessionFile = join(sessions, "race.jsonl");
  await writeFile(sessionFile, "approved");
  const replacement = join(sessions, "replacement.jsonl");
  await writeFile(replacement, "injected");
  let parsed;
  let replaced = false;
  const renderer = new native.NativeChildConversationRenderer({
    afterOpen() {
      replaced = true;
      fs.renameSync(replacement, sessionFile);
    },
    openSession(snapshot) {
      parsed = fs.readFileSync(snapshot, "utf8");
      return { buildContextEntries: () => [] };
    },
  });

  const result = render(renderer, sessionFile, sessions, cwd);
  assert.equal(replaced, true, "replacement hook must execute");
  assert.ok(result.warning);
  assert.notEqual(parsed, "injected");
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name.startsWith("native-child-session-")), []);
});

test("ignores missing root candidates but requires an existing trusted root", async (t) => {
  const { root, sessions, cwd } = await createFixture(t);
  const sessionFile = join(sessions, "root.jsonl");
  await writeFile(sessionFile, "root fixture");
  const result = new native.NativeChildConversationRenderer({ openSession: () => ({ buildContextEntries: () => [] }) }).render({
    sessionFile, trustedRoots: [join(root, "missing"), sessions], width: 80, cwd,
    markdownTheme: getMarkdownTheme(), ui: { requestRender() {} }, expandedTools: false, hideThinking: false, outputPad: 1,
  });
  assert.equal(result.warning, undefined, result.warning);
  assert.ok(new native.NativeChildConversationRenderer({ openSession: () => ({ buildContextEntries: () => [] }) }).render({
    sessionFile, trustedRoots: [join(root, "missing")], width: 80, cwd,
    markdownTheme: getMarkdownTheme(), ui: { requestRender() {} }, expandedTools: false, hideThinking: false, outputPad: 1,
  }).warning);
});

test("uses object theme identity and cwd in bounded render variants", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const sessionFile = join(sessions, "cache.jsonl");
  await writeFile(sessionFile, "cache");
  const renderer = new native.NativeChildConversationRenderer({ openSession: () => ({ buildContextEntries: () => [] }) });
  const base = { sessionFile, trustedRoots: [sessions], width: 80, cwd, ui: { requestRender() {} }, expandedTools: false, hideThinking: false, outputPad: 1 };
  renderer.render({ ...base, markdownTheme: {} });
  renderer.render({ ...base, markdownTheme: {} });
  renderer.render({ ...base, cwd: join(cwd, "other"), markdownTheme: {} });
  for (let width = 1; width <= 20; width += 1) renderer.render({ ...base, width, markdownTheme: {} });
  assert.equal(renderer.rendered.size, 16);
});

test("renders flushed messages while ignoring an untrusted partial trailing JSON line", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  manager.appendMessage({ role: "user", content: "complete message", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "flush" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await appendFile(sessionFile, '{"type":"message","content":"untrusted partial content"');

  const result = render(new native.NativeChildConversationRenderer(), sessionFile, sessions, cwd);
  assert.equal(result.warning, undefined, result.warning);
  const plain = stripAnsi(result.lines.join("\n"));
  assert.match(plain, /complete message/);
  assert.doesNotMatch(plain, /untrusted partial content/);
});

test("renders a complete final session record without a trailing newline", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  manager.appendMessage({ role: "user", content: "before final record", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "complete final record" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const { size } = await lstat(sessionFile);
  await truncate(sessionFile, size - 1);

  const result = render(new native.NativeChildConversationRenderer(), sessionFile, sessions, cwd);
  assert.equal(result.warning, undefined, result.warning);
  assert.match(stripAnsi(result.lines.join("\n")), /complete final record/);
});

test("caches by fingerprint and render options, reloads after append, and supports invalidation", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  manager.appendMessage({ role: "user", content: "cache fixture", timestamp: Date.now() });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "flush" }], api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, stopReason: "stop", timestamp: Date.now() });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  let opens = 0;
  let snapshots = 0;
  const renderer = new native.NativeChildConversationRenderer({
    openSession(path) {
      opens += 1;
      return SessionManager.open(path);
    },
    onSnapshot() { snapshots += 1; },
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  const first = render(renderer, sessionFile, sessions, cwd);
  const second = render(renderer, sessionFile, sessions, cwd);
  assert.deepEqual(second.lines, first.lines);
  assert.equal(opens, 1);
  assert.equal(snapshots, 1, "a rendered cache hit must not materialize another snapshot");
  render(renderer, sessionFile, sessions, cwd, { width: 40 });
  render(renderer, sessionFile, sessions, cwd, { expandedTools: true });
  assert.equal(opens, 1, "option changes re-render cached context without reopening unchanged sessions");
  assert.equal(snapshots, 1, "same-fingerprint render variants must not materialize snapshots");

  await appendFile(sessionFile, "\n");
  await new Promise((resolve) => setTimeout(resolve, 5));
  render(renderer, sessionFile, sessions, cwd);
  assert.equal(opens, 2);
  assert.equal(snapshots, 2);
  renderer.invalidate();
  render(renderer, sessionFile, sessions, cwd);
  assert.equal(opens, 3);
  assert.equal(snapshots, 3);
  assert.equal((await lstat(sessionFile)).isFile(), true);
});

test("renders 100 unchanged native cache hits below 100ms and reloads once after a flushed append", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const manager = SessionManager.create(cwd, sessions);
  appendPerformanceConversation(manager);
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  await new Promise((resolve) => setTimeout(resolve, 100));

  let opens = 0;
  let snapshots = 0;
  const renderer = new native.NativeChildConversationRenderer({
    openSession(path) {
      opens += 1;
      return SessionManager.open(path);
    },
    onSnapshot() { snapshots += 1; },
  });
  const options = {
    sessionFile,
    trustedRoots: [sessions],
    width: 80,
    cwd,
    markdownTheme: getMarkdownTheme(),
    ui: { requestRender() {} },
    expandedTools: false,
    hideThinking: false,
    outputPad: 1,
  };

  renderer.render(options);
  assert.equal(opens, 1, "warm render must open the session exactly once");
  assert.equal(snapshots, 1, "warm render must materialize the snapshot exactly once");

  const startedAt = performance.now();
  for (let index = 0; index < 100; index += 1) renderer.render(options);
  const elapsedMs = performance.now() - startedAt;
  assert.ok(elapsedMs < 100, `100 unchanged-fingerprint cache-hit renders took ${elapsedMs.toFixed(3)}ms`);
  assert.equal(opens, 1, "measured cache hits must not reopen the session");
  assert.equal(snapshots, 1, "measured cache hits must not materialize another snapshot");

  const beforeAppend = await lstat(sessionFile);
  const previousFingerprint = `${beforeAppend.dev}:${beforeAppend.ino}:${beforeAppend.size}:${beforeAppend.mtimeMs}`;
  manager.appendMessage({ role: "user", content: "performance append", timestamp: Date.now() });
  await waitForFingerprintChange(sessionFile, previousFingerprint);
  renderer.render(options);
  assert.equal(opens, 2, "one flushed append must cause exactly one additional session open");
  assert.equal(snapshots, 2, "one flushed append must cause exactly one additional snapshot materialization");
});

test("does not interrupt a completed tool when a later assistant aborts", async (t) => {
  const { sessions, cwd } = await createFixture(t);
  const updates = [];
  const renderer = new native.NativeChildConversationRenderer({ onToolResult: (item) => updates.push(item) });
  const assistant = (id, stopReason) => ({
    role: "assistant",
    content: [{ type: "text", text: `assistant ${id}` }, { type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }],
    api: "test", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    stopReason, timestamp: Date.now(),
  });
  const plain = stripAnsi(renderer.renderItems([
    assistant("completed-tool", "toolUse"),
    { role: "toolResult", toolCallId: "completed-tool", toolName: "read", content: [{ type: "text", text: "earlier success" }], isError: false, timestamp: Date.now() },
    assistant("pending-tool", "aborted"),
  ], {
    sessionFile: join(sessions, "unused.jsonl"), trustedRoots: [sessions], width: 80, cwd,
    markdownTheme: getMarkdownTheme(), ui: { requestRender() {} }, expandedTools: true, hideThinking: false, outputPad: 1,
  }).join("\n"));
  assert.deepEqual(updates.map((item) => [item.toolCallId, item.isError]), [
    ["completed-tool", false],
    ["pending-tool", true],
  ]);
  assert.match(plain, /Tool execution interrupted/);
  assert.equal((plain.match(/Tool execution interrupted/g) ?? []).length, 1);
});
