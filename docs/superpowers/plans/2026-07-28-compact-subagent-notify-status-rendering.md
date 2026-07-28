# Subagent 通知与状态紧凑渲染实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `test-driven-development` 按任务逐项执行。Steps 使用 checkbox（`- [ ]`）跟踪。

**Goal:** 在不修改 Subagent 原始消息、RPC 回复、tool details 和 session 数据的前提下，让 TUI 通知只显示 title 与完成状态，让 status 查询只显示状态摘要。

**Architecture:** 新增无 UI 依赖的纯格式化模块，从现有 `subagent-notify` content/details 和 status tool result 中选择展示字段。`subagent-runtime.ts` 使用 Pi 公共 `registerMessageRenderer` 与项目自有 tool `renderResult` 生成紧凑 `Text` 组件；数据生产、title registry、RPC bridge、上游 notifier 和 session 持久化保持不变。

**Tech Stack:** TypeScript、Pi Extension API、`@earendil-works/pi-tui` `Text`、Node.js `node:test`、Jiti、Pi SDK reload probe。

---

### Task 1: 固定纯格式化合同

**Files:**
- Create: `scripts/lib/subagent-dispatch/compact-rendering.ts`
- Create: `test/subagent-compact-rendering.test.mjs`
- Create: `docs/bugs/bug-subagent-notify-and-status-render-full-payload.md`

- [x] **Step 1: 写通知 RED 测试**

测试单条、失败和 grouped 通知；输入包含完整 result preview 与 session 行，但期望只保留 title 和状态：

```js
const message = {
  customType: "subagent-notify",
  content: [
    "Background task completed: **delegate** [Cobalt title verification]",
    "",
    "COBALT_RUN_OK",
    "",
    "Session file: /tmp/session.jsonl",
  ].join("\n"),
  details: { titles: ["Cobalt title verification"] },
};

assert.equal(
  formatCompactSubagentNotification(message),
  "✓ Cobalt title verification · completed",
);
assert.doesNotMatch(formatCompactSubagentNotification(message), /COBALT|Session file|delegate/);
```

Grouped 通知期望每个 title 一行；`failed` 使用 `✗`，`paused` 使用 `Ⅱ`。没有 title metadata 时只回退 first-line 中的 agent，不读取 result body 猜身份。

- [x] **Step 2: 写 status RED 测试**

```js
const result = {
  content: [{ type: "text", text: "Run: run-1\nState: running\nDir: /tmp/run-1\nLog: /tmp/log" }],
  details: { mode: "single", results: [] },
};

assert.equal(
  formatCompactSubagentToolResult(result, { action: "status", id: "run-1" }),
  "Status: running",
);
```

再覆盖 `State: complete`、`Active async runs: 2`、`No active async runs.` 和错误结果。对非 status action，函数返回原始文本。调用前后深比较 message/result，证明格式化不修改数据源。

- [x] **Step 3: 运行 RED**

Run:

```bash
node --test test/subagent-compact-rendering.test.mjs
```

Expected: FAIL，原因是 `compact-rendering.ts` 尚不存在；不得接受语法或 fixture 错误。

- [x] **Step 4: 实现最小纯函数**

导出：

```ts
export function formatCompactSubagentNotification(message: {
  content?: unknown;
  details?: unknown;
}): string;

export function formatCompactSubagentToolResult(
  result: { content?: unknown; isError?: boolean },
  args: { action?: unknown },
): string;
```

通知状态只从首行匹配：

```ts
/^(?:Background tasks?|Detached foreground task) (completed|failed|paused)/
```

优先读取 `details.titles`；缺失时从首行的 `[title]` 回退，再缺失时读取首行 `**agent**`。status 只选择 `^State:`、`^Active async runs:`、`^No active async runs\.$`；错误输出统一为 `Status: error`。函数不写入输入对象。

