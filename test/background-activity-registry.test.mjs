// 统一执行计划 F1 / footer 子计划 T1 验收：background-activity 公共协议与 registry 显示契约。
//
// 本文件是 display fixture 验证：fixture source 是明确的显示输入，不充当 production
// 数据来源证明；不启动真实 Host/任务，不发消息，不触碰 raw session。
// 覆盖清单（footer 子计划 T1 步骤4）：
//   - 两个不同 owner 同 sessionId 不互收、跨代注册被拒；
//   - 同 label 异 key 共存（不按 label 去重）；
//   - snapshot 变化后不需重 register（pull 事实）；
//   - 旧 dispose 不删新 source、同 kind 替换释放旧订阅；
//   - 重复注册同一 source 幂等（重复 ready 保持同 handle）；
//   - dispose 后 late invalidate 无效果、清理幂等；
//   - available 空 / unavailable / stale 三态可区分；
//   - raw 对象无修改（不写回 source）；
//   - F1 补修：替换/注销后旧注册的晚到 invalidate 无效果（handle fence；公共
//     subscribe 异步回调属合法 production 数据，unsubscribe 不保证撤回已入队回调）；
//   - F1 补修：subscribe 内同步回调路径（handle 先准备、订阅不被吞、仅一次注册通知）；
//   - F1 补修：source 查询异常只输出固定类别 errorLabel、不透传异常正文；
//     source 自报 errorLabel 仍按 raw 原样透传。

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const packageRoot = join(repoRoot, "packages/pi-subagents-enhanced");

// 双路径解析证据：root 经 file: 本地依赖的 bare public export，
// 以及绕开 root 依赖、直接指向 package 源码的 standalone 路径。
const bare = await import("pi-subagents-enhanced/tui/background-activity");
const standalone = await import("../packages/pi-subagents-enhanced/src/tui/index.ts");

const {
  createActivityRegistry,
  createBackgroundActivityRegistrationId,
  isHostScope,
  isSameHostScope,
  isSameHostScopeIdentity,
  BACKGROUND_ACTIVITY_CHANNELS,
} = bare;

function activityRow(kind, key, label, stateLabel = "运行中", placement = "main") {
  return Object.freeze({ key, kind, label, stateLabel, placement });
}

function createFixtureSource(kind, initialSnapshot, options = {}) {
  const state = { snapshot: initialSnapshot, listeners: new Set(), subscriptions: 0 };
  const source = {
    kind,
    snapshot() {
      if (typeof state.snapshot === "function") return state.snapshot();
      return state.snapshot;
    },
    subscribe(listener) {
      if (options.subscribeThrows) throw new Error("subscribe 爆炸");
      state.subscriptions += 1;
      state.listeners.add(listener);
      // leakUnsubscribe：模拟退订不生效的坏 source，用于验证 registry closed 兜底。
      return options.leakUnsubscribe ? () => undefined : () => {
        state.listeners.delete(listener);
      };
    },
    async detail() {
      return undefined;
    },
  };
  return {
    source,
    get subscriptions() {
      return state.subscriptions;
    },
    listenerCount() {
      return state.listeners.size;
    },
    setSnapshot(next) {
      state.snapshot = next;
    },
    invalidate() {
      for (const listener of [...state.listeners]) listener();
    },
  };
}

test("bare file: 依赖与 standalone 路径解析到同一模块，公开协议面完整", () => {
  assert.ok(bare === standalone, "bare export 与 package 源路径必须解析到同一模块实例");
  assert.equal(typeof createActivityRegistry, "function");
  assert.equal(typeof createBackgroundActivityRegistrationId, "function");
  assert.equal(typeof isHostScope, "function");
  assert.equal(typeof isSameHostScope, "function");
  assert.equal(typeof isSameHostScopeIdentity, "function");
  assert.deepEqual(BACKGROUND_ACTIVITY_CHANNELS, {
    ownerReady: "background-activity:owner-ready",
    ownerRequest: "background-activity:owner-request",
    sourceRegister: "background-activity:source-register",
    sourceUnregister: "background-activity:source-unregister",
    presenterRegister: "background-activity:presenter-register",
    presenterUnregister: "background-activity:presenter-unregister",
    ownerClose: "background-activity:owner-close",
  });
});

