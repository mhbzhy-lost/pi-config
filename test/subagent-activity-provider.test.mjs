// 统一执行计划 F2b / footer 子计划 T2b 验收：subagent activity provider。
//
// 本文件是显示/事件 fixture 验证（F0 记录 docs/plans/records/2026-10-13-background-
// activity-ownership.md §10 冻结的正反例；fixture 明确为显示/事件输入，不充当
// production 数据来源证明）：
//   - 当前 session started/complete 的 sessionFile 与 UUID 双形态均接受；
//   - 异 session、缺失/空/非 string sessionId、伪造 generation 字段一律不获通过；
//   - same-session reload：roster 保留、原 run 的 complete 继续接收（不被虚构
//     generation 拦截）、旧闭包/旧 source 失效；
//   - plain roster 按 (manager, 逻辑 sessionID) 分区：new/fork 与同 ID 异 manager
//     不继承他人 roster，进程内跨 reload 保留，分区只延续 plain rows；
//   - F2b-v：SDK reload 模块重求值（jiti moduleCache:false + clearExtensionCache）
//     后的新 factory 同 manager/session 分区保留（Symbol 槽容器）、旧回调释放，
//     同一模块重复 session_start 不冒充该证据；
//   - snapshot 纯投影（active→main、terminal→recent）、root/leaf 折叠不重复、
//     unknown/reported 不显示为已完成、recent 历史沿用 browser 的 20 条上限；
//   - detail 走 package trusted native 优先渲染（native 先于 Fleet 回退），根层
//     只获得组件投影。
// 不启动真实 subagent/Host，不发模型消息，不触碰真实 session 正文；共享 bus 多
// Host 不作为成功用例（unsupported 边界，F0 §9）；不使用 TDD。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti, codingAgent, piTui } = await loadPiTestRuntime(import.meta.url);
const { SessionManager, getMarkdownTheme, initTheme } = codingAgent;

initTheme("dark", false);

const footerRuntime = await jiti.import("../packages/pi-subagents-enhanced/src/tui/footer-runtime.ts");
const subagentActivity = await jiti.import("../packages/pi-subagents-enhanced/src/tui/subagent-activity.ts");
const { SubagentSessionBrowserState } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/session-browser.ts");
const { readBrowserRunStatus } = await jiti.import("../packages/pi-subagents-enhanced/src/tui/browser-adapter.ts");
const { getTitleRegistry } = await jiti.import("../packages/pi-subagents-enhanced/src/subagent-dispatch/title-registry.ts");

const FOOTER_TUI = {
  Key: piTui.Key,
  isKeyRelease: piTui.isKeyRelease,
  isKeyRepeat: piTui.isKeyRepeat,
  matchesKey: piTui.matchesKey,
  truncateToWidth: piTui.truncateToWidth,
  visibleWidth: piTui.visibleWidth,
};

const SESSION_FILE = "/sessions/parent-session.jsonl";
const SESSION_UUID = "0e2ea6d2-9f2f-4a1c-8b70-6f1f2f3f4f5f";
const OTHER_FILE = "/sessions/another-session.jsonl";
const OTHER_UUID = "99999999-9999-4999-8999-999999999999";

function registerHandler(map, name, handler) {
  const handlers = map.get(name) ?? [];
  handlers.push(handler);
  map.set(name, handlers);
  return () => map.delete(name);
}

