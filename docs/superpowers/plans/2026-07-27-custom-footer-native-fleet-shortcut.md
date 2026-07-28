# 自定义 Footer 与原生 Subagent Inspector 兼容实施计划

> **状态：已废弃。** 真实 TUI 验收证明快捷键转发不可用，且用户明确改为 footer 驱动的只读 session viewport。后续以 `2026-07-27-footer-driven-subagent-session-viewport.md` 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `test-driven-development` 按任务逐项执行；任何 subagent 派发遵循项目的 subagent dispatch 约束。

**Goal:** 让 footer 只被动显示无前缀的活动 agent 名称，并用 `Alt+O` 替换 `Ctrl+Alt+F` 打开 `pi-subagents` 原生 inspector，其他浏览交互保持上游原样。

**Architecture:** `custom-footer.ts` 不实现 selector、main 数据源或 transcript viewer。它只消费公开 lifecycle events形成渲染摘要，并通过 terminal input rewrite 把 `Alt+O` 转成上游已注册的 `Ctrl+Alt+F` raw sequence。原生 persistent FleetView 继续关闭以避免布局冲突；原生 child-only inspector 继续负责列表、transcript、安全路径、刷新和退出。

**Tech Stack:** TypeScript Pi extension、Pi terminal input listener、pi-tui `matchesKey`、Node.js `node:test`、Jiti extension loader。

---

### Task 1: 固定被动摘要与快捷键转发契约

**Files:**
- Modify: `test/custom-footer-layout.test.mjs`
- Modify: `test/custom-footer-subagents.test.mjs`

- [ ] **Step 1: 固定 footer 无前缀渲染**

在 `test/custom-footer-layout.test.mjs` 的三行 footer 用例中，保持第二行左侧是 renderer provider 返回的纯文本，并把期望值固定为无 `subagents:`、无 glyph：

```js
getSubagentStatus: () => "executor, reviewer",
```

```js
const subagentStatus = "executor, reviewer";
assert.equal(
  lines[1],
  `${subagentStatus}${providerModel.padStart(58 - subagentStatus.length)}`,
);
```

- [ ] **Step 2: 让真实 extension fixture 捕获 terminal input listener**

在 `test/custom-footer-subagents.test.mjs` 的 mock UI 中保存 listener，并返回可验证的 unsubscribe：

```js
let terminalInput;
let terminalInputUnsubscribed = false;

onTerminalInput(handler) {
  terminalInput = handler;
  return () => {
    terminalInputUnsubscribed = true;
  };
},
```

fixture 返回 `getTerminalInput()` 和 `wasTerminalInputUnsubscribed()`，同时让 event bus mock 的 `on()` 返回真正的 unsubscribe。

- [ ] **Step 3: 固定 Alt+O 替换 Ctrl+Alt+F**

新增真实 extension 测试，直接使用 pi-tui 能识别的 legacy raw sequences：

```js
const subject = setupFooter();
const terminalInput = subject.getTerminalInput();

assert.deepEqual(terminalInput("\x1bo"), { data: "\x1b\x06" });
assert.deepEqual(terminalInput("\x1b\x06"), { consume: true });
assert.equal(terminalInput("x"), undefined);
```

这里 `\x1bo` 是 `Alt+O`，`\x1b\x06` 是 `Ctrl+Alt+F`。Alt+O 被改写后由 editor 的原生 extension-shortcut 分发继续调用 `pi-subagents` handler；物理 Ctrl+Alt+F 被消费，因此完成替换而不是增加第二套 inspector。

- [ ] **Step 4: 固定并发、run identity 与 reload**

扩展真实 extension 测试：

```js
asyncStart({ id: "run-1", agent: "executor", sessionId: "session-1" });
asyncStart({ id: "run-2", agent: "executor", sessionId: "session-1" });
asyncComplete({ runId: "run-1", sessionId: "session-1" });
assert.ok(subject.component.render(58)[1].startsWith("executor"));
asyncComplete({ runId: "run-2", sessionId: "session-1" });
assert.equal(subject.component.render(58)[1], providerModel.padStart(58));
```

用同时含两个字段的 payload 固定正式 identity：

```js
asyncStart({ id: "legacy-id", runId: "canonical-id", agent: "reviewer" });
asyncComplete({ id: "legacy-id", runId: "canonical-id" });
assert.equal(subject.component.render(58)[1], providerModel.padStart(58));
```

再创建旧、新两个 fixture，旧实例收到 async-started 后执行 `session_shutdown({ reason: "reload" })`；新实例必须立即显示该 agent，complete 后清空，最后以 `reason: "quit"` 清理全局 store。shutdown 后还要断言旧 event listener 和 terminal input listener 已注销。

- [ ] **Step 5: 运行 RED 并确认失败原因**

Run:

```bash
node --test test/custom-footer-layout.test.mjs test/custom-footer-subagents.test.mjs
```

Expected: FAIL；现有实现仍输出 `subagents:`，未注册 terminal input rewrite，reload 后新实例也无法看到活动 background run。不得接受 fixture 报错或语法错误作为 RED。

### Task 2: 实现兼容层

**Deps:** Task 1

**Files:**
- Modify: `pi/extensions/custom-footer.ts`
- Modify: `scripts/lib/custom-footer-layout.mjs`

- [ ] **Step 1: 删除 footer 固定前缀**

`createSubagentStatusState().label()` 只返回去重后的名称：

```ts
label() {
  const labels = [...new Set([...foreground.values(), ...background.values()].flat())];
  return labels.join(", ");
},
```

`createFooterComponent()` 第二行仍只调用 `layoutFooter()`，不增加 `main`、`⏺/◯/●` 或任何 selector 状态。MJS layout oracle 保持同一参数合同。

