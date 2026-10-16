// 统一执行计划 F6 / footer 子计划 T6a+T6b：唯一 owner 握手与生命周期集成验收。
//
// 现场形态：真实 SDK（createAgentSessionServices / createAgentSessionFromServices /
// createAgentSessionRuntime、真实 pi.events bus、真实 session_start/session_shutdown/
// reload/new/fork/resume 事件链、真实 extension 加载顺序）+ fake TUI（记录型
// ExtensionUIContext：setFooter/custom/editor/draft/notify）+ fake provider（本地注册，
// 无网络、无凭据、无真实模型）+ 合法事件流水线（真实 bus 上的 subagent:async-started，
// 真实 F3 bash publisher/source 与 F4b scheduler publisher/source 公开接口）。
//
// 明确标注的显示 fixture（非 production 数据）：bash controller 与 scheduler observer 为
// 形状等价替身（F3/F4b 单元验收已用同约定覆盖真实 controller/adapter），只用于驱动
// source 投影；protocol 层的 source-register/unregister/presenter-register 报文由测试
// 作为总线参与者按公开协议直接 emit（bus 即公开握手接口），载荷均通过 scope 校验。
//
// 不启动真实 Host/终端、不跑真实任务、不读真实 settings/session/store、不发消息、
// 不 kill 进程、不 sleep/poll 等待；断言全部来自确定性 barrier 与同步握手结果。
//
// 覆盖清单（派发合同）：owner-first / source-first / owner 缺席 / root 缺席(standalone) /
// 重复 ready 幂等 / 同 registrationId 幂等（不重复 setFooter、不关 overlay、不重置选中）/
// 不同 registrationId 换视图（关旧 overlay、恢复 draft+editor、dispose 旧组件）/
// 匹配 unregister 恢复 standalone / 过期 ID 与旧 scope(token) 一律忽略 /
// 旧 registrationId unregister 不移除同 kind 新 source / reload·new·resume·fork 旧 ctx 失效 /
// late detail 不覆盖新选择 / RPC 零 terminal UI / shutdown 清理无任务副作用。

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { loadPiTestRuntime } from "./helpers/pi-runtime.mjs";

const { jiti, codingAgent: sdk, piTui } = await loadPiTestRuntime(import.meta.url);
sdk.initTheme("dark", false);

// package 薄 entry 与根 entry 均经同一 jiti 实例图加载：协议模块单实例，
// pi-tui/SDK 经 piHostAliases 绑定本仓锁定版本。
const customFooterEntry = await jiti.import("../packages/pi-subagents-enhanced/extensions/custom-footer.ts");
const rootActivityEntry = await jiti.import("../pi/extensions/background-activity.ts");
const bashActivity = await jiti.import("../src/bash-async/index.ts");
const schedulerActivity = await jiti.import("../src/task-scheduler/index.ts");
const protocol = await jiti.import("pi-subagents-enhanced/tui/background-activity");

const CHANNELS = protocol.BACKGROUND_ACTIVITY_CHANNELS;
const flush = () => new Promise((resolve) => setImmediate(resolve));
const THEME = { fg: (_color, text) => text, bold: (text) => text };
const FOOTER_DATA = { getExtensionStatuses: () => new Map() };

// ---------- 显示 fixture：bash controller / scheduler observer 形状等价替身 ----------

function createBashControllerFixture() {
  const state = { active: [], completed: [] };
  const listeners = new Set();
  const counters = { subscribes: 0, unsubscribes: 0, snapshots: 0 };
  const notify = () => { for (const listener of [...listeners]) listener(); };
  return {
    counters,
    state,
    controller: {
      snapshot() {
        counters.snapshots += 1;
        return { active: [...state.active], completed: [...state.completed] };
      },
      subscribe(listener) {
        counters.subscribes += 1;
        listeners.add(listener);
        return () => { counters.unsubscribes += 1; listeners.delete(listener); };
      },
      // 只读观察面之外的任务控制入口故意不存在：display 层若尝试取消/关闭任务会直接抛错。
    },
    launch(jobId, command) {
      state.active.push({ jobId, command, cwd: "/repo", toolCallId: `call-${jobId}`, acceptedAt: new Date(0).toISOString() });
      notify();
    },
    complete(jobId, outcome = "succeeded", exitCode = 0) {
      const index = state.active.findIndex((receipt) => receipt.jobId === jobId);
      if (index === -1) return;
      const [receipt] = state.active.splice(index, 1);
      state.completed.push({
        ...receipt, outcome, exitCode, elapsedMs: 5, completionDelivery: "attempted",
        output: { content: [{ type: "text", text: `fixture output ${jobId}` }] },
      });
      notify();
    },
  };
}

