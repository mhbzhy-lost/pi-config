# Footer 原生 Child Conversation 浮窗实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `test-driven-development` 按任务逐项执行；所有 subagent 派发遵循项目的 dispatch 约束。步骤使用 checkbox（`- [ ]`）跟踪。

**Goal:** 将 footer child browser 改为 Pi 原生消息渲染的内部浮窗，使用 `↑/↓` 滚动、`←/→` 切换 child，并把活动任务与完成历史清晰分开。

**Architecture:** `status.json` 继续作为 child lifecycle 单一事实来源，同时读取其中的 `sessionFile`。优先通过 Pi 公开的 `SessionManager` 与 message components 只读渲染 child conversation；原有 `readFleetTranscript()` 保留为缺少或无法读取 `sessionFile` 时的安全 fallback。Overlay 只拥有当前屏幕和应用内滚动模型，不尝试替换 iTerm2 物理 scrollback。

**Tech Stack:** TypeScript Pi extension、Pi `SessionManager`/`sessionEntryToContextMessages`/原生 message components、pi-tui `Container` 与 overlay、pi-subagents 0.37.0 lifecycle artifacts、Node.js `node:test`、Jiti。

---

## 文件职责

- `pi/extensions/lib/subagent-session-browser.ts`：child lifecycle、active/recent 分区、稳定选择顺序与持久化。
- `pi/extensions/lib/subagent-native-conversation.ts`：可信 sessionFile 校验、Pi 原生只读 session 加载、主对话组件组合和 fingerprint cache。
- `pi/extensions/lib/pi-subagents-browser-adapter.ts`：`status.json` 与 Fleet transcript fallback 的安全边界。
- `pi/extensions/lib/subagent-session-viewport.ts`：独立于终端 scrollback 的逐行/逐页/Home/End 滚动模型与位置快照。
- `pi/extensions/custom-footer.ts`：浮窗生命周期、按键路由、active/history selector、native/fallback renderer 接线。
- `test/subagent-native-conversation.test.mjs`：原生渲染、安全和缓存测试。
- 现有 `test/subagent-session-*.test.mjs`、`test/custom-footer-*.test.mjs`：状态、viewport、input 和 extension lifecycle 回归。

### Task 1: 扩展 lifecycle roster 并区分 active/history

**Files:**
- Modify: `pi/extensions/lib/subagent-session-browser.ts`
- Modify: `test/subagent-session-browser.test.mjs`

- [ ] **Step 1: 写 sessionFile 与分区顺序的失败测试**

在 status reconciliation fixture 中加入 `sessionFile`，并固定 snapshot 合同：

```js
state.reconcileRun("run-active", {
  state: "running",
  steps: [{
    agent: "executor",
    status: "running",
    sessionFile: "/repo/var/sessions/run-active/session.jsonl",
    transcriptPath: "/repo/.pi-subagents/artifacts/active.jsonl",
  }],
});
state.reconcileRun("run-done", {
  state: "complete",
  steps: [{
    agent: "reviewer",
    status: "completed",
    sessionFile: "/repo/var/sessions/run-done/session.jsonl",
    transcriptPath: "/repo/.pi-subagents/artifacts/done.jsonl",
  }],
});

const snapshot = state.snapshot();
assert.deepEqual(snapshot.activeChildren.map((child) => child.agent), ["executor"]);
assert.deepEqual(snapshot.recentChildren.map((child) => child.agent), ["reviewer"]);
assert.equal(snapshot.children[0].agent, "executor");
assert.equal(snapshot.children[1].agent, "reviewer");
assert.equal(snapshot.recentChildren[0].sessionFile, "/repo/var/sessions/run-done/session.jsonl");
```

再固定：recent 按 run 新到旧排列；active 保持 workflow/启动顺序；`enter()` 优先第一个 active，没有 active 时选择最新 recent；selected terminal child 在 completion 后不被强制退出。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-session-browser.test.mjs
```

Expected: FAIL，提示 `activeChildren`/`recentChildren`/`sessionFile` 不存在或顺序不符。

- [ ] **Step 3: 实现最小分区合同**

扩展类型：

```ts
export interface BrowserChild {
  // existing fields
  sessionFile?: string;
}