// runtime harness：fake pi/ctx/ui + 带 session 身份的 manager（getSessionFile 返回
// sessionFile、getSessionId 返回 UUID），事件可经捕获的 pi.events handler 驱动。
// options.runtimeModule：用重求值的 footer-runtime 模块实例驱动（F2b-v 模块重载
// 回归）；options.patchTimers:false 供同测试内叠加第二个 harness 复用外层 timer
// patch，避免 restore 顺序把假 setInterval 泄漏给后续测试。
function createHarness(options = {}) {
  const handlers = new Map();
  const events = new Map();
  const timers = [];
  const footers = [];
  const shortcuts = [];
  const patchTimers = options.patchTimers !== false;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  if (patchTimers) {
    globalThis.setInterval = (callback) => {
      const timer = { callback, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      timers.push(timer);
      return timer;
    };
    globalThis.clearInterval = () => {};
  }
  const sessionFile = options.sessionFile ?? SESSION_FILE;
  const sessionId = options.sessionId ?? SESSION_UUID;
  const manager = options.manager ?? {
    getSessionFile: () => sessionFile,
    getSessionId: () => sessionId,
  };
  const pi = {
    on: (name, handler) => registerHandler(handlers, name, handler),
    events: { on: (name, handler) => registerHandler(events, name, handler) },
    getThinkingLevel: () => "high",
    getAllTools() { throw new Error("ToolInfo must not be consumed as renderer"); },
    registerShortcut(_key, definition) { shortcuts.push(definition); },
  };
  const runtimeModule = options.runtimeModule ?? footerRuntime;
  const runtime = runtimeModule.createFooterRuntime(pi, { getMarkdownTheme, tui: FOOTER_TUI });
  const makeCtx = (overrides = {}) => ({
    mode: "tui",
    hasUI: true,
    cwd: "/repo",
    model: { id: "model" },
    getContextUsage: () => ({ percent: 1, contextWindow: 100_000 }),
    sessionManager: manager,
    ui: {
      setFooter(factory) { footers.push(factory); },
      getEditorComponent: () => undefined,
      getEditorText: () => undefined,
      setEditorComponent() {},
      setEditorText() {},
      custom() { return Promise.resolve(); },
    },
    ...overrides,
  });
  let ctx = makeCtx(options.ctxOverrides);
  const start = (reason, nextCtx = ctx) => {
    ctx = nextCtx;
    handlers.get("session_start")[0]({ reason }, nextCtx);
  };
  const shutdown = (reason = "quit") => handlers.get("session_shutdown")[0]({ reason }, ctx);
  const emit = (channel, event) => {
    for (const handler of events.get(channel) ?? []) handler(event);
  };
  const started = (event) => emit("subagent:async-started", event);
  const completed = (event) => emit("subagent:async-complete", event);
  return {
    runtime,
    manager,
    events,
    timers,
    footers,
    shortcuts,
    ctx: () => ctx,
    sessionFile,
    sessionId,
    makeCtx,
    start,
    shutdown,
    started,
    completed,
    source: () => runtime.getActivitySource(),
    poll: (index = timers.length - 1) => timers[index]?.callback(),
    restore() {
      if (!patchTimers) return;
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

// 纯投影 harness：真实 browser state + 注入式 renderDetail/subscribe。
function createSource(browser, renderDetail = () => []) {
  let forward;
  const subscribe = (listener) => {
    forward = listener;
    return () => { forward = undefined; };
  };
  const source = subagentActivity.createSubagentActivitySource({ browser, renderDetail, subscribe });
  return { source, notify: () => forward?.() };
}

// ---------- 纯投影（provider 工厂 + 真实 browser state） ----------

test("snapshot 纯投影：active→main、terminal→recent；同 label 异 key 共存", () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-a", asyncDir: "/tmp/run-a", cwd: "/repo", agent: "executor", sessionId: SESSION_UUID });
  browser.trackStarted({ id: "run-b", asyncDir: "/tmp/run-b", cwd: "/repo", agent: "executor", sessionId: SESSION_UUID });
  browser.trackCompleted({ runId: "run-b", sessionId: SESSION_UUID, state: "complete", results: [] });
  const { source } = createSource(browser);

  assert.equal(source.kind, "subagent");
  const snapshot = source.snapshot();
  assert.equal(snapshot.availability, "available");
  const main = snapshot.rows.filter((row) => row.placement === "main");
  const recent = snapshot.rows.filter((row) => row.placement === "recent");
  assert.deepEqual(main.map((row) => row.key), ["subagent:run-a:0"]);
  assert.deepEqual(recent.map((row) => row.key), ["subagent:run-b:0"]);
  // 同 label（无 title 时同为 agent 名）异 key 共存：不按 label 去重。
  assert.equal(main[0].label, "executor");
  assert.equal(recent[0].label, "executor");
  assert.notEqual(main[0].key, recent[0].key);
  assert.equal(main[0].stateLabel, "运行中");
  assert.equal(recent[0].stateLabel, "已完成");
});

test("stateLabel 矩阵：reported/needs-context/unknown 不推断完成，仅完成证据显示已完成", () => {
  // presentation 通道：trackCompleted 的 results 驱动 classifySubagentChildPresentation。
  const presentationCases = [
    [{ status: "complete", success: true }, "已完成"],
    [{ outputState: "present" }, "待处置"], // reported：有输出但无完成证据
    [{ output: "NEEDS_CONTEXT awaiting input" }, "待处置"],
    [{ timedOut: true }, "受限"],
    [{ paused: true }, "已暂停"],
    [{ stopped: true }, "已停止"],
    [{ protocolError: true }, "运行失败"],
  ];
  for (const [result, expected] of presentationCases) {
    const browser = new SubagentSessionBrowserState();
    browser.trackStarted({ id: "run", asyncDir: "/tmp/run", cwd: "/repo", agent: "executor", sessionId: SESSION_UUID });
    browser.trackCompleted({ runId: "run", sessionId: SESSION_UUID, state: "complete", results: [result] });
    const { source } = createSource(browser);
    const row = source.snapshot().rows.find((candidate) => candidate.placement === "recent");
    assert.ok(row, JSON.stringify(result));
    assert.equal(row.stateLabel, expected, JSON.stringify(result));
  }
  // lifecycle 通道（hydrate plain 行驱动）：未知/legacy 终态不推断完成。
  const lifecycleCases = [
    ["mystery", "待处置"],
    ["failed", "待处置"],
    ["rejected", "待处置"],
    ["terminal-proof", "待处置"],
    ["timed-out", "受限"],
    ["detached", "已停止"],
    ["running", "运行中"],
    ["complete", "已完成"],
  ];
  for (const [state, expected] of lifecycleCases) {
    const browser = SubagentSessionBrowserState.hydrate({
      version: 1,
      children: [{ key: "u:0", runId: "u", index: 0, agent: "observer", state, asyncDir: "/tmp/u", cwd: "/repo" }],
    });
    const { source } = createSource(browser);
    const row = source.snapshot().rows[0];
    assert.ok(row, state);
    assert.equal(row.stateLabel, expected, state);
  }
});

test("root/leaf：confirmed facade 折叠为单一 canonical 行（不重复）", (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-workflow-root-"));
  const leafDir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-workflow-leaf-"));
  t.after(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(leafDir, { recursive: true, force: true });
  });
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "wf-root", mode: "workflow", agent: "workflow", asyncDir: rootDir, cwd: "/repo", sessionId: SESSION_UUID, workflowKey: "typed-key" });
  browser.trackStarted({ id: "wf-leaf", mode: "single", agent: "reviewer", asyncDir: leafDir, cwd: "/repo", sessionId: SESSION_UUID, parentWorkflowRunId: "wf-root", workflowKey: "typed-key", title: "审阅任务" });
  fs.writeFileSync(path.join(rootDir, "status.json"), JSON.stringify({ state: "complete", mode: "workflow", steps: [{ runId: "wf-leaf", agent: "reviewer", workflowKey: "typed-key", status: "running" }] }));
  fs.writeFileSync(path.join(leafDir, "status.json"), JSON.stringify({ state: "running", mode: "single", parentWorkflowRunId: "wf-root", workflowKey: "typed-key", steps: [{ agent: "reviewer", status: "running" }] }));
  browser.reconcileRun("wf-root", readBrowserRunStatus(rootDir));
  browser.reconcileRun("wf-leaf", readBrowserRunStatus(leafDir));
  const { source } = createSource(browser);
  const rows = source.snapshot().rows;
  // root facade 被确认折叠，仅 leaf 出现在投影中；root/leaf 关系经 browser canonical 保留。
  assert.deepEqual(rows.map((row) => row.key), ["subagent:wf-leaf:0"]);
  assert.match(rows[0].label, /审阅任务/);
});