- [x] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/subagent-compact-rendering.test.mjs
```

Expected: 全部 PASS。

### Task 2: 限制单个 Footer title 的显示预算

**Deps:** Task 1

**Files:**
- Modify: `pi/extensions/custom-footer.ts`
- Modify: `test/custom-footer-subagents.test.mjs`
- Create: `docs/bugs/bug-custom-footer-long-subagent-title-pollution.md`

- [x] **Step 1: 写 Footer RED 测试**

构造 100 列 selector：第一个 active child 使用超过 100 字符的 title，第二个使用 `Short check`，并保留一个 terminal run。期望输出同时包含截断后的第一项、第二项和 `history 1`：

```js
const before = structuredClone(snapshot);
const selector = formatBrowserSelector(snapshot, 100);
assert.match(selector, /This is an accidentally verbose… \(delegate\)/);
assert.match(selector, /Short check \(executor\)/);
assert.match(selector, /history 1/);
assert.deepEqual(snapshot, before);
```

Child 模式另断言长 title 仍保留 `›` 和 lifecycle glyph，完整 title 仍存在于 snapshot。

- [x] **Step 2: 运行 RED**

Run:

```bash
node --test test/custom-footer-subagents.test.mjs
```

Expected: FAIL；当前首项会占满 100 列，第二项和 history 不可见。

- [x] **Step 3: 实现单项可见列上限**

在 `custom-footer.ts` 定义：

```ts
const MAX_SELECTOR_TITLE_WIDTH = 32;
```

`selectorChild()` 只对可见 title 调用：

```ts
const title = child.label
  ? truncateToWidth(child.label, MAX_SELECTOR_TITLE_WIDTH, "…")
  : undefined;
const label = title ? `${title} (${child.agent})` : child.agent;
```

不得写回 `child.label`，不得截断 roster、event 或 status 数据。

- [x] **Step 4: 运行 GREEN**

Run:

```bash
node --test test/custom-footer-subagents.test.mjs test/subagent-session-browser.test.mjs
```

Expected: 全部 PASS；长 title、第二个 active child 和 history 可同时展示。

### Task 3: 接入 Pi 可见层

**Deps:** Task 1

**Files:**
- Modify: `pi/extensions/subagent-runtime.ts`
- Modify: `scripts/lib/subagent-dispatch/extension.ts`
- Modify: `test/subagent-runtime-membrane.test.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`

- [x] **Step 1: 写 renderer wiring RED**

在 membrane 测试向 `createTypedSubagentExtension()` 注入 `renderSubagentResult`，断言注册出的项目自有 `subagent` tool 保留同一个 renderer 引用。扩展 fresh SDK 测试，断言：

```js
assert.equal(typeof result.session.getToolDefinition("subagent").renderResult, "function");
assert.ok(
  result.session.resourceLoader.getExtensions().extensions
    .some((extension) => extension.messageRenderers.has("subagent-notify")),
);
```

- [x] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-runtime-membrane.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: FAIL，因为 tool 尚未接收 renderer，runtime 尚未注册 message renderer。

- [x] **Step 3: 给项目自有 tool 注入 renderer**

`createTypedSubagentExtension()` 增加可选参数 `renderSubagentResult`，构造 tool 时只在它是函数时附加：

```ts
...(typeof renderSubagentResult === "function"
  ? { renderResult: renderSubagentResult }
  : {}),
```

`installHeadlessTypedSubagentRuntime()` 继续通过现有 options 透传。不得让 upstream headless tool 获得注册权限，不修改 `rpcResult()` 或 execute 返回值。

- [x] **Step 4: 注册 production renderer**

`subagent-runtime.ts` 从 `@earendil-works/pi-tui` 导入 `Text`。message renderer 忽略 expanded 状态，始终返回紧凑通知；tool renderer 仅对 status 使用紧凑摘要，其他 action 仍渲染原始 text：

```ts
pi.registerMessageRenderer("subagent-notify", (message, { outputPad }, theme) =>
  new Text(theme.fg("dim", formatCompactSubagentNotification(message)), outputPad, 0),
);

const renderSubagentResult = (result, _options, theme, context) =>
  new Text(
    theme.fg(result.isError ? "error" : "dim", formatCompactSubagentToolResult(result, context.args)),
    0,
    0,
  );