function createSchedulerObserverFixture(options = {}) {
  const records = options.records ?? [
    { id: "task-1", name: "每日巡检", type: "cron", schedule: "0 9 * * *", enabled: true, lastStatus: "pending", nextRunAt: "2026-10-15T09:00:00.000Z", runCount: 0, prompt: "fixture-prompt-not-displayed" },
  ];
  const listeners = new Set();
  const counters = { subscribes: 0, unsubscribes: 0, details: [] };
  const deferred = new Map();
  return {
    counters,
    records,
    observer: {
      snapshot: () => ({ availability: "available", records: [...records], observedAt: new Date(0).toISOString() }),
      subscribe(listener) {
        counters.subscribes += 1;
        listeners.add(listener);
        return () => { counters.unsubscribes += 1; listeners.delete(listener); };
      },
      async detail(id) {
        counters.details.push(id);
        if (id !== "task-1") return { ok: false, reason: "no-detail-tool" };
        if (options.deferDetail) {
          // late detail 用例：由测试显式 resolve，不 sleep/poll。
          let resolve;
          const promise = new Promise((resolveInner) => { resolve = resolveInner; });
          deferred.set(id, resolve);
          await promise;
        }
        return { ok: true, result: { content: [{ type: "text", text: `受控详情 ${id}` }] } };
      },
    },
    resolveDetail(id) { deferred.get(id)?.({ ok: true, result: { content: [{ type: "text", text: `受控详情 ${id}` }] } }); },
    settleDetail(id) {
      const resolve = deferred.get(id);
      if (resolve) { resolve({ ok: true, result: { content: [{ type: "text", text: `受控详情 ${id}` }] } }); deferred.delete(id); }
    },
    notify() { for (const listener of [...listeners]) listener(); },
  };
}

/** 协议参与者 fixture：按公开 ActivitySource 形状提供 source（用于注册/撤销隔离用例）。 */
function createProtocolSourceFixture(kind, label, options = {}) {
  const counters = { subscribes: 0, unsubscribes: 0, details: 0, disposed: 0 };
  return {
    counters,
    source: {
      kind,
      snapshot: () => ({
        availability: "available",
        rows: [{ key: `${kind}:${label}`, kind, label, stateLabel: options.stateLabel ?? "运行中", placement: "main" }],
      }),
      subscribe() { counters.subscribes += 1; return () => { counters.unsubscribes += 1; }; },
      async detail(_key, _request) {
        counters.details += 1;
        return { render: () => [`${label} 详情`], invalidate() {}, dispose() { counters.disposed += 1; } };
      },
    },
  };
}

// ---------- fake TUI（记录型 ExtensionUIContext） ----------

function createUiRecorder() {
  return {
    renders: 0,
    footerInstalls: 0,
    footerFactory: undefined,
    footerComponent: undefined,
    customCalls: [],
    editor: function OriginalEditor() {},
    originalEditor: undefined,
    editorSetCalls: 0,
    draft: "unsent draft",
    notifications: [],
    errors: [],
    shortcuts: [],
    traffic: [],
    epochs: [],
    sends: [],
  };
}

function createFakeUi(record) {
  const makeTui = () => ({ terminal: { rows: 24, columns: 100 }, requestRender() { record.renders += 1; } });
  const ui = {
    theme: THEME,
    setFooter(factory) {
      record.footerInstalls += 1;
      record.footerFactory = factory;
      record.footerComponent = factory ? factory(makeTui(), THEME, FOOTER_DATA) : undefined;
    },
    getEditorComponent: () => record.editor,
    setEditorComponent(factory) { record.editorSetCalls += 1; record.editor = factory; },
    getEditorText: () => record.draft,
    setEditorText(text) { record.draft = text; },
    custom(factory, options) {
      const call = { factory, options, done: 0, focusCalls: 0, component: undefined };
      record.customCalls.push(call);
      call.component = factory(makeTui(), THEME, {}, () => { call.done += 1; });
      try { options?.onHandle?.({ focus() { call.focusCalls += 1; } }); } catch { /* focus 失败不阻断挂载 */ }
      return Promise.resolve();
    },
    notify(message, level) { record.notifications.push({ message, level }); },
    setStatus() {},
    setWorkingMessage() {},
    setWorkingVisible() {},
    onTerminalInput() { throw new Error("统一后台活动不得安装全局终端输入监听"); },
  };
  record.originalEditor = record.editor;
  return ui;
}

// ---------- 真实 SDK Host ----------