export interface BrowserSnapshot {
  active: boolean;
  selectedKey?: string;
  children: BrowserChild[];
  activeChildren: BrowserChild[];
  recentChildren: BrowserChild[];
  selected?: BrowserChild;
}
```

`reconcileRun()` 从 `step.sessionFile` 读取字符串字段。新增私有排序方法，`children()` 返回 active runs 原顺序加 terminal runs 逆序；unknown 状态跟随 active 区但显示未知 glyph，避免永久隐藏。`snapshot()` 返回防御性拷贝。

- [ ] **Step 4: 修复 selected run 的冒号 ID 边界**

不要再通过 `selectedKey.split(":", 1)` 推导 runId，直接由 selected child 读取：

```ts
const selectedRunId = this.children().find((child) => child.key === this.selectedKey)?.runId;
```

加入包含 `:` 的 run ID 和 21 个 terminal runs 的测试，确认 selected run 不被 recent cap 淘汰。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/subagent-session-browser.test.mjs
```

Expected: 全部 PASS，原有 mixed terminal、delayed active、append-step 与 20-run cap 不回归。

### Task 2: 使用 Pi 原生 session/components 渲染 child conversation

**Files:**
- Create: `pi/extensions/lib/subagent-native-conversation.ts`
- Create: `test/subagent-native-conversation.test.mjs`
- Modify: `scripts/probes/pi-subagents-compat.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`

- [ ] **Step 1: 写真实 SessionManager fixture 的失败测试**

测试先调用 `initTheme("dark", false)`，用 `SessionManager.create()` 写入 user、含 thinking/text/toolCall 的 assistant 和对应 toolResult。期望新 renderer 使用主对话组件：

```js
const result = renderer.render({
  sessionFile,
  trustedRoots: [sessionDir],
  width: 80,
  cwd,
  markdownTheme: getMarkdownTheme(),
  ui: { requestRender() {} },
  expandedTools: false,
  hideThinking: false,
  outputPad: 1,
});
const plain = stripAnsi(result.lines.join("\n"));
assert.match(plain, /investigate child state/);       // initial user
assert.match(plain, /reasoning detail/);              // thinking
assert.match(plain, /Rendered heading/);              // assistant Markdown
assert.match(plain, /read/);                          // tool shell
assert.match(plain, /fixture output/);                 // tool result
assert.doesNotMatch(plain, /◆ Assistant|◇ Supervisor|├─/); // not Fleet rail
```

另建 compaction fixture，确认使用 `buildContextEntries()`，与 main rebuild 的 compaction-aware 语义一致。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-native-conversation.test.mjs
```

Expected: FAIL，因为模块不存在。

- [ ] **Step 3: 实现可信路径和 fingerprint**

导出一个有缓存的 renderer：

```ts
export type NativeConversationResult = {
  lines: string[];
  fingerprint?: string;
  warning?: string;
};

export class NativeChildConversationRenderer {
  constructor(dependencies?: {
    openSession?: typeof SessionManager.open;
  });
  render(options: {
    sessionFile: string;
    trustedRoots: string[];
    width: number;
    cwd: string;
    markdownTheme: MarkdownTheme;
    ui: { requestRender(): void };
    expandedTools: boolean;
    hideThinking: boolean;
    outputPad: number;
  }): NativeConversationResult;
  invalidate(): void;
}
```

读取前执行：final path `lstat` 必须为 regular file 且不是 symlink；`realpath` 必须位于至少一个 existing trusted root；文件最大 64 MiB；fingerprint 包含 `dev:ino:size:mtimeMs`。失败返回 warning，不读取外部文件。

- [ ] **Step 4: 用公开 Pi parser 构建 context items**

核心加载只能调用公开 API，不自行 `JSON.parse` session lines：

```ts
const manager = SessionManager.open(realPath);
const items = manager.buildContextEntries().flatMap((entry) =>
  entry.type === "custom" ? [entry] : sessionEntryToContextMessages(entry),
);
```

缓存 key 至少包含 realPath、fingerprint、width、`expandedTools`、`hideThinking`、`outputPad`、markdown theme identity。相同 key 返回已渲染行，不重复打开 session。构造器默认使用 `SessionManager.open`，测试通过注入 `openSession` 计数，不修改 ESM import。

- [ ] **Step 5: 组合与 main 相同的公开 components**

建立 `Container`，按 main 的 `renderSessionItems()` 顺序组合：

```ts
// user
container.addChild(new Spacer(1));
container.addChild(new UserMessageComponent(text, markdownTheme, outputPad));