- [ ] **Step 2: 统一 async run identity**

增加唯一 helper，start/complete 都调用它：

```ts
function asyncRunId(event: any): string | undefined {
  const value = event?.runId ?? event?.id;
  return typeof value === "string" && value.trim() ? value : undefined;
}
```

`startAsync()` 和 `completeAsync()` 不再分别选择不同字段优先级。

- [ ] **Step 3: 建立 reload-safe background store**

把 background Map 放入版本化进程内 store，foreground Map 仍归当前 runtime：

```ts
type SubagentStatusStore = {
  background: Map<string, string[]>;
};

const SUBAGENT_STATUS_STORE = Symbol.for("pi-config.custom-footer.subagents.v1");

function getSubagentStatusStore(): SubagentStatusStore {
  const root = globalThis as typeof globalThis & {
    [SUBAGENT_STATUS_STORE]?: SubagentStatusStore;
  };
  return root[SUBAGENT_STATUS_STORE]
    ??= { background: new Map<string, string[]>() };
}
```

状态对象增加：

```ts
shutdown(preserveBackground: boolean) {
  foreground.clear();
  if (!preserveBackground) background.clear();
  onChange();
},
```

只有 `session_shutdown.reason === "reload"` 保留 background；`quit/new/resume/fork` 全部清空。

- [ ] **Step 4: 实现 Alt+O raw input rewrite**

从 pi-tui 增加 `Key` 与 `matchesKey` import，在 `session_start` 注册 listener：

```ts
let unsubscribeTerminalInput: (() => void) | undefined;

unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
  if (matchesKey(data, Key.alt("o"))) return { data: "\x1b\x06" };
  if (matchesKey(data, Key.ctrlAlt("f"))) return { consume: true };
  return undefined;
});
```

不要注册新的 inspector handler，不导入 `pi-subagents` 私有模块，不修改 `node_modules`。改写后的 `\x1b\x06` 继续进入 Pi editor 的 extension shortcut dispatcher，由上游 `Key.ctrlAlt("f")` handler 打开原生 inspector。

- [ ] **Step 5: 清理 runtime listener**

保存两个 `pi.events.on()` unsubscribe；shutdown 时先注销 event bus 和 terminal input listener，再按 reason 清理状态：

```ts
pi.on("session_shutdown", (event) => {
  for (const unsubscribe of eventUnsubscribes) unsubscribe();
  unsubscribeTerminalInput?.();
  unsubscribeTerminalInput = undefined;
  invalidateFooter = undefined;
  subagentStatus.shutdown(event.reason === "reload");
});
```

- [ ] **Step 6: 运行 GREEN**

Run:

```bash
node --test test/custom-footer-layout.test.mjs test/custom-footer-subagents.test.mjs
```

Expected: 全部 PASS；footer 无固定前缀和伪 selection glyph，Alt+O 转发到原生快捷键，物理 Ctrl+Alt+F 被消费，并发与 reload 生命周期正确。

### Task 3: 验证原生边界与回归

**Deps:** Task 2

**Files:**
- Modify: `docs/bugs/bug-custom-footer-subagent-renderer-diverges-native-fleet.md`

- [ ] **Step 1: 运行 footer 与 reload 回归集**

Run:

```bash
node --test \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/extension-reload-boundary.test.mjs \
  test/compact-tools-renderer.test.mjs \
  test/todo-compact-result.test.mjs
```

Expected: 全部 PASS，且无 warning/error 输出。

- [ ] **Step 2: 验证运行时配置没有恢复重复 surface**

确认 `pi/extensions/subagent/config.json` 保持：

```json
{
  "maxSubagentSpawnsPerSession": 10000,
  "fleetView": false,
  "asyncWidget": false
}
```

确认 package source 仍注册 `/subagents-fleet` 与 `Key.ctrlAlt("f")`。这两个断言是 Alt+O rewrite 的兼容门禁；若未来上游更改入口，测试必须失败而不是静默失效。

- [ ] **Step 3: 验证真实 SDK reload**

在 `~/mega-aone-service` 以 `PI_CODING_AGENT_DIR="$HOME/pi-config/pi"` 创建 in-memory session 并调用 `session.reload()`。Expected: `extensionErrors` 为空，reload 耗时保持亚秒级。

- [ ] **Step 4: 做一次真实 TUI 验收**

派发后台 `plan-reviewer`，确认 footer 第二行左侧显示 `plan-reviewer`，没有 `subagents:`、`main` 或圆点。按物理右 Option+O 打开原生 child-only inspector，确认 `↑/↓` 或 `j/k`、tool detail、refresh 和 `Esc` 都保持上游行为；物理 Ctrl+Alt+F 不再打开 inspector。run 完成后 footer 摘要清空。

iTerm2 前置条件：Right Option key 设置为 `Esc+`，Left Option key 保持 `Normal`。Pi 只识别 `alt+o`，无法从输入协议区分左右 Alt。

- [ ] **Step 5: 回填根因报告**

在 `docs/bugs/bug-custom-footer-subagent-renderer-diverges-native-fleet.md` 增加“验证结果”，记录聚焦测试数量、真实 reload 结果和 TUI 可视验收；明确 inspector 仍是原生 child-only overlay，`Esc` 返回 main，未新增任何 session 或 transcript 浏览逻辑。

- [ ] **Step 6: 检查变更质量**

Run:

```bash
git diff --check -- \
  pi/extensions/custom-footer.ts \
  scripts/lib/custom-footer-layout.mjs \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  docs/bugs/bug-custom-footer-subagent-renderer-diverges-native-fleet.md
```

Expected: 无输出。