async function createHost(t, options = {}) {
  const mode = options.mode ?? "tui";
  const order = options.order ?? ["probe", "owner", "root", "bash", "scheduler"];
  const record = createUiRecorder();
  const ui = createFakeUi(record);
  const root = await realpath(await mkdtemp(join(tmpdir(), "bg-activity-host-")));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);
  t.after(() => rm(root, { recursive: true, force: true }));

  const credentials = {
    async read() { return undefined; },
    async list() { return []; },
    async modify() { throw new Error("禁止真实凭据写入"); },
    async delete() { throw new Error("禁止真实凭据删除"); },
  };
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerProvider("bg-activity-fixture", {
    api: "bg-activity-fixture", apiKey: "fixture-not-a-secret", baseUrl: "http://127.0.0.1:9",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 65536, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const message = {
          role: "assistant", content: [{ type: "text", text: "fixture completed" }], api: model.api, provider: model.provider,
          model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
        };
        void context;
        stream.push({ type: "start", partial: message });
        stream.push({ type: "text_start", contentIndex: 0, partial: message });
        stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture completed", partial: message });
        stream.push({ type: "text_end", contentIndex: 0, content: "fixture completed", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });
  const settingsManager = sdk.SettingsManager.inMemory({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 100 },
    retry: { enabled: false },
    cacheWarming: "off",
    defaultProjectTrust: "always",
  });

  const bus = () => ({
    on: (channel, handler) => record.buses.at(-1).on(channel, handler),
    emit: (channel, data) => record.buses.at(-1).emit(channel, data),
  });

  const factories = {
    // 探针：捕获当代 pi.events/ctx（合法公开 API），并记录全部握手 channel 流量。
    probe: (pi) => {
      record.buses = record.buses ?? [];
      record.buses.push(pi.events);
      for (const channel of Object.values(CHANNELS)) {
        pi.events.on(channel, (data) => record.traffic.push({ channel, data }));
      }
      pi.on("session_start", (_event, ctx) => { record.epochs.push({ ctx, sessionManager: ctx.sessionManager, mode: ctx.mode }); });
    },
    // package 薄 entry（唯一 setFooter / 唯一 Alt+O owner）。
    owner: (pi) => {
      const original = pi.registerShortcut.bind(pi);
      pi.registerShortcut = (key, definition) => { record.shortcuts.push({ key, definition }); return original(key, definition); };
      try { customFooterEntry.default(pi); } finally { pi.registerShortcut = original; }
    },
    // 根 entry：只发布 presenter factory。
    root: (pi) => { rootActivityEntry.default(pi); },
    // F3 bash publisher：与 pi/extensions/bash-cwd.ts 相同的接线，controller 为显示 fixture。
    bash: (pi) => {
      const fixture = createBashControllerFixture();
      record.bashFixtures = record.bashFixtures ?? [];
      record.bashFixtures.push(fixture);
      const publisher = bashActivity.createBashAsyncActivityPublisher(fixture.controller, { Text: piTui.Text }, bus());
      pi.on("session_start", async (_event, ctx) => {
        let sessionId;
        try { sessionId = ctx.sessionManager.getSessionId(); } catch { return; }
        if (!sessionId) return;
        publisher.onSessionStart({ mode: ctx.mode, sessionManager: ctx.sessionManager, sessionId });
      });
      pi.on("session_shutdown", async () => { publisher.onSessionShutdown(); });
    },
    // F4b scheduler publisher：与 pi/extensions/task-scheduler.ts 相同的接线，observer 为显示 fixture。
    scheduler: (pi) => {
      const fixture = createSchedulerObserverFixture(options.scheduler ?? {});
      record.schedulerFixtures = record.schedulerFixtures ?? [];
      record.schedulerFixtures.push(fixture);
      const publisher = schedulerActivity.createSchedulerActivityPublisher(fixture.observer, bus());
      pi.on("session_start", async (_event, ctx) => {
        let sessionId;
        try { sessionId = ctx.sessionManager.getSessionId(); } catch { return; }
        if (!sessionId) return;
        publisher.onSessionStart({ mode: ctx.mode, sessionManager: ctx.sessionManager, sessionId });
      });
      pi.on("session_shutdown", async () => { publisher.onSessionShutdown(); });
    },
  };

  const factory = async ({ cwd, agentDir: runtimeAgentDir, sessionManager, sessionStartEvent }) => {
    const services = await sdk.createAgentSessionServices({
      cwd,
      agentDir: runtimeAgentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderOptions: {
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: order.map((name) => factories[name]),
      },
    });
    const created = await sdk.createAgentSessionFromServices({
      services, sessionManager, sessionStartEvent,
      model: modelRuntime.getModel("bg-activity-fixture", "fixture"),
      thinkingLevel: "off",
      tools: [],
    });
    await created.session.bindExtensions({ mode, uiContext: ui, shutdownHandler() {}, onError(error) { record.errors.push(error?.error ?? error); } });
    return { ...created, services, diagnostics: services.diagnostics };
  };

  const sessionManager = sdk.SessionManager.create(root, sessionDir);
  sessionManager.newSession();
  const runtime = await sdk.createAgentSessionRuntime(factory, { cwd: root, agentDir, sessionManager });
  t.after(async () => { await runtime.dispose().catch(() => {}); });

  const traffic = (channel) => record.traffic.filter((entry) => entry.channel === channel);
  const currentEpoch = () => record.epochs.at(-1);
  const rendered = (width = 100) => (record.footerComponent ? record.footerComponent.render(width).join("\n") : "");
  const detailRendered = (width = 100) => {
    const call = record.customCalls.at(-1);
    return call?.component ? call.component.render(width).join("\n") : "";
  };
  const altO = () => {
    const shortcut = record.shortcuts.at(-1);
    assert.ok(shortcut, "唯一 Alt+O 快捷键必须由 package 薄 entry 注册");
    return shortcut.definition.handler(currentEpoch().ctx);
  };
  const emit = (channel, data) => record.buses.at(-1).emit(channel, data);
  /** 同 kind 的不同 registrationId 数：重复 ready 必须复用同 ID（=1）才算幂等。 */
  const distinctRegistrationIds = (channel, predicate = () => true) =>
    new Set(traffic(channel).map((entry) => entry.data).filter(predicate).map((data) => data.registrationId)).size;
  const overlayInput = (data) => record.customCalls.at(-1).component.handleInput(data);

  return {
    record, runtime, root, sessionDir, mode, traffic, currentEpoch, rendered, detailRendered, altO, emit, ui,
    overlayInput, distinctRegistrationIds,
    session: () => runtime.session,
    bash: () => record.bashFixtures?.at(-1),
    scheduler: () => record.schedulerFixtures?.at(-1),
    readyScopes: () => traffic(CHANNELS.ownerReady).map((entry) => entry.data.scope),
    currentScope: () => record.traffic.filter((entry) => entry.channel === CHANNELS.ownerReady).at(-1)?.data.scope,
    presenterRegistrations: () => traffic(CHANNELS.presenterRegister).map((entry) => entry.data),
  };
}