test("package 出口模块不 import 根路径（standalone 无根反依赖）", async () => {
  const files = [
    join(packageRoot, "src/tui/index.ts"),
    join(packageRoot, "src/tui/background-activity.ts"),
  ];
  const importSpecifier = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
  for (const file of files) {
    const text = await readFile(file, "utf8");
    // import type 全部擦除，不计入运行时依赖。
    const runtimeImports = text.replace(/^import type .*$/gm, "");
    const specifiers = [...runtimeImports.matchAll(importSpecifier)].map((match) => match[1]);
    assert.ok(specifiers.length > 0, `${file} 应至少有一个可检查的运行时 import`);
    for (const specifier of specifiers) {
      const isBuiltin = specifier.startsWith("node:");
      const isPeer = specifier.startsWith("@earendil-works/");
      const isPackageRelative = specifier.startsWith("./") || specifier.startsWith("../");
      assert.ok(
        isBuiltin || isPeer || isPackageRelative,
        `${file} 引用了 package 依赖之外的 specifier：${specifier}`,
      );
      if (isPackageRelative) {
        const target = resolve(dirname(file), specifier);
        assert.ok(
          target.startsWith(packageRoot + "/"),
          `${file} 的相对引用逃逸了 package 目录：${specifier}`,
        );
      }
    }
  }
});