```

不得把完整 content/details 附加到 expanded 分支。

- [x] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/subagent-runtime-membrane.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: 全部 PASS；项目工具仍只有 `subagent` 与 `subagent_supervisor`，无 upstream 资源泄漏。

### Task 4: 回归、reload 与真实 TUI 验收

**Deps:** Task 2, Task 3

**Files:**
- Modify: `docs/bugs/bug-subagent-notify-and-status-render-full-payload.md`
- Modify: `.state/goal-contract/goals/footer-native-child-conversation/evidence.jsonl`
- Modify: `.state/goal-contract/goals/footer-native-child-conversation/progress.md`
- Modify: `.state/goal-contract/goals/footer-native-child-conversation/recovery.md`
- Modify: `.state/goal-contract/goals/footer-native-child-conversation/state.json`
- Modify: `.state/goal-contract/goals/footer-native-child-conversation/feature-list.json`

- [x] **Step 1: 运行聚焦回归**

Run:

```bash
node --test \
  test/subagent-compact-rendering.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/subagent-title-registry.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/subagent-session-browser.test.mjs \
  test/custom-footer-input.integration.test.mjs
```

Expected: 全部 PASS，无 warning/error。

- [x] **Step 2: 运行 fresh 双 reload**

在 `/Users/leshi.zhy/mega-aone-service` 使用 `PI_OFFLINE=1` 与 `PI_CODING_AGENT_DIR=/Users/leshi.zhy/pi-config/pi` 创建独立 SDK session，连续调用两次 `session.reload()`。

Expected: 每次小于 1 秒，`extensionErrors` 与 runtime errors 都为空；`subagent` 有 `renderResult`，extension registry 含 `subagent-notify` message renderer。

- [x] **Step 3: 检查 diff 与 Doctor**

Run:

```bash
npm run doctor
git diff --check -- \
  pi/extensions/subagent-runtime.ts \
  scripts/lib/subagent-dispatch/extension.ts \
  scripts/lib/subagent-dispatch/compact-rendering.ts \
  test/subagent-compact-rendering.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/pi-subagents-compat.test.mjs \
  docs/bugs/bug-subagent-notify-and-status-render-full-payload.md
```

Expected: Doctor 只有已知 limitation warning；diff check 无输出。

- [x] **Step 4: 执行真实 TUI 验收**

reload 后派发一个带 title 的短 `delegate`：

1. 完成通知只显示 `title + completed/failed/paused`，不显示 agent、result preview、session file 或 handoff path。
2. 调用 `subagent({ action: "status", id: runId })`，tool result 只显示 `Status: <state>`；展开后仍不打印完整诊断。
3. Agent 仍能从 tool result details 使用 runId、路径和结构化状态；child browser 仍能读取原 session。
4. 同时确认 Footer 不再显示不可选择的 `main`，单个长 title 不会遮蔽其他 Child/history，主对话 thinking 正文隐藏但 Footer 保留 `thinking: xhigh`。

- [x] **Step 5: 回填证据**

把测试数、双 reload 耗时和用户确认写入 bug 文档与 goal-contract。只有真实 TUI 四项都通过后才把最终验证任务和 goal 标记 complete。

---

## 自检

- 规格覆盖：通知、status 和长 Footer title 三个显示面分别有纯函数或 renderer 边界、数据不变测试和真实 TUI 验收。
- 占位符扫描：无 `TBD`、未定义 helper 或“后续补充”步骤。
- 类型一致：两个 formatter 的签名在测试、runtime 和 tool renderer 中一致；`renderSubagentResult` 只从 install options 透传到项目自有 tool。
- 边界：不修改 upstream `pi-subagents`、RPC、session JSONL、原始 message/tool content/details，不恢复 upstream widget，不提交或暂存工作区。

## 实施结果

- 计划聚焦回归 96/96，扩大回归 158/158。
- fresh SDK create 373.2ms，双 reload 304.6ms/296.8ms，15 extensions，0 extension/runtime errors。
- 用户以 runs `51135a2c-9ca6-4134-9d45-69d8af9389ff` 和 `a2de5989-4a15-4834-945f-102f424d53dc` 完成 final iTerm2 验收：Footer 长 title/sibling、无 `main`、status 折叠/展开、completion 紧凑显示、thinking 隐藏与 `xhigh` indicator 全部通过。