test("recent 历史沿用 browser 的 20 条上限（history cap）", () => {
  const browser = new SubagentSessionBrowserState();
  for (let index = 0; index < 25; index += 1) {
    const id = `hist-${index}`;
    browser.trackStarted({ id, asyncDir: `/tmp/${id}`, cwd: "/repo", agent: "executor", sessionId: SESSION_UUID });
    browser.trackCompleted({ runId: id, sessionId: SESSION_UUID, state: "complete", results: [] });
  }
  const { source } = createSource(browser);
  const rows = source.snapshot().rows;
  assert.equal(rows.filter((row) => row.placement === "recent").length, 20);
  assert.equal(rows.some((row) => row.placement === "main"), false);
});

test("label 沿用 footer 标题合同：title registry 优先，缺 title 回退 label/agent", () => {
  const registry = getTitleRegistry();
  registry.remember("titled-run", "调研 footer");
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "titled-run", asyncDir: "/tmp/titled", cwd: "/repo", agent: "executor", sessionId: SESSION_UUID });
  browser.trackStarted({ id: "plain-run", asyncDir: "/tmp/plain", cwd: "/repo", agent: "delegate" });
  browser.trackStarted({ id: "labeled-run", asyncDir: "/tmp/labeled", cwd: "/repo", agent: "reviewer", title: "自带标签" });
  const { source } = createSource(browser);
  const labels = new Map(source.snapshot().rows.map((row) => [row.key, row.label]));
  assert.equal(labels.get("subagent:titled-run:0"), "调研 footer (executor)");
  assert.equal(labels.get("subagent:plain-run:0"), "delegate");
  assert.equal(labels.get("subagent:labeled-run:0"), "自带标签 (reviewer)");
});