// ---------- owner-first / source-first 握手 ----------

test("owner-first：package 唯一安装 footer，三 source 同 scope 握手，根只发布 factory", async (t) => {
  const host = await createHost(t, { order: ["probe", "owner", "root", "bash", "scheduler"] });
  await flush();

  assert.deepEqual(host.record.errors, []);
  // 唯一 setFooter owner：owner-first 下 package 先安装 standalone 基线，根 entry 的
  // session_start 在后才 request→ready→presenter-register，于是同一 epoch 内由 package
  // 再安装一次统一视图（计划要求全部同步登记，不等其他 extension 的 session_start）。
  // 关键不变量：安装者只有 package，且任意时刻只一个已安装 footer（末次为统一视图）。
  assert.equal(host.record.footerInstalls, 2);
  const rendered = host.rendered();
  assert.match(rendered, /⏱/);
  assert.match(rendered, /每日巡检/);
  assert.match(rendered, /等待触发/);
  assert.equal(host.record.shortcuts.length, 1, "唯一 Alt+O 由 package 薄 entry 注册");

  // 握手流量：owner 先宣布 ready，publisher/root 请求后按同 scope 注册；重复 ready
  // 必须复用同 registrationId（每个 kind 只有一个 ID）。
  const registrations = host.traffic(CHANNELS.sourceRegister).map((entry) => entry.data);
  assert.equal(host.distinctRegistrationIds(CHANNELS.sourceRegister, (data) => data.source.kind === "bash_async"), 1);
  assert.equal(host.distinctRegistrationIds(CHANNELS.sourceRegister, (data) => data.source.kind === "scheduler"), 1);
  assert.equal(host.distinctRegistrationIds(CHANNELS.presenterRegister), 1);
  assert.ok(registrations.length >= 2);
  assert.ok(host.traffic(CHANNELS.ownerRequest).length >= 3);
  const scope = host.currentScope();
  for (const entry of host.traffic(CHANNELS.sourceRegister)) {
    assert.equal(entry.data.scope, scope, "source 注册必须回传 owner 当代 scope（含 token）");
    assert.equal(protocol.isSameHostScope(scope, entry.data.scope), true);
  }
  // package 自有 subagent source 不经 bus：由 registry 直接持有，footer 可显示其行。
  const sessionManager = host.currentEpoch().sessionManager;
  host.emit("subagent:async-started", { id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agent: "executor", sessionId: sessionManager.getSessionId() });
  assert.match(host.rendered(), /●/);
  assert.match(host.rendered(), /executor/);

  // Alt+O 委托统一详情（不是 standalone browser）：overlay 挂载、editor 被只读替身替换。
  await host.altO();
  assert.equal(host.record.customCalls.length, 1);
  assert.equal(host.record.customCalls[0].options.overlay, true);
  assert.deepEqual(host.record.customCalls[0].options.overlayOptions.margin, { bottom: 4 });
  assert.notEqual(host.record.editor, host.record.originalEditor);
  assert.match(host.detailRendered(), /›/);
  // 详情模式 footer 固定最多 3 行导航。
  assert.ok(host.rendered().split("\n").length <= 3);
});

test("source-first：publisher 先加载也能握手，owner 回答 request 后补 snapshot", async (t) => {
  const host = await createHost(t, { order: ["probe", "bash", "scheduler", "root", "owner"] });
  await flush();

  assert.deepEqual(host.record.errors, []);
  // source-first：三个参与者在 owner 之前已 listen ready 并发出 request（无人应答），
  // owner 的 session_start 宣布 ready 后全部同步完成注册，因此只需一次 footer 安装。
  assert.equal(host.record.footerInstalls, 1);
  assert.match(host.rendered(), /每日巡检/);
  assert.equal(host.traffic(CHANNELS.ownerReady).length, 1);
  assert.equal(host.traffic(CHANNELS.ownerRequest).length, 3);
  assert.ok(host.traffic(CHANNELS.sourceRegister).length >= 2);
  assert.equal(host.distinctRegistrationIds(CHANNELS.presenterRegister), 1);
  // owner 缺席时不得注册：本用例反向证明注册确实来自 owner 的 ready。
  assert.equal(host.record.editorSetCalls, 0);
});