// assistant
container.addChild(new AssistantMessageComponent(
  message,
  hideThinking,
  markdownTheme,
  "Thinking...",
  outputPad,
));

// toolCall
const tool = new ToolExecutionComponent(
  content.name,
  content.id,
  content.arguments,
  { showImages: false },
  undefined,
  ui,
  cwd,
);
tool.setExpanded(expandedTools);
container.addChild(tool);
pendingTools.set(content.id, tool);

// toolResult
pendingTools.get(message.toolCallId)?.updateResult(message);
```

同时覆盖 `bashExecution`、`custom`、`compactionSummary`、`branchSummary` 和 skill block，全部使用 Pi 根导出的公开 components/helpers。未知 custom renderer 使用 `CustomMessageComponent(..., undefined, ...)` 的 Markdown fallback。

- [ ] **Step 6: 写安全、partial write 与缓存测试**

覆盖 outside-root、final symlink、64 MiB 上限、末尾 partial JSON line、相同 fingerprint 只调用一次 `SessionManager.open()`、append 后 fingerprint 变化重新加载、width 或 expanded 变化重新渲染。

- [ ] **Step 7: 扩展兼容门禁**

在 probe 中断言当前 Pi 根入口存在：

```js
for (const capability of [
  "SessionManager",
  "sessionEntryToContextMessages",
  "AssistantMessageComponent",
  "UserMessageComponent",
  "ToolExecutionComponent",
]) {
  assert.equal(typeof piModule[capability], "function", capability);
}
```

先修改 test expectation 并观察 RED，再修改 probe 得到 GREEN。

- [ ] **Step 8: 运行 GREEN**

Run:

```bash
node --test test/subagent-native-conversation.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: 全部 PASS。

### Task 3: 将 viewport 改为完整应用内滚动模型

**Files:**
- Modify: `pi/extensions/lib/subagent-session-viewport.ts`
- Modify: `test/subagent-session-viewport.test.mjs`

- [ ] **Step 1: 写逐行、Home/End 和位置快照的失败测试**

```js
const viewport = new SubagentTranscriptViewport({
  getTerminalRows: () => 10,
  reservedBottomRows: 4,
  getLines: () => Array.from({ length: 30 }, (_, index) => `line ${index + 1}`),
  requestRender() {},
});
viewport.render(40);
assert.deepEqual(viewport.position(), { start: 25, end: 30, total: 30, autoFollow: true });
viewport.scrollLines(-1);
assert.deepEqual(viewport.position(), { start: 24, end: 29, total: 30, autoFollow: false });
viewport.scrollHome();
assert.equal(viewport.position().start, 1);
viewport.scrollEnd();
assert.equal(viewport.position().end, 30);
assert.equal(viewport.position().autoFollow, true);
```