test("subscribe：browser 变化转发失效；退订后不再触发；监听者异常彼此隔离", () => {
  const browser = new SubagentSessionBrowserState();
  const { source, notify } = createSource(browser);
  let first = 0;
  let second = 0;
  const disposeFirst = source.subscribe(() => {
    first += 1;
    throw new Error("listener 爆炸");
  });
  source.subscribe(() => { second += 1; });
  notify();
  assert.equal(first, 1);
  assert.equal(second, 1, "异常监听者不影响其他监听者");
  disposeFirst();
  notify();
  assert.equal(first, 1, "退订后不再触发");
  assert.equal(second, 2);
});

test("detail：按 row key 解析 child，经 renderDetail 生成只读组件并缓存重渲染", async () => {
  const browser = new SubagentSessionBrowserState();
  browser.trackStarted({ id: "run-d", asyncDir: "/tmp/run-d", cwd: "/repo", agent: "executor", sessionId: SESSION_UUID });
  const calls = [];
  const { source } = createSource(browser, (childKey, width, expandedTools) => {
    calls.push({ childKey, width, expandedTools });
    return [`detail:${childKey}:${width}:${expandedTools}`];
  });
  let rerenders = 0;
  const component = await source.detail("subagent:run-d:0", { expanded: true, requestRender() { rerenders += 1; } });
  assert.ok(component);
  assert.deepEqual(component.render(40), ["detail:run-d:0:40:true"]);
  assert.deepEqual(component.render(40), ["detail:run-d:0:40:true"]);
  assert.equal(calls.length, 1, "同宽度缓存");
  component.invalidate();
  assert.equal(rerenders, 1);
  assert.deepEqual(component.render(40), ["detail:run-d:0:40:true"]);
  assert.equal(calls.length, 2, "invalidate 后重渲染");
  assert.equal(await source.detail("subagent:missing:0", { expanded: false, requestRender() {} }), undefined);
  assert.equal(await source.detail("run-d:0", { expanded: false, requestRender() {} }), undefined, "row key 必须带 kind 前缀");
});