test("owner 缺席：source/root 只请求不注册，零 terminal UI 安装", async (t) => {
  const host = await createHost(t, { order: ["probe", "bash", "scheduler", "root"] });
  await flush();

  assert.deepEqual(host.record.errors, []);
  assert.equal(host.record.footerInstalls, 0);
  assert.equal(host.record.customCalls.length, 0);
  assert.equal(host.record.editorSetCalls, 0);
  assert.equal(host.traffic(CHANNELS.ownerReady).length, 0);
  assert.equal(host.traffic(CHANNELS.sourceRegister).length, 0);
  assert.equal(host.traffic(CHANNELS.presenterRegister).length, 0);
  assert.ok(host.traffic(CHANNELS.ownerRequest).length >= 3, "publisher/root 仍按协议请求 owner");
  assert.equal(host.record.shortcuts.length, 0);
});

test("root 缺席：package standalone footer 与 Alt+O browser 原样可用，source 仍完成握手", async (t) => {
  const host = await createHost(t, { order: ["probe", "owner", "bash", "scheduler"] });
  await flush();

  assert.deepEqual(host.record.errors, []);
  assert.equal(host.record.footerInstalls, 1, "只有 package 安装 standalone footer");
  assert.equal(host.traffic(CHANNELS.presenterRegister).length, 0);
  // source 仍按同 scope 注册进 owner registry（无 presenter 时不显示统一布局），
  // 且重复 ready 下每个 kind 只有一个 registrationId。
  assert.ok(host.traffic(CHANNELS.sourceRegister).length >= 2);
  assert.equal(host.distinctRegistrationIds(CHANNELS.sourceRegister, (data) => data.source.kind === "bash_async"), 1);
  assert.equal(host.distinctRegistrationIds(CHANNELS.sourceRegister, (data) => data.source.kind === "scheduler"), 1);
  const standalone = host.rendered(58).split("\n");
  assert.equal(standalone.length, 3, "standalone footer 保持既有三行布局");
  assert.match(host.rendered(58), /thinking:/);
  assert.doesNotMatch(host.rendered(58), /每日巡检/);

  // Alt+O 打开 package 自有 browser overlay（空 roster 也消费快捷键，不改 editor）。
  await host.altO();
  assert.equal(host.record.customCalls.length, 0);
  assert.equal(host.record.editor, host.record.originalEditor);
  const sessionManager = host.currentEpoch().sessionManager;
  host.emit("subagent:async-started", { id: "run-1", asyncDir: "/tmp/run-1", cwd: "/repo", agent: "executor", sessionId: sessionManager.getSessionId() });
  await host.altO();
  assert.equal(host.record.customCalls.length, 1);
  assert.match(host.rendered(58), /● executor/);
});

// ---------- 幂等、替换与撤销 ----------

test("重复 ready 与同 registrationId 幂等：不重复 setFooter、不关 overlay、不重置选中项", async (t) => {
  const host = await createHost(t);
  await flush();
  host.bash().launch("job-1", "printf fixture-one");
  const scope = host.currentScope();
  const [registration] = host.presenterRegistrations();
  assert.ok(scope && registration);

  await host.altO();
  assert.equal(host.record.customCalls.length, 1);
  const selectionBefore = host.rendered().split("\n")[0];
  const installsBefore = host.record.footerInstalls;

  // 重复 owner-request → owner 重发 ready → publisher 以同 registrationId 重注册。
  const registerBefore = host.traffic(CHANNELS.sourceRegister).length;
  host.emit(CHANNELS.ownerRequest, { sessionManager: scope.sessionManager, sessionId: scope.sessionId, hostKey: scope.hostKey });
  assert.ok(host.traffic(CHANNELS.ownerReady).length >= 2);
  // 两个已订阅 ready 的 source 各重发一次注册（共 +2），但均复用同 registrationId。
  assert.equal(host.traffic(CHANNELS.sourceRegister).length, registerBefore + 2);
  assert.equal(host.distinctRegistrationIds(CHANNELS.sourceRegister, (data) => data.source.kind === "bash_async"), 1, "重复 ready 必须复用同 registrationId");
  assert.equal(host.distinctRegistrationIds(CHANNELS.sourceRegister, (data) => data.source.kind === "scheduler"), 1);
  assert.equal(host.record.footerInstalls, installsBefore, "重复 ready 不得重复安装 footer");

  // 同 registrationId 的 presenter 重发：幂等，不关 overlay、不重置选中项。
  host.emit(CHANNELS.presenterRegister, { scope, registrationId: registration.registrationId, factory: registration.factory });
  assert.equal(host.record.footerInstalls, installsBefore);
  assert.equal(host.record.customCalls.length, 1);
  assert.equal(host.record.customCalls[0].done, 0, "同 ID 重发不得关闭当前详情");
  assert.equal(host.rendered().split("\n")[0], selectionBefore, "同 ID 重发不得重置选中项");
});