再固定：空 transcript、内容缩短、切换 child 后 `resetScroll()`、manual scroll 时 append 不跳底、End 后 append 自动跟随。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/subagent-session-viewport.test.mjs
```

Expected: FAIL，提示 `scrollLines`、`scrollHome`、`scrollEnd` 或 `position` 不存在。

- [ ] **Step 3: 实现统一的滚动边界**

新增：

```ts
scrollLines(delta: number): void;
scrollPage(direction: -1 | 1): void;
scrollHome(): void;
scrollEnd(): void;
position(): { start: number; end: number; total: number; autoFollow: boolean };
```

所有方法共享 `maxStart = max(0, total - height)`。`scrollLines(-1)` 从 tail 向上移动一行并关闭 auto-follow；向下到 `maxStart` 恢复 auto-follow。位置采用 1-based 行号；空内容返回 `{ start: 0, end: 0, total: 0 }`。

- [ ] **Step 4: 运行 GREEN**

Run:

```bash
node --test test/subagent-session-viewport.test.mjs
```

Expected: 全部 PASS，包括原有 ANSI/CJK/emoji、transient failure 和 anchored page 测试。

### Task 4: 改造按键语义与 native/fallback 接线

**Deps:** Task 1, Task 2, Task 3

**Files:**
- Modify: `pi/extensions/custom-footer.ts`
- Modify: `test/custom-footer-input.integration.test.mjs`
- Modify: `test/custom-footer-subagents.test.mjs`

- [ ] **Step 1: 写新按键矩阵的真实 TUI RED 测试**

通过真实 `TUI.prototype.handleInput()` 固定：

```js
// Alt+O enters latest active child.
input(kittyAltOPress);
// Up/down scroll transcript; they no longer move child selection.
input(kittyUpPress);
input(kittyUpRelease);
input(kittyDownPress);
// Left/right move among children and reset scroll.
input(kittyRightPress);
input(kittyRightRelease);
input(kittyLeftPress);
// Page/Home/End own transcript position.
input(Key.pageUpSequence);
input(Key.homeSequence);
input(Key.endSequence);
// x toggles native tool expansion; ordinary input remains consumed.
input("x");
```

断言 `moveChild` 只收到 `[-1/1]` 的左右键，`scrollLines` 只收到上下 press/repeat，release 不执行，Page/Home/End 调用对应方法，所有 child-mode 输入不转发 editor。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/custom-footer-input.integration.test.mjs
```

Expected: FAIL，因为当前上下仍调用 child move，左右未处理。

- [ ] **Step 3: 修改 controller 合同**

```ts
createBrowserInputController({
  browser,
  enterBrowser,
  exitBrowser,
  moveChild,
  scrollLines,
  scrollPage,
  scrollHome,
  scrollEnd,
  toggleTools,
});
```

处理顺序：`Alt+O`；inactive passthrough；active release consume；Esc；Left/Right child；Up/Down 与 j/k line scroll；PageUp/PageDown；Home/End；`x`；最后消费未知输入。保留 Kitty press/repeat/release 语义：Alt+O repeat/release 不 toggle，浏览控制 release 不执行。

- [ ] **Step 4: 优先 native renderer，Fleet 作为 fallback**

`renderSelected()` 逻辑：

```ts
if (child.sessionFile) {
  const native = nativeRenderer.render({
    sessionFile: child.sessionFile,
    trustedRoots: browserTrustedSessionRoots(...),
    width,
    cwd: child.cwd,
    markdownTheme: getMarkdownTheme(),
    ui: overlayTui,
    expandedTools,
    hideThinking: false,
    outputPad: 1,
  });
  if (native.lines.length || !native.warning) return native.lines.length ? native.lines : ["[Waiting for child output]"];
}
return renderFleetFallback(child, width, theme);
```

`browserTrustedSessionRoots()` 只能包含 parent session file 的目录和 `PI_CODING_AGENT_SESSION_DIR`；不能把 status 提供的 child path 自身当 trusted root。Relative path 必须先相对 `asyncDir` 解析。

- [ ] **Step 5: 删除空白 viewport 与重复 warning**

Native/Fleet 两条路径返回 0 行时显示 `[Waiting for child output]`。上游 Fleet 已把 warning 渲染进 lines 时不再追加第二条 `[Warning: ...]`；只有 lines 为空时显示单条 warning。

- [ ] **Step 6: 接线 cache 和滚动位置**

Child 切换、`x`、theme/session start/shutdown 时调用 native renderer `invalidate()`；500ms poll 只 request render，fingerprint 不变时必须命中 cache。Footer 通过 `viewport?.position()` 读取行号，不反向修改 viewport。

- [ ] **Step 7: 运行 GREEN**

Run:

```bash
node --test test/custom-footer-input.integration.test.mjs test/custom-footer-subagents.test.mjs
```

Expected: 全部 PASS，draft、overlay、stale epoch、repeated start、rejection rollback 不回归。

### Task 5: Footer 仅展开 active，并折叠 history

**Deps:** Task 1, Task 4

**Files:**
- Modify: `pi/extensions/custom-footer.ts`
- Modify: `test/custom-footer-layout.test.mjs`
- Modify: `test/custom-footer-subagents.test.mjs`

- [ ] **Step 1: 写 selector RED 测试**

Main 模式期望：

```text
⏺ main  ◯ ● executor  ◯ history 2
```

Child 模式选中完成项期望：

```text
◯ main  ⏺ ✓ reviewer  ◯ ● executor  +1
```

失败项使用 `✗`，paused 使用 `Ⅱ`，stopped/detached 使用 `■`，unknown 使用 `?`。`⏺/◯` 只表示 viewport selection；`●/✓/✗/Ⅱ/■/?` 只表示 lifecycle。

测试覆盖窄宽度 selected glyph 保留、active child 优先、history count 不展开旧名称、selected history child 可见、CJK/emoji label 和多个 active children。

- [ ] **Step 2: 运行 RED**

Run:

```bash
node --test test/custom-footer-layout.test.mjs test/custom-footer-subagents.test.mjs
```

Expected: FAIL，因为 selector 未使用 state 分区。

- [ ] **Step 3: 实现 active/history selector**

Main 模式 items 为 `main + activeChildren + history count`。Browser 模式 items 为 `main + snapshot.children`，每个 child 带 lifecycle glyph；history count 不是可选择 child。现有 selected-window 算法继续保证当前 child 在窄终端可见。

- [ ] **Step 4: 在 child footer 显示滚动位置**

第一行右侧从单独 token 数改为：

```text
54.3k tokens · 120-139/434
```

auto-follow 在尾部仍显示最后区间；空 transcript 显示 `0/0`。宽度不足时先截断 token 文本，保留位置；main footer 保持原 context 百分比。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/custom-footer-layout.test.mjs test/custom-footer-subagents.test.mjs
```

Expected: 全部 PASS。

### Task 6: 生命周期、性能和真实 TUI 验收

**Deps:** Task 2, Task 3, Task 4, Task 5

**Files:**
- Modify: `test/extension-reload-boundary.test.mjs`
- Modify: `docs/bugs/bug-custom-footer-child-overlay-does-not-own-scrollback.md`
- Modify: `docs/bugs/bug-custom-footer-child-transcript-uses-fleet-inspector-renderer.md`
- Modify: `docs/bugs/bug-custom-footer-completed-children-look-active.md`
- Modify: `docs/bugs/bug-custom-footer-subagent-browser-uses-modal-inspector.md`

- [ ] **Step 1: 补 no-UI start 与完整 teardown 测试**

覆盖已有 UI session 后直接收到 `hasUI: false` start：旧 overlay、editor、timer、input、event listener、native cache 和 ctx 全部释放。覆盖 reload 保留 plain roster 但 renderer/cache 不跨 prototype，普通 new/resume/fork/quit 清 roster。

- [ ] **Step 2: 运行全部聚焦回归**

Run:

```bash
node --test \
  test/subagent-session-browser.test.mjs \
  test/subagent-native-conversation.test.mjs \
  test/pi-subagents-browser-adapter.test.mjs \
  test/subagent-session-viewport.test.mjs \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/custom-footer-input.integration.test.mjs \
  test/extension-reload-boundary.test.mjs \
  test/pi-subagents-compat.test.mjs \
  test/compact-tools-renderer.test.mjs \
  test/todo-compact-result.test.mjs