// ---------- runtime 接线（createFooterRuntime + F0 §4 身份门禁） ----------

test("当前 session 双形态身份均接受：file 形态 started、UUID 形态 complete", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  h.started({ id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  assert.deepEqual(h.source().snapshot().rows.map((row) => row.placement), ["main"]);
  h.completed({ runId: "run-1", sessionId: h.sessionId, state: "complete", results: [] });
  assert.deepEqual(h.source().snapshot().rows.map((row) => row.placement), ["recent"]);
});

test("异 session / 缺失 / 空 / 非 string sessionId 一律拒绝且不写 roster", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  for (const [index, sessionId] of [undefined, "", 123, null, OTHER_FILE, OTHER_UUID].entries()) {
    h.started({ id: `bad-${index}`, asyncDir: `/tmp/bad-${index}`, cwd: "/repo", agent: "executor", sessionId });
    h.completed({ runId: `bad-${index}`, sessionId, state: "complete", results: [] });
  }
  assert.deepEqual(h.source().snapshot().rows, []);
});

test("伪造 generation 字段被忽略：身份匹配的事件不被 generation 拦截", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  // 事件 payload 无 generation 字段（F0 §2.4）；fixture 注入该字段时必须被忽略，
  // 不得据此实现过滤。
  h.started({ id: "gen-run", asyncDir: "/tmp/gen-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile, generation: 999, epoch: "forged" });
  assert.equal(h.source().snapshot().rows.length, 1);
  h.completed({ runId: "gen-run", sessionId: h.sessionId, state: "complete", results: [], generation: 0 });
  assert.equal(h.source().snapshot().rows[0].placement, "recent");
});

test("foreground 形态事件按 runId 关联身份：复合 id 不作 runId 使用", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  h.started({ id: "fg-run", asyncDir: "/tmp/fg-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  // subagent:foreground-complete 的 payload 形态（F0 §2.3）：id 为 `${runId}:${index}`
  // 复合值，身份关联用 runId 字段；sessionId 为父 session 身份。
  h.completed({ id: "fg-run:0", runId: "fg-run", source: "foreground", mode: "single", agent: "executor", success: true, state: "complete", sessionId: h.sessionId, taskIndex: 0 });
  const rows = h.source().snapshot().rows;
  // 事件 id 的复合值不得被当作 runId：既有 run 终态化，而非新建 "fg-run:0" run。
  assert.deepEqual(rows.map((row) => row.key), ["subagent:fg-run:0"]);
  assert.equal(rows[0].placement, "recent");
  assert.equal(rows[0].stateLabel, "已完成");
});

test("same-session reload：roster 保留、原 run 的 complete 继续接收（不虚构 generation 拦截）", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  h.started({ id: "reload-run", asyncDir: "/tmp/reload-run", cwd: "/repo", agent: "reviewer", sessionId: h.sessionFile });
  assert.equal(h.source().snapshot().rows.length, 1);
  h.shutdown("reload");
  h.start("reload"); // 同 manager 同 session：分区恢复
  const rows = h.source().snapshot().rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, "subagent:reload-run:0");
  // reload 前派发、reload 后投递的 complete（UUID 形态）继续被接受。
  h.completed({ runId: "reload-run", sessionId: h.sessionId, state: "complete", results: [] });
  assert.equal(h.source().snapshot().rows[0].placement, "recent");
});