test("不同 registrationId 换视图：关旧 overlay、恢复 draft/editor、dispose 旧组件后安装新视图", async (t) => {
  const host = await createHost(t);
  await flush();
  host.bash().launch("job-1", "printf fixture-one");
  const scope = host.currentScope();
  const [registration] = host.presenterRegistrations();

  await host.altO();
  assert.equal(host.record.customCalls.length, 1);
  assert.notEqual(host.record.editor, host.record.originalEditor);
  const installsBefore = host.record.footerInstalls;

  host.emit(CHANNELS.presenterRegister, { scope, registrationId: "fixture-next-registration", factory: registration.factory });
  assert.equal(host.record.customCalls[0].done, 1, "旧 overlay 必须关闭");
  assert.equal(host.record.editor, host.record.originalEditor, "editor 必须恢复");
  assert.equal(host.record.draft, "unsent draft", "draft 必须恢复");
  assert.equal(host.record.footerInstalls, installsBefore + 1, "换视图后由 package 重新安装 footer");
  assert.match(host.rendered(), /printf fixture-one/);

  // 过期 registrationId 的撤销无效：不得卸载当代 presenter。
  host.emit(CHANNELS.presenterUnregister, { scope, registrationId: registration.registrationId });
  assert.equal(host.record.footerInstalls, installsBefore + 1);
  await host.altO();
  assert.equal(host.record.customCalls.length, 2, "当代 presenter 仍可打开详情");

  // 匹配 registrationId 的撤销：恢复 standalone，不叠加安装、不销毁 owner。
  host.emit(CHANNELS.presenterUnregister, { scope, registrationId: "fixture-next-registration" });
  assert.equal(host.record.footerInstalls, installsBefore + 2);
  const lines = host.rendered(58).split("\n");
  assert.equal(lines.length, 3, "恢复 standalone 三行 footer");
  assert.doesNotMatch(host.rendered(58), /printf fixture-one/);
  // owner 仍活着：source 握手与 registry 未被销毁。
  host.emit(CHANNELS.ownerRequest, { sessionManager: scope.sessionManager, sessionId: scope.sessionId, hostKey: scope.hostKey });
  assert.ok(host.traffic(CHANNELS.ownerReady).length >= 2);
});

test("旧 registrationId 的 source-unregister 不移除同 kind 新 source；匹配撤销才生效", async (t) => {
  const host = await createHost(t);
  await flush();
  const scope = host.currentScope();
  const oldFixture = createProtocolSourceFixture("scheduler", "旧记录A");
  const newFixture = createProtocolSourceFixture("scheduler", "新记录B");

  host.emit(CHANNELS.sourceRegister, { scope, registrationId: "fixture-old", source: oldFixture.source });
  assert.match(host.rendered(), /旧记录A/);
  host.emit(CHANNELS.sourceRegister, { scope, registrationId: "fixture-new", source: newFixture.source });
  assert.match(host.rendered(), /新记录B/);
  assert.doesNotMatch(host.rendered(), /旧记录A/);

  // 旧 ID 撤销：不得移除新注册。
  host.emit(CHANNELS.sourceUnregister, { scope, registrationId: "fixture-old", kind: "scheduler" });
  assert.match(host.rendered(), /新记录B/, "旧 registrationId 撤销不得移除同 kind 新 source");

  // 匹配 ID 撤销：新注册退出，scheduler 行消失（其它 kind 不受影响）。
  host.emit(CHANNELS.sourceUnregister, { scope, registrationId: "fixture-new", kind: "scheduler" });
  assert.doesNotMatch(host.rendered(), /新记录B/);
  assert.equal(newFixture.counters.unsubscribes, 1);
  assert.deepEqual(host.record.errors, []);
});

test("旧 scope(token) 的 register/unregister/presenter 报文一律忽略", async (t) => {
  const host = await createHost(t);
  await flush();
  const staleScope = { ...host.currentScope(), token: {} };
  const fixture = createProtocolSourceFixture("bash_async", "旧代任务");
  const installsBefore = host.record.footerInstalls;

  host.emit(CHANNELS.sourceRegister, { scope: staleScope, registrationId: "fixture-stale", source: fixture.source });
  assert.doesNotMatch(host.rendered(), /旧代任务/);
  host.emit(CHANNELS.sourceUnregister, { scope: staleScope, registrationId: "fixture-stale", kind: "scheduler" });
  assert.match(host.rendered(), /每日巡检/, "旧 scope 撤销不得移除当代 source");
  host.emit(CHANNELS.presenterRegister, { scope: staleScope, registrationId: "fixture-stale", factory: () => { throw new Error("旧 scope 不得调用 factory"); } });
  assert.equal(host.record.footerInstalls, installsBefore);
  assert.deepEqual(host.record.errors, []);
});

// ---------- 生命周期：reload / new / resume / fork / RPC ----------