test("scope helper：同 sessionId 不同 owner 不互收，跨代与跨 manager 注册被拒", () => {
  const sessionManager = { manager: true };
  // hostKey 取当前 sessionManager 对象身份。
  const hostKey = sessionManager;
  const scopeA = { sessionManager, sessionId: "session-1", token: { gen: "a" }, hostKey };
  const scopeB = { sessionManager, sessionId: "session-1", token: { gen: "b" }, hostKey };
  const reloadedScope = { sessionManager, sessionId: "session-1", token: { gen: "new" }, hostKey };

  assert.ok(isHostScope(scopeA));
  assert.ok(isHostScope({ ...scopeA }));
  assert.equal(isHostScope(null), false);
  assert.equal(isHostScope({ sessionManager, sessionId: "s", token: "not-object", hostKey }), false);
  assert.equal(isHostScope({ sessionManager, sessionId: 1, token: {}, hostKey }), false);
  assert.equal(isHostScope({ token: {}, hostKey }), false);

  // owner 侧完整匹配：manager/sessionId/hostKey/token 全等才接受。
  assert.ok(isSameHostScope(scopeA, scopeA));
  assert.ok(isSameHostScope(scopeA, { ...scopeA }));
  assert.equal(isSameHostScope(scopeA, scopeB), false, "同 sessionId 不同 token 不互收");
  assert.equal(isSameHostScope(scopeA, reloadedScope), false, "reload 后旧闭包跨代注册被拒");

  // publisher 侧三要素匹配（ready 前无法预知 owner token）。
  assert.ok(isSameHostScopeIdentity(scopeA, { sessionManager, sessionId: "session-1", hostKey }));
  assert.equal(isSameHostScopeIdentity(scopeA, { sessionManager: {}, sessionId: "session-1", hostKey }), false);
  assert.equal(isSameHostScopeIdentity(scopeA, { sessionManager, sessionId: "session-2", hostKey }), false);
  assert.equal(isSameHostScopeIdentity(scopeA, { sessionManager, sessionId: "session-1", hostKey: {} }), false);

  // 行为投影：模拟两个 owner 各持 registry，只有 scope 匹配的注册进入对应实例。
  const ownerA = createActivityRegistry();
  const ownerB = createActivityRegistry();
  const fixture = createFixtureSource("subagent", {
    availability: "available",
    rows: [activityRow("subagent", "subagent:1", "任务A")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const payload = {
    scope: scopeA,
    registrationId: createBackgroundActivityRegistrationId(),
    source: fixture.source,
  };
  const owners = [
    { scope: scopeA, registry: ownerA },
    { scope: scopeB, registry: ownerB },
  ];
  for (const owner of owners) {
    if (isHostScope(payload.scope) && isSameHostScope(payload.scope, owner.scope)) {
      owner.registry.register(payload.source);
    }
  }
  assert.equal(ownerA.sourceSnapshot("subagent").availability, "available");
  assert.equal(ownerB.sourceSnapshot("subagent"), undefined, "不匹配 scope 的 owner 不接入");
});

test("registrationId 由 publisher 随机生成且不重复", () => {
  const first = createBackgroundActivityRegistrationId();
  const second = createBackgroundActivityRegistrationId();
  assert.notEqual(first, second);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("同 label 异 key 共存；sourceFor 按精确 key 反查", () => {
  const registry = createActivityRegistry();
  const subagent = createFixtureSource("subagent", {
    availability: "available",
    rows: [
      activityRow("subagent", "subagent:1", "同名任务"),
      activityRow("subagent", "subagent:2", "同名任务"),
    ],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const bash = createFixtureSource("bash_async", {
    availability: "available",
    rows: [activityRow("bash_async", "bash_async:run-9", "同名任务")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  registry.register(bash.source);
  registry.register(subagent.source);

  const rows = registry.snapshot();
  assert.equal(rows.length, 3, "不按 label 去重");
  assert.deepEqual(
    rows.map((r) => r.key),
    ["subagent:1", "subagent:2", "bash_async:run-9"],
    "固定类型顺序，与注册先后无关",
  );
  assert.equal(registry.sourceFor("subagent:2"), subagent.source);
  assert.equal(registry.sourceFor("bash_async:run-9"), bash.source);
  assert.equal(registry.sourceFor("subagent:missing"), undefined);
  assert.equal(registry.sourceFor("同名任务"), undefined, "不按 label 反查");
});

test("snapshot 变化即时拉取，无需重 register；失效转发给 registry 订阅者", () => {
  const registry = createActivityRegistry();
  const fixture = createFixtureSource("scheduler", {
    availability: "available",
    rows: [activityRow("scheduler", "scheduler:t1", "定时")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const disposeRegister = registry.register(fixture.source);
  let invalidations = 0;
  const disposeListen = registry.subscribe(() => {
    invalidations += 1;
  });

  assert.equal(registry.snapshot().length, 1);
  fixture.setSnapshot({
    availability: "available",
    rows: [
      activityRow("scheduler", "scheduler:t1", "定时"),
      activityRow("scheduler", "scheduler:t2", "另一定时"),
    ],
    observedAt: "2026-10-13T00:00:01.000Z",
  });
  assert.equal(registry.snapshot().length, 2, "变化后无需重注册");
  assert.equal(registry.sourceFor("scheduler:t2"), fixture.source);

  fixture.invalidate();
  assert.equal(invalidations, 1, "source 失效转发给 registry 订阅者");
  disposeRegister();
  assert.equal(invalidations, 2, "注册集变化也触发失效");
  disposeListen();
  fixture.invalidate();
  assert.equal(invalidations, 2, "退订后不再收到失效");
});

test("旧 dispose 不能删新注册；同 kind 替换释放旧订阅", () => {
  const registry = createActivityRegistry();
  const first = createFixtureSource("subagent", {
    availability: "available",
    rows: [activityRow("subagent", "subagent:a", "A")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const second = createFixtureSource("subagent", {
    availability: "available",
    rows: [activityRow("subagent", "subagent:b", "B")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });

  const disposeFirst = registry.register(first.source);
  assert.equal(first.subscriptions, 1);
  const disposeSecond = registry.register(second.source);
  assert.equal(first.listenerCount(), 0, "同 kind 替换时旧订阅被释放");
  assert.equal(second.listenerCount(), 1);
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["subagent:b"],
  );

  let invalidations = 0;
  registry.subscribe(() => {
    invalidations += 1;
  });
  disposeFirst();
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["subagent:b"],
    "旧 dispose 不删新注册",
  );
  assert.equal(invalidations, 0, "旧 dispose 不触发变化通知");
  first.invalidate();
  assert.equal(invalidations, 0, "旧 source 失效不再转发");
  second.invalidate();
  assert.equal(invalidations, 1, "新 source 失效正常转发");
  disposeSecond();
  assert.deepEqual(registry.snapshot(), []);
  assert.equal(second.listenerCount(), 0);
});

test("替换后旧注册的晚到 invalidate 不影响新视图（handle fence）", () => {
  const registry = createActivityRegistry();
  // leakUnsubscribe 模拟合法 production 行为：正常 unsubscribe 不能撤回已递交的回调。
  const stale = createFixtureSource(
    "subagent",
    {
      availability: "available",
      rows: [activityRow("subagent", "subagent:old", "旧任务")],
      observedAt: "2026-10-13T00:00:00.000Z",
    },
    { leakUnsubscribe: true },
  );
  const fresh = createFixtureSource("subagent", {
    availability: "available",
    rows: [activityRow("subagent", "subagent:new", "新任务")],
    observedAt: "2026-10-13T00:00:01.000Z",
  });
  registry.register(stale.source);
  registry.register(fresh.source); // 同 kind 替换：旧 unsubscribe 已调用，但旧回调仍可晚到

  let invalidations = 0;
  registry.subscribe(() => {
    invalidations += 1;
  });
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["subagent:new"],
  );

  stale.invalidate(); // 旧注册晚到回调：当前 handle 属于新注册，必须被 fence 拦下
  assert.equal(invalidations, 0, "旧注册晚到 invalidate 不得 invalidate 新视图");
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["subagent:new"],
  );

  fresh.invalidate(); // 当前注册回调正常转发
  assert.equal(invalidations, 1);
});

test("注销后旧注册的晚到 invalidate 无效果（registration 级 fence）", () => {
  const registry = createActivityRegistry();
  const stale = createFixtureSource(
    "scheduler",
    {
      availability: "available",
      rows: [activityRow("scheduler", "scheduler:1", "定时")],
      observedAt: "2026-10-13T00:00:00.000Z",
    },
    { leakUnsubscribe: true },
  );
  const dispose = registry.register(stale.source);
  dispose();
  assert.equal(registry.sourceSnapshot("scheduler"), undefined);

  let invalidations = 0;
  registry.subscribe(() => {
    invalidations += 1;
  });
  stale.invalidate(); // 注销后晚到回调：byKind 无当前注册，fence 拦下
  assert.equal(invalidations, 0, "注销后晚到 invalidate 无效果");
  assert.deepEqual(registry.snapshot(), []);
});

test("subscribe 同步回调：handle 先准备、订阅保持有效、仅一次注册通知", () => {
  const registry = createActivityRegistry();
  // 合法 production：subscribe 可在调用内同步回调（本注册尚未写入 byKind）。
  const listeners = new Set();
  const source = {
    kind: "bash_async",
    snapshot() {
      return {
        availability: "available",
        rows: [activityRow("bash_async", "bash_async:sync", "命令")],
        observedAt: "2026-10-13T00:00:00.000Z",
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      listener(); // 同步回调
      return () => listeners.delete(listener);
    },
    async detail() {
      return undefined;
    },
  };
  const invalidate = () => {
    for (const listener of [...listeners]) listener();
  };

  let invalidations = 0;
  registry.subscribe(() => {
    invalidations += 1;
  });
  const dispose = registry.register(source);

  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["bash_async:sync"],
    "同步回调不破坏注册",
  );
  assert.equal(invalidations, 1, "同步回调被 fence 拦下，仅注册变化通知一次");
  assert.equal(registry.sourceFor("bash_async:sync"), source);

  invalidate(); // 注册完成后当前 handle 一致，订阅正常转发（未被 catch 误吞）
  assert.equal(invalidations, 2, "同步回调路径未丢失订阅");
  dispose();
  assert.equal(registry.sourceSnapshot("bash_async"), undefined);
});

test("重复注册同一 source 幂等：保持原 handle 与订阅，首个 dispose 仍生效", () => {
  const registry = createActivityRegistry();
  const fixture = createFixtureSource("bash_async", {
    availability: "available",
    rows: [activityRow("bash_async", "bash_async:1", "命令")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const disposeFirst = registry.register(fixture.source);
  const disposeSecond = registry.register(fixture.source);
  assert.equal(fixture.subscriptions, 1, "重复注册未重复订阅");
  assert.equal(fixture.listenerCount(), 1);
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["bash_async:1"],
  );
  disposeFirst();
  assert.equal(registry.sourceSnapshot("bash_async"), undefined, "原 handle 仍生效，一次注销即移除");
  disposeSecond();
  assert.equal(registry.sourceSnapshot("bash_async"), undefined);
});

test("available 空、unavailable、stale 三态可区分；聚合快照只含已确认行", () => {
  const registry = createActivityRegistry();
  const empty = createFixtureSource("subagent", {
    availability: "available",
    rows: [],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  // 自报 errorLabel 是 source 的 raw 数据，registry 原样透传（与 catch 兜底的固定类别文案不同）。
  const broken = createFixtureSource("bash_async", {
    availability: "unavailable",
    rows: [],
    errorLabel: "上游 store 暂不可读",
  });
  const stale = createFixtureSource("scheduler", {
    availability: "stale",
    rows: [activityRow("scheduler", "scheduler:old", "旧观察")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  registry.register(empty.source);
  registry.register(broken.source);
  registry.register(stale.source);

  assert.deepEqual(registry.sourceSnapshot("subagent"), {
    availability: "available",
    rows: [],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  assert.deepEqual(
    registry.sourceSnapshot("bash_async"),
    {
      availability: "unavailable",
      rows: [],
      errorLabel: "上游 store 暂不可读",
    },
    "source 自报 errorLabel 按 raw 原样透传",
  );
  const staleSnapshot = registry.sourceSnapshot("scheduler");
  assert.equal(staleSnapshot.availability, "stale");
  assert.equal(staleSnapshot.rows.length, 1, "上次观察值保留");
  assert.equal(staleSnapshot.observedAt, "2026-10-13T00:00:00.000Z");

  assert.deepEqual(registry.snapshot(), [], "聚合只含 available 行：available 且空即确认无任务");
  assert.equal(registry.sourceFor("scheduler:old"), stale.source, "过期行仍可按 key 反查 source 供详情");
  assert.equal(registry.sourceSnapshot("not-a-kind"), undefined);
});

test("异常 source 被隔离：查询失败不给其他 source 伪造状态、不向调用方传播", () => {
  const registry = createActivityRegistry();
  const healthy = createFixtureSource("subagent", {
    availability: "available",
    rows: [activityRow("subagent", "subagent:1", "正常")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const throwing = createFixtureSource("scheduler", () => {
    // 异常正文模拟不可信秘密：显示层 errorLabel 不得透传该正文。
    throw new Error("secret-token-do-not-display");
  });
  const malformed = createFixtureSource("bash_async", { availability: "available" });
  const subscribeBroken = createFixtureSource(
    "bash_async",
    { availability: "available", rows: [], observedAt: "2026-10-13T00:00:00.000Z" },
    { subscribeThrows: true },
  );
  registry.register(healthy.source);
  registry.register(throwing.source);
  registry.register(malformed.source);

  const isolated = registry.sourceSnapshot("scheduler");
  assert.equal(isolated.availability, "unavailable");
  assert.deepEqual(isolated.rows, []);
  assert.equal(isolated.errorLabel, "source 查询失败", "查询异常只输出固定类别 errorLabel");
  assert.ok(
    !isolated.errorLabel.includes("secret-token-do-not-display"),
    "不透传异常正文（可能含不可信秘密）",
  );

  const badShape = registry.sourceSnapshot("bash_async");
  assert.equal(badShape.availability, "unavailable");
  assert.match(badShape.errorLabel, /不符合协议/);

  // 健康 source 与聚合读取不受异常 source 影响。
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["subagent:1"],
  );
  assert.equal(registry.sourceFor("subagent:1"), healthy.source);

  // subscribe 抛错的 source 仍注册成功（替换同 kind 的坏形状 source，快照拉取不受影响）。
  registry.register(subscribeBroken.source);
  assert.equal(registry.sourceSnapshot("bash_async").availability, "available");
  subscribeBroken.setSnapshot({
    availability: "available",
    rows: [activityRow("bash_async", "bash_async:ok", "命令")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  assert.deepEqual(
    registry.snapshot().map((r) => r.key),
    ["subagent:1", "bash_async:ok"],
  );

  // 单个 registry 监听者抛错，不影响其他监听者与 source。
  let secondSeen = 0;
  registry.subscribe(() => {
    throw new Error("listener 爆炸");
  });
  registry.subscribe(() => {
    secondSeen += 1;
  });
  healthy.invalidate();
  assert.equal(secondSeen, 1, "异常监听者被隔离，其他监听者照常收到失效");
});

test("协议外 source 在注册边界 fail loud，不影响既有注册", () => {
  const registry = createActivityRegistry();
  const healthy = createFixtureSource("subagent", {
    availability: "available",
    rows: [],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  registry.register(healthy.source);
  assert.throws(
    () => registry.register({ kind: "unknown-kind", snapshot() {}, subscribe() {}, async detail() {} }),
    TypeError,
  );
  assert.throws(() => registry.register({ kind: "scheduler" }), TypeError);
  assert.equal(registry.sourceSnapshot("subagent").availability, "available", "既有注册不受影响");
});

test("raw 快照/行对象不被改写（不写回 source）", () => {
  const registry = createActivityRegistry();
  const frozenRow = activityRow("subagent", "subagent:1", "任务", "运行中");
  const frozenSnapshot = Object.freeze({
    availability: "available",
    rows: Object.freeze([frozenRow]),
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const fixture = createFixtureSource("subagent", frozenSnapshot);
  registry.register(fixture.source);

  const pulled = registry.sourceSnapshot("subagent");
  assert.ok(pulled === frozenSnapshot, "快照原对象透传，registry 不复制不写回");
  const rows = registry.snapshot();
  assert.ok(rows[0] === frozenRow, "行对象引用保持不变");
  assert.equal(registry.sourceFor("subagent:1"), fixture.source);
  assert.ok(Object.isFrozen(frozenSnapshot));
  assert.ok(Object.isFrozen(frozenSnapshot.rows));
  assert.ok(Object.isFrozen(frozenRow));
  assert.deepEqual(JSON.parse(JSON.stringify(rows)), [JSON.parse(JSON.stringify(frozenRow))]);

  fixture.setSnapshot(
    Object.freeze({
      availability: "stale",
      rows: Object.freeze([Object.freeze(activityRow("subagent", "subagent:1", "任务", "运行中"))]),
      observedAt: "2026-10-13T00:00:00.000Z",
    }),
  );
  assert.equal(registry.sourceSnapshot("subagent").availability, "stale", "读取不改写 availability");
  assert.deepEqual(registry.snapshot(), [], "stale 不进入聚合行");
});

test("dispose 幂等；关闭后 late invalidate/subscribe/register 无效果", () => {
  const registry = createActivityRegistry();
  const normal = createFixtureSource("subagent", {
    availability: "available",
    rows: [activityRow("subagent", "subagent:1", "任务")],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const leaky = createFixtureSource(
    "bash_async",
    { availability: "available", rows: [], observedAt: "2026-10-13T00:00:00.000Z" },
    { leakUnsubscribe: true },
  );
  registry.register(normal.source);
  registry.register(leaky.source);
  let invalidations = 0;
  registry.subscribe(() => {
    invalidations += 1;
  });

  registry.dispose();
  registry.dispose(); // 幂等
  assert.deepEqual(registry.snapshot(), []);
  assert.equal(registry.sourceSnapshot("subagent"), undefined);
  assert.equal(registry.sourceFor("subagent:1"), undefined);

  leaky.invalidate(); // 退订未生效的坏 source：closed 检查兜底
  assert.equal(invalidations, 0, "关闭后 late invalidate 无效果");
  const lateListen = registry.subscribe(() => {
    invalidations += 1;
  });
  leaky.invalidate();
  assert.equal(invalidations, 0);
  lateListen();

  const lateSource = createFixtureSource("scheduler", {
    availability: "available",
    rows: [],
    observedAt: "2026-10-13T00:00:00.000Z",
  });
  const disposeLate = registry.register(lateSource.source);
  assert.equal(lateSource.subscriptions, 0, "关闭后 register 不再订阅");
  assert.equal(registry.sourceSnapshot("scheduler"), undefined);
  disposeLate();
});