test("旧闭包失效：teardown 后直接调用旧 handler 无效果；重复 teardown 幂等", (t) => {
  const h = createHarness();
  t.after(() => { h.restore(); });
  h.start("startup");
  h.started({ id: "kept-run", asyncDir: "/tmp/kept-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  const oldStarted = (h.events.get("subagent:async-started") ?? [])[0];
  h.shutdown("reload");
  // 事件通道在 teardown 时退订清空；重复 shutdown（幂等 teardown/退订）不抛错。
  assert.equal(h.events.size, 0);
  // SDK 在 invalidate 时自动退订；fixture 直接调用旧 handler 验证 token 守卫
  //（F0 §10 反例4）。
  oldStarted?.({ id: "late-run", asyncDir: "/tmp/late-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  h.start("reload");
  const rows = h.source().snapshot().rows;
  assert.deepEqual(rows.map((row) => row.key), ["subagent:kept-run:0"], "分区恢复既有 roster，迟到旧事件不得写入");
  h.shutdown("quit");
  h.shutdown("quit");
});

test("reload 后旧 source 失效：late invalidate 不转发、snapshot 读被清空的旧 browser", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  const oldSource = h.source();
  let oldInvalidations = 0;
  oldSource.subscribe(() => { oldInvalidations += 1; });
  h.started({ id: "r1", asyncDir: "/tmp/r1", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  assert.equal(oldInvalidations, 1);
  h.shutdown("reload");
  h.start("reload");
  h.started({ id: "r2", asyncDir: "/tmp/r2", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  assert.equal(oldInvalidations, 1, "旧 source 不再收到新代失效");
  assert.deepEqual(oldSource.snapshot().rows, [], "旧 source 的 browser 已被 teardown 清空，不读新代数据");
  let newInvalidations = 0;
  h.source().subscribe(() => { newInvalidations += 1; });
  h.started({ id: "r3", asyncDir: "/tmp/r3", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  assert.equal(newInvalidations, 1);
});

test("SDK reload 语义：模块重求值后新 factory 同 manager/session 分区保留，旧回调释放", async (t) => {
  const h1 = createHarness();
  t.after(() => { h1.shutdown(); h1.restore(); });
  h1.start("startup");
  h1.started({ id: "reload-evidence", asyncDir: "/tmp/reload-evidence", cwd: "/repo", agent: "executor", sessionId: h1.sessionFile });
  const oldSource = h1.source();
  let oldInvalidations = 0;
  oldSource.subscribe(() => { oldInvalidations += 1; });
  h1.shutdown("reload");
  // SDK reload 链路：session_shutdown{reason:"reload"} → oldRunner.invalidate →
  // resourceLoader.reload → clearExtensionCache（loader.js:87-92）→ 源 TS 经
  // jiti moduleCache:false 重新 import（loader.js:477-481）。此处用同一 jiti
  //（moduleCache:false，已探针证实重求值）重新 import footer-runtime 复现模块
  // 重求值；单模块重复 session_start 不能冒充该证据。
  const reloadedFooterRuntime = await jiti.import("../packages/pi-subagents-enhanced/src/tui/footer-runtime.ts");
  assert.notEqual(reloadedFooterRuntime.createFooterRuntime, footerRuntime.createFooterRuntime, "必须是重求值的新模块实例");
  // 新 factory + 新 pi/ctx，同 manager 对象与同 session 身份（reload 不换 SessionManager，F0 §6）。
  const h2 = createHarness({ runtimeModule: reloadedFooterRuntime, manager: h1.manager, patchTimers: false });
  h2.start("reload");
  const rows = h2.source().snapshot().rows;
  assert.deepEqual(rows.map((row) => row.key), ["subagent:reload-evidence:0"], "跨模块重载：分区容器保留同 manager/session 的 plain rows");
  // 旧回调释放：旧 source 订阅不再触发；旧 source snapshot 只反映被清空的旧 browser。
  h2.started({ id: "post-reload-run", asyncDir: "/tmp/post-reload-run", cwd: "/repo", agent: "reviewer", sessionId: h2.sessionFile });
  assert.equal(oldInvalidations, 0, "旧 source 不再收到新代失效");
  assert.deepEqual(oldSource.snapshot().rows, []);
  // same-session reload 的原 run 完成继续接收（跨 factory 新代闭包）。
  h2.completed({ runId: "reload-evidence", sessionId: h2.sessionId, state: "complete", results: [] });
  const reloadedRows = h2.source().snapshot().rows;
  assert.equal(reloadedRows.find((row) => row.key === "subagent:post-reload-run:0")?.placement, "main", "新 factory 接受当前 session 新事件");
  assert.equal(reloadedRows.find((row) => row.key === "subagent:reload-evidence:0")?.placement, "recent", "same-session 原 run 的 complete 继续接收并终态化");
});

test("分区隔离：new 的新身份与同 ID 异 manager 均取空 roster", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  h.started({ id: "iso-run", asyncDir: "/tmp/iso-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  assert.equal(h.source().snapshot().rows.length, 1);
  // new：新 manager + 新 session 身份 → 空分区（不继承旧 session roster）。
  h.start("new", h.makeCtx({
    sessionManager: { getSessionFile: () => "/sessions/new-session.jsonl", getSessionId: () => "aaaaaaaa-0000-4000-8000-000000000001" },
  }));
  assert.deepEqual(h.source().snapshot().rows, [], "new session 不继承旧 session roster");
  h.started({ id: "new-run", asyncDir: "/tmp/new-run", cwd: "/repo", agent: "executor", sessionId: "/sessions/new-session.jsonl" });
  assert.equal(h.source().snapshot().rows.length, 1);
  // resume 同 ID（同 sessionFile/UUID 值）但不同 manager 对象 → 仍取空分区。
  h.start("resume", h.makeCtx({
    sessionManager: { getSessionFile: () => h.sessionFile, getSessionId: () => h.sessionId },
  }));
  assert.deepEqual(h.source().snapshot().rows, [], "同 ID 异 manager 不取他人 roster");
});

test("roster 分区只延续 plain rows：reload 恢复不依赖旧 ctx/ui 闭包", (t) => {
  const h = createHarness();
  t.after(() => { h.restore(); });
  h.start("startup");
  const firstCtx = h.ctx();
  h.started({ id: "plain-run", asyncDir: "/tmp/plain-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  h.shutdown("reload");
  // 全新 ctx/ui 对象（同 manager 同 session）：分区恢复的行只含 BrowserChild plain
  // 字段，不携带旧 ctx/pi/callback。
  const secondCtx = h.makeCtx();
  assert.notEqual(secondCtx, firstCtx);
  h.start("reload", secondCtx);
  const rows = h.source().snapshot().rows;
  assert.deepEqual(rows.map((row) => row.key), ["subagent:plain-run:0"]);
  // 行对象为纯显示投影（plain 字段），无 ctx/ui 函数残留。
  const row = rows[0];
  assert.deepEqual(Object.keys(row).sort(), ["key", "kind", "label", "placement", "stateLabel"]);
});

test("getActivitySource 生命周期与唯一安装：tui 可用、非 tui/teardown 后 undefined；不新增 setFooter/shortcut", (t) => {
  const h = createHarness();
  t.after(() => { h.restore(); });
  assert.equal(h.runtime.getActivitySource(), undefined, "session_start 前无 provider");
  h.start("startup");
  assert.ok(h.runtime.getActivitySource());
  assert.equal(h.footers.length, 1, "唯一 setFooter 安装");
  assert.equal(h.shortcuts.length, 0, "runtime 不注册快捷键（薄 entry 职责）");
  h.start("startup", h.makeCtx({ mode: "rpc", hasUI: true }));
  assert.equal(h.runtime.getActivitySource(), undefined, "非 tui session 不创建 provider");
  assert.equal(h.footers.length, 1, "非 tui 不重复安装 footer");
  h.start("reload", h.makeCtx());
  assert.ok(h.runtime.getActivitySource());
  assert.equal(h.footers.length, 2, "reload 重新安装（仍是唯一 owner 路径）");
  h.shutdown("quit");
  assert.equal(h.runtime.getActivitySource(), undefined, "teardown 后失效");
});

test("standalone footer 渲染保持：行投影经既有 footer 组件可见", (t) => {
  const h = createHarness();
  t.after(() => { h.shutdown(); h.restore(); });
  h.start("startup");
  h.started({ id: "display-run", asyncDir: "/tmp/display-run", cwd: "/repo", agent: "executor", sessionId: h.sessionFile });
  const component = h.footers[0]({ requestRender() {} }, { fg: (_color, value) => value }, {});
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /● executor/);
  assert.doesNotMatch(rendered, /main/);
});

test("detail 走 package trusted native：native 会话先于 Fleet 回退渲染", async (t) => {
  const sessions = fs.mkdtempSync(path.join(os.tmpdir(), "provider-native-sessions-"));
  const asyncDir = fs.mkdtempSync(path.join(sessions, "provider-native-async-"));
  const parent = SessionManager.create("/repo", sessions);
  parent.appendMessage({ role: "user", content: "parent root", timestamp: Date.now() });
  const child = SessionManager.create("/repo", sessions);
  child.appendMessage({ role: "user", content: "native child message", timestamp: Date.now() });
  child.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "native child reply" }],
    api: "test", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sessionFile = child.getSessionFile();
  const parentSessionFile = parent.getSessionFile();
  assert.ok(sessionFile);
  assert.ok(parentSessionFile);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const transcriptPath = path.join(asyncDir, "fleet.jsonl");
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "Fleet fallback message" }] } }) + "\n");
  const h = createHarness({ manager: { getSessionFile: () => parentSessionFile, getSessionId: () => SESSION_UUID } });
  t.after(() => { h.shutdown(); h.restore(); fs.rmSync(sessions, { recursive: true, force: true }); });
  h.start("startup");
  h.started({ id: "native-run", asyncDir, cwd: "/repo", agent: "executor", sessionId: parentSessionFile });
  fs.writeFileSync(path.join(asyncDir, "status.json"), JSON.stringify({ state: "complete", steps: [{ agent: "executor", status: "completed", sessionFile: path.relative(asyncDir, sessionFile), transcriptPath }] }));
  h.poll();
  const component = await h.source().detail("subagent:native-run:0", { expanded: false, requestRender() {} });
  assert.ok(component, "tracked child 必须可出详情组件");
  const rendered = component.render(80).join("\n");
  assert.match(rendered, /native child message/);
  assert.doesNotMatch(rendered, /Fleet fallback message/);
});

test("行投影携带模型 metaLabel（只读展示投影）：详情 footer 依此显示该 subagent 用什么模型", () => {
  const base = { key: "run:0", runId: "run", index: 0, agent: "executor", state: "running", asyncDir: "/tmp/run", cwd: "/repo" };
  const withModel = subagentActivity.projectSubagentActivityRows({
    active: true, children: [{ ...base, model: "codex-pool/gpt-6.1-sol:high", thinking: "high" }],
    activeChildren: [{ ...base, model: "codex-pool/gpt-6.1-sol:high", thinking: "high" }], recentChildren: [],
  });
  assert.equal(withModel[0].metaLabel, "模型 (codex-pool) gpt-6.1-sol · thinking: high");
  assert.equal(withModel[0].key, "subagent:run:0", "展示投影不参与行身份（身份仍只认稳定 key）");
  const bare = subagentActivity.projectSubagentActivityRows({
    active: true, children: [{ ...base, model: "gpt-6.1-sol" }], activeChildren: [{ ...base, model: "gpt-6.1-sol" }], recentChildren: [],
  });
  assert.equal(bare[0].metaLabel, "模型 gpt-6.1-sol", "无 provider 前缀时不伪造 provider");
  const unknown = subagentActivity.projectSubagentActivityRows({ active: true, children: [base], activeChildren: [base], recentChildren: [] });
  assert.equal(Object.hasOwn(unknown[0], "metaLabel"), false, "模型与 thinking 均未知时不设字段，footer 不堆 no-model 噪声");
  assert.deepEqual(Object.keys(unknown[0]).sort(), ["key", "kind", "label", "placement", "stateLabel"], "未知模型时行仍只含协议五字段");
});