test("reload：新 token 握手，旧 ctx 订阅失效，旧 scope 报文被忽略", async (t) => {
  const host = await createHost(t);
  await flush();
  const firstScope = host.currentScope();
  const firstToken = firstScope.token;
  const readyBefore = host.traffic(CHANNELS.ownerReady).length;
  const installsBefore = host.record.footerInstalls;

  await host.session().reload();
  await flush();

  const closePayloads = host.traffic(CHANNELS.ownerClose).map((entry) => entry.data.scope);
  assert.ok(closePayloads.some((scope) => scope.token === firstToken), "shutdown 必须发出当代 owner-close");
  const secondScope = host.currentScope();
  assert.notEqual(secondScope.token, firstToken, "reload 必须换新 token");
  assert.equal(secondScope.sessionManager, firstScope.sessionManager, "reload 不换 SessionManager");
  assert.equal(secondScope.sessionId, firstScope.sessionId);
  assert.ok(host.traffic(CHANNELS.ownerReady).length > readyBefore);
  // owner-first 下一个新 epoch 由 package 安装 1–2 次（standalone 基线 + 统一视图）；
  // 关键是安装者只有 package，且末次安装为统一视图。
  const installsAfterReload = host.record.footerInstalls;
  assert.ok(installsAfterReload - installsBefore >= 1 && installsAfterReload - installsBefore <= 2, "新 epoch 由 package 重新安装 footer");
  assert.match(host.rendered(), /每日巡检/, "新 epoch 三 source 重新握手");

  // 旧 scope 报文（含旧 token）一律忽略：不注册、不撤销、不换视图。
  const staleFixture = createProtocolSourceFixture("bash_async", "旧代任务");
  host.emit(CHANNELS.sourceRegister, { scope: firstScope, registrationId: "fixture-stale", source: staleFixture.source });
  host.emit(CHANNELS.sourceUnregister, { scope: firstScope, registrationId: "fixture-stale", kind: "scheduler" });
  host.emit(CHANNELS.presenterRegister, { scope: firstScope, registrationId: "fixture-stale", factory: () => { throw new Error("旧 scope 不得调用 factory"); } });
  assert.doesNotMatch(host.rendered(), /旧代任务/);
  assert.match(host.rendered(), /每日巡检/);
  assert.equal(host.record.footerInstalls, installsAfterReload);
  assert.deepEqual(host.record.errors, []);

  // 旧 epoch 的 bus 订阅已退订：旧身份 request 不再被回答。
  const readyAfterStaleRequest = host.traffic(CHANNELS.ownerReady).length;
  host.emit(CHANNELS.ownerRequest, { sessionManager: firstScope.sessionManager, sessionId: "stale-session-id", hostKey: firstScope.hostKey });
  assert.equal(host.traffic(CHANNELS.ownerReady).length, readyAfterStaleRequest);
});

test("new / resume / fork：每次都换新 token 并重新握手，旧 ctx 不残留", async (t) => {
  const host = await createHost(t);
  await flush();
  const seenTokens = new Set([host.currentScope().token]);
  const installs = () => host.record.footerInstalls;
  let previousInstalls = installs();

  const expectNewEpoch = async (label) => {
    await flush();
    const scope = host.currentScope();
    assert.equal(seenTokens.has(scope.token), false, `${label} 必须使用新 token`);
    seenTokens.add(scope.token);
    const delta = installs() - previousInstalls;
    assert.ok(delta >= 1 && delta <= 2, `${label} 的 footer 安装只能由 package 执行（1–2 次）`);
    previousInstalls = installs();
    assert.match(host.rendered(), /每日巡检/, `${label} 后 source 重新握手`);
    assert.deepEqual(host.record.errors, []);
  };

  await host.runtime.newSession();
  await expectNewEpoch("new");

  const resumeSource = sdk.SessionManager.create(host.root, host.sessionDir);
  resumeSource.appendMessage({
    role: "assistant", content: [{ type: "text", text: "resume source" }], api: "faux", provider: "faux", model: "faux",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  });
  await host.runtime.switchSession(resumeSource.getSessionFile());
  await expectNewEpoch("resume");

  const entryId = host.session().sessionManager.appendMessage({ role: "user", content: "fork source", timestamp: new Date().toISOString() });
  host.session().sessionManager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "fork reply" }], api: "faux", provider: "faux", model: "faux",
    usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop", timestamp: Date.now(),
  });
  await host.runtime.fork(entryId);
  await expectNewEpoch("fork");

  // 每次替换都发出上一代 owner-close，且当代只保留一个 owner。
  assert.equal(host.traffic(CHANNELS.ownerClose).length, 3);
  const readyScopes = host.readyScopes();
  assert.equal(readyScopes.at(-1).token, host.currentScope().token);
});