```

Expected: 全部 PASS，无 warning/error 输出。

- [ ] **Step 3: 验证缓存性能**

用包含至少 100 条 entries、thinking、20 个 tool calls 的 session fixture 连续渲染 100 次。断言 fingerprint 不变时 `SessionManager.open()` 只调用一次；本机 100 次 cache-hit 总耗时低于 100ms。Append 一条完整 entry 后只增加一次 open。

- [ ] **Step 4: 验证真实 SDK reload**

在 `~/mega-aone-service` 使用完整 `PI_CODING_AGENT_DIR` 连续执行两次 `session.reload()`：

```bash
PI_OFFLINE=1 PI_CODING_AGENT_DIR="$HOME/pi-config/pi" node <reload-probe>
```

Expected: `extensionErrors: []`，每次 reload 小于 1 秒；`fleetView=false`、`asyncWidget=false` 不变。

- [ ] **Step 5: 执行真实 iTerm2 验收**

派发两个 async children，至少一个包含 Markdown、thinking、read/bash 和多屏输出：

1. `Alt+O` 进入 active child，输入框消失，draft 保留。
2. `↑/↓` 逐行滚动，松开不重复；长按 repeat 连续滚动。
3. `←/→` 每次切换一个 child，滚动位置重置到该 child 尾部。
4. PageUp/PageDown、Home/End 覆盖从第一行到最新行；footer 行号同步。
5. Initial user、assistant Markdown、thinking、工具 shell 与 main 风格一致；`x` 展开/折叠工具有效。
6. Child 完成后 main footer 从 active 名称迁移到 `history N`；进入 history 显示 `✓/✗`。
7. iTerm2 物理 scrollback 仍属于 parent，这是已声明边界；不得出现 parent 内容透出当前 overlay。
8. `Alt+O`/Esc 返回 main，draft 原样恢复；reload 后回 main，无重复 listener/overlay。

- [ ] **Step 6: 回填验证证据并检查 diff**

在四份 bug 文档写入测试数、reload 耗时、cache probe 与 iTerm2 结果。运行：

```bash
git diff --check -- \
  pi/extensions/custom-footer.ts \
  pi/extensions/lib/subagent-session-browser.ts \
  pi/extensions/lib/subagent-native-conversation.ts \
  pi/extensions/lib/pi-subagents-browser-adapter.ts \
  pi/extensions/lib/subagent-session-viewport.ts \
  test/subagent-session-browser.test.mjs \
  test/subagent-native-conversation.test.mjs \
  test/pi-subagents-browser-adapter.test.mjs \
  test/subagent-session-viewport.test.mjs \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/custom-footer-input.integration.test.mjs
```

Expected: 无输出，退出码 0。

---

## 自检

- 规格覆盖：内部浮窗、上下滚动、左右切 child、分页与首尾跳转、Pi 原生格式、thinking/initial user、Fleet fallback、active/history、状态 glyph、缓存、reload 和真实 iTerm2 验收均有对应 Task。
- 占位符扫描：计划不含 `TBD`、未定义 helper 或“后续补充”步骤。
- 类型一致：`BrowserChild.sessionFile` 从 Task 1 贯穿 native renderer 与 footer；viewport position 与 Task 5 footer 合同一致；renderer expanded state 由 Task 4 的 `x` 单点拥有。
- 已知边界：不替换 iTerm2 物理 scrollback，不嵌套 alternate screen，不切换/恢复/修改 child session。

## 实施与验收进度

- 原 iTerm2 八项矩阵已由用户确认全部通过：切换、逐行/分页/Home/End、紧凑工具与 `x`、生命周期、draft 恢复和 reload listener 唯一性均正常。
- Amber/Cobalt 两个同为 delegate 的并发运行在重启后显示正确 start/completion title，没有串线。
- 最终扩大回归 158/158；fresh SDK create 373.2ms，reload 304.6ms/296.8ms，15 extensions，0 extension/runtime errors。
- 后续用户反馈已纳入：空闲 Footer 隐藏 history、移除不可选择 `main`、长 title 单项限 32 列、隐藏 thinking 正文、notify/status 选择性展示。
- 最终用户在 reload 后确认：空闲/活动 Footer 无 `main`，长 title 截断且 sibling 可见，thinking 正文隐藏且 Footer 保留 `thinking: xhigh`，紧凑 notify/status 均符合合同。计划完成。