test("RPC：mode!=='tui' 时零 terminal UI、零握手，raw 消息与执行控制不变", async (t) => {
  const host = await createHost(t, { mode: "rpc" });
  await flush();

  assert.equal(host.record.footerInstalls, 0);
  assert.equal(host.record.customCalls.length, 0);
  assert.equal(host.record.editorSetCalls, 0);
  // Alt+O 由 package 薄 entry 在加载时注册一次（SDK 无 unregister），但 RPC 下 handler 惰性：
  // runtime 未绑定 ctx，不构造任何 terminal UI。
  assert.equal(host.record.shortcuts.length, 1);
  await host.altO();
  assert.equal(host.record.customCalls.length, 0);
  assert.equal(host.record.editorSetCalls, 0);
  assert.equal(host.record.footerInstalls, 0);
  assert.equal(host.traffic(CHANNELS.ownerReady).length, 0);
  assert.equal(host.traffic(CHANNELS.sourceRegister).length, 0);
  assert.equal(host.traffic(CHANNELS.presenterRegister).length, 0);
  assert.equal(host.traffic(CHANNELS.ownerRequest).length, 0);
  assert.deepEqual(host.record.errors, []);

  // 合法事件流水线照常：模型回合与 raw 消息不受展示层影响。
  await host.session().prompt("fixture ping");
  await host.session().waitForIdle();
  const messages = host.session().messages;
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  const assistant = messages.findLast((message) => message.role === "assistant");
  assert.deepEqual(assistant.content, [{ type: "text", text: "fixture completed" }]);
  assert.equal(host.record.footerInstalls, 0);
  assert.equal(host.record.customCalls.length, 0);
});

// ---------- late detail 与 shutdown 清理 ----------

test("late detail：旧选择在途详情返回后不覆盖新选择，旧组件被 dispose", async (t) => {
  const host = await createHost(t, { scheduler: { deferDetail: true } });
  await flush();
  host.bash().launch("job-1", "printf fixture-one");
  await host.altO();
  assert.equal(host.record.customCalls.length, 1);
  // F5b 语义：选中项黏着稳定 key（首次 registry 失效时就已选中当时条目），因此用左移
  // 确定性地定位到 bash 条目，不假设初始下标。
  for (let step = 0; step < 3 && !/printf fixture-one/.test(host.detailRendered()); step += 1) host.overlayInput("\x1b[D");
  assert.match(host.detailRendered(), /printf fixture-one/);
  host.overlayInput("\x1b[C");
  assert.match(host.detailRendered(), /每日巡检/);
  assert.match(host.detailRendered(), /加载中/, "scheduler 详情在途");

  host.scheduler().settleDetail("task-1");
  await flush();
  await flush();
  // 仍在 scheduler 选择上：迟到的详情属于当前选择，可显示（不丢合法结果）。
  assert.match(host.detailRendered(), /受控详情 task-1/);

  // 选中项切回 bash 后再让一次迟到返回发生：不得覆盖新选择。
  host.overlayInput("\x1b[D");
  assert.match(host.detailRendered(), /printf fixture-one/);
  host.scheduler().notify();
  await flush();
  await flush();
  assert.match(host.detailRendered(), /printf fixture-one/);
  assert.doesNotMatch(host.detailRendered(), /受控详情/);
  assert.deepEqual(host.record.errors, []);
});

test("shutdown：token 先失效再清理，source 只退订一次，任务与消息零副作用", async (t) => {
  const host = await createHost(t);
  await flush();
  host.bash().launch("job-1", "printf fixture-one");
  const scope = host.currentScope();
  const bashFixture = host.bash();
  const schedulerFixture = host.scheduler();
  const subscribesBefore = { bash: bashFixture.counters.subscribes, scheduler: schedulerFixture.counters.subscribes };
  assert.match(host.rendered(), /printf fixture-one/);

  await host.runtime.dispose();
  await flush();

  assert.ok(host.traffic(CHANNELS.ownerClose).some((entry) => entry.data.scope.token === scope.token));
  assert.equal(bashFixture.counters.unsubscribes, subscribesBefore.bash, "只退订当代订阅一次");
  assert.equal(schedulerFixture.counters.unsubscribes, subscribesBefore.scheduler);
  // 展示清理不触碰任务：job 仍在 fixture controller 的 active 集合内，无取消/无发送。
  assert.equal(bashFixture.state.active.length, 1);
  assert.equal(bashFixture.state.active[0].jobId, "job-1");
  assert.deepEqual(schedulerFixture.counters.details, [], "详情未被清理路径触发");
  assert.equal(host.record.customCalls.length, 0);
  assert.deepEqual(host.record.errors, []);

  // 旧 ctx 已失效：SDK 已将该 runtime 的 bus 标为 stale（emit 直接报错），且旧身份的
  // request 不再被回答、旧 scope 注册被忽略；owner 自己的退订不依赖该报错。
  const readyBefore = host.traffic(CHANNELS.ownerReady).length;
  assert.throws(
    () => host.emit(CHANNELS.ownerRequest, { sessionManager: scope.sessionManager, sessionId: scope.sessionId, hostKey: scope.hostKey }),
    /stale after session replacement|stale/i,
    "dispose 后旧 runtime 的 pi.events 必须已失效",
  );
  assert.equal(host.traffic(CHANNELS.ownerReady).length, readyBefore);
});
