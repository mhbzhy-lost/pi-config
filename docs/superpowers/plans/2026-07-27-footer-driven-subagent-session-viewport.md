# Footer 驱动的 Subagent Session Viewport 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用 `test-driven-development` 按任务逐项执行；任何 subagent 派发遵循项目的 subagent dispatch 约束。

**Goal:** 用 footer 选择器控制输入框以上的只读 child transcript viewport；`Alt+O` 进入，`↑/↓` 切换 child，再次 `Alt+O` 或 `Esc` 返回 main，并在 child 模式完全隐藏输入框。

**Architecture:** custom footer 拥有唯一的浏览状态和键盘状态机。main 模式使用原 editor；child 模式安装保留草稿的零行 editor，并用 non-capturing 全宽 overlay 覆盖原 conversation viewport。async child roster 与 transcript 路径来自 `pi-subagents` 0.37.0 的公开 lifecycle event 和 `status.json`，transcript 解析/渲染复用上游安全实现；不调用 session switch、resume、steer 或其他 mutation API。

**Tech Stack:** TypeScript Pi extension、Pi `setEditorComponent`/`ui.custom`/`onTerminalInput`、pi-tui `TUI`/`CustomEditor`、pi-subagents lifecycle artifacts、Node.js `node:test`、Jiti。

---

### Task 1: 固定只读浏览状态机

**Files:**
- Create: `pi/extensions/lib/subagent-session-browser.ts`
- Create: `test/subagent-session-browser.test.mjs`

- [ ] **Step 1: 写 lifecycle roster 的失败测试**

创建 `test/subagent-session-browser.test.mjs`，通过 Jiti 导入真实 TypeScript 模块，固定 start payload、status reconciliation 和稳定 child key：

```js
const state = new SubagentSessionBrowserState();
state.trackStarted({
  id: "run-1",
  asyncDir: "/tmp/run-1",
  cwd: "/repo",
  sessionId: "parent-1",
  agents: ["executor", "reviewer"],
});
state.reconcileRun("run-1", {
  state: "running",
  steps: [
    { agent: "executor", status: "complete", transcriptPath: "/repo/.pi-subagents/artifacts/executor.jsonl" },
    { agent: "reviewer", status: "running", transcriptPath: "/repo/.pi-subagents/artifacts/reviewer.jsonl" },
  ],
});
assert.deepEqual(state.snapshot().children.map(({ key, agent, state }) => ({ key, agent, state })), [
  { key: "run-1:0", agent: "executor", state: "complete" },
  { key: "run-1:1", agent: "reviewer", state: "running" },
]);
```

- [ ] **Step 2: 写进入、切换和退出的失败测试**

```js
assert.equal(state.enter(), true);
assert.equal(state.snapshot().active, true);
assert.equal(state.snapshot().selectedKey, "run-1:0");

state.move(1);
assert.equal(state.snapshot().selectedKey, "run-1:1");
state.move(1);
assert.equal(state.snapshot().selectedKey, "run-1:0");
state.move(-1);
assert.equal(state.snapshot().selectedKey, "run-1:1");

state.exit();
assert.equal(state.snapshot().active, false);
assert.equal(state.snapshot().selectedKey, undefined);
```

再固定：没有 child 时 `enter()` 返回 false；completion 只更新状态、不删除 child；超过 20 个 recent runs 时淘汰最旧的非活动 run；被选 child 消失时退出到 main。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test test/subagent-session-browser.test.mjs
```

Expected: FAIL，提示模块或导出不存在；不得接受 fixture 语法错误作为 RED。

- [ ] **Step 4: 实现最小状态模型**

创建以下公开合同：

```ts
export interface BrowserChild {
  key: string;
  runId: string;
  index: number;
  agent: string;
  state: string;
  asyncDir: string;
  cwd: string;
  sessionId?: string;
  transcriptPath?: string;
  model?: string;
  thinking?: string;
  tokens?: number;
}

export interface BrowserSnapshot {
  active: boolean;
  selectedKey?: string;
  children: BrowserChild[];
  selected?: BrowserChild;
}

export class SubagentSessionBrowserState {
  trackStarted(event: unknown): void;
  reconcileRun(runId: string, status: unknown): void;
  trackCompleted(event: unknown): void;
  enter(): boolean;
  exit(): void;
  move(delta: -1 | 1): void;
  snapshot(): BrowserSnapshot;
  clear(options?: { preserveRuns?: boolean }): void;
}
```

`trackStarted()` 只接受非空 `id`、`asyncDir`、`cwd`；初始 children 取 `agents ?? [agent]`，key 为 `${runId}:${index}`。`reconcileRun()` 使用 structured status 的 `steps` 更新 label、state、transcriptPath、model、thinking 和 `tokens.total`。`move()` 只在 children 间循环，`main` 不进入 roster。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/subagent-session-browser.test.mjs
```

Expected: 全部 PASS。

### Task 2: 复用上游 transcript 安全边界

**Deps:** Task 1

**Files:**
- Create: `pi/extensions/lib/pi-subagents-browser-adapter.ts`
- Create: `test/pi-subagents-browser-adapter.test.mjs`
- Modify: `scripts/probes/pi-subagents-compat.mjs`
- Modify: `test/pi-subagents-compat.test.mjs`

- [ ] **Step 1: 写 status 与 transcript adapter 的失败测试**

在临时目录创建真实 `status.json` 和最小 transcript：

```js
await writeFile(join(asyncDir, "status.json"), JSON.stringify({
  runId: "run-1",
  state: "running",
  steps: [{
    agent: "executor",
    status: "running",
    transcriptPath,
    model: "codex-pool/gpt-5.6-sol:low",
    thinking: "low",
    tokens: { total: 1234 },
  }],
}));
await writeFile(transcriptPath, `${JSON.stringify({
  recordType: "message",
  role: "assistant",
  text: "child output",
})}\n`);

const status = readBrowserRunStatus(asyncDir);
assert.equal(status?.steps?.[0]?.agent, "executor");
const rendered = renderBrowserTranscript({
  transcriptPath,
  trustedRoots: [artifactsDir],
  width: 80,
  theme,
  markdownTheme,
});
assert.match(rendered.join("\n"), /child output/);
```

另加 symlink/outside-root 用例，期望 renderer 返回 warning 而不是读取外部内容。

- [ ] **Step 2: 写私有 API 兼容门禁的失败测试**

在 compat probe 中新增能力断言，而不是复制 parser：

```js
const transcriptModule = await jiti.import(
  join(packageRoot, "src/tui/fleet-transcript.ts"),
);
assert.equal(typeof transcriptModule.readFleetTranscript, "function");
assert.equal(typeof transcriptModule.renderFleetTranscript, "function");
```

adapter 还应使用 `src/shared/artifacts.ts` 的 `getArtifactsDir()` 计算 trusted root；probe 同时断言该导出存在。修改测试期望后先运行并确认 RED。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test test/pi-subagents-browser-adapter.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: FAIL，因为 adapter 与新增 probe capability 尚不存在。

- [ ] **Step 4: 实现 adapter**

导出以下最小 API：

```ts
export function readBrowserRunStatus(asyncDir: string): unknown | undefined;

export function browserTrustedRoots(options: {
  asyncDir: string;
  runCwd: string;
  parentCwd: string;
  parentSessionFile: string | null;
}): string[];

export function renderBrowserTranscript(options: {
  transcriptPath: string;
  trustedRoots: string[];
  width: number;
  theme: ExtensionContext["ui"]["theme"];
  markdownTheme: MarkdownTheme;
  expandedTools?: boolean;
}): { lines: string[]; warning?: string };
```

`readBrowserRunStatus()` 只读取 `${asyncDir}/status.json`，限制 2 MiB，JSON root 必须为 object。`browserTrustedRoots()` 返回去重后的 `asyncDir`、run cwd 和 parent cwd 对应的 `getArtifactsDir()`。`renderBrowserTranscript()` 调用上游 `readFleetTranscript()` 与 `renderFleetTranscript()`，不自行拼接 session JSONL。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/pi-subagents-browser-adapter.test.mjs test/pi-subagents-compat.test.mjs
```

Expected: 全部 PASS。

### Task 3: 实现无输入框的 child viewport

**Deps:** Task 2

**Files:**
- Create: `pi/extensions/lib/subagent-session-viewport.ts`
- Create: `test/subagent-session-viewport.test.mjs`

- [ ] **Step 1: 写 read-only editor 的失败测试**

```js
const editor = new ReadOnlyBrowserEditor(tui, editorTheme, keybindings);
editor.setText("unsent parent draft");
assert.deepEqual(editor.render(80), []);
editor.handleInput("x");
assert.equal(editor.getText(), "unsent parent draft");
```

该组件必须继承 `CustomEditor` 以满足 `setEditorComponent()` 合同，但 `render()` 返回零行，`handleInput()` 不修改草稿。

- [ ] **Step 2: 写 viewport 完全覆盖和滚动的失败测试**

```js
const viewport = new SubagentTranscriptViewport({
  getTerminalRows: () => 24,
  reservedBottomRows: 4,
  getLines: () => ["line 1", "line 2"],
  requestRender: () => {},
});
const lines = viewport.render(80);
assert.equal(lines.length, 20);
assert.ok(lines.every((line) => visibleWidth(line) === 80));
viewport.scrollPage(-1);
```

再固定 auto-follow：未手动滚动时取 transcript tail；PageUp 后保持 scroll offset；新输出到达不强制跳回底部；PageDown 到底后恢复 auto-follow。

- [ ] **Step 3: 运行 RED**

Run:

```bash
node --test test/subagent-session-viewport.test.mjs
```

Expected: FAIL，因为组件尚不存在。

- [ ] **Step 4: 实现组件**

```ts
export class ReadOnlyBrowserEditor extends CustomEditor {
  override render(_width: number): string[] { return []; }
  override handleInput(_data: string): void {}
}

export class SubagentTranscriptViewport implements Component {
  render(width: number): string[];
  scrollPage(direction: -1 | 1): void;
  resetScroll(): void;
  invalidate(): void;
  dispose(): void;
}
```

viewport 高度为 `Math.max(1, terminalRows - reservedBottomRows)`；每行使用 `visibleWidth()` 与空格补齐，确保底下的 main conversation 不透出。不要在 component 内创建 timer，refresh 由 controller 单一拥有。

- [ ] **Step 5: 运行 GREEN**

Run:

```bash
node --test test/subagent-session-viewport.test.mjs
```

Expected: 全部 PASS。

### Task 4: 把 footer、键盘、editor 和 overlay 接成一个 owner

**Deps:** Task 1, Task 2, Task 3

**Files:**
- Modify: `pi/extensions/custom-footer.ts`
- Modify: `scripts/lib/custom-footer-layout.mjs`
- Modify: `test/custom-footer-layout.test.mjs`
- Modify: `test/custom-footer-subagents.test.mjs`
- Create: `test/custom-footer-input.integration.test.mjs`

- [ ] **Step 1: 写 footer selector 的失败测试**

main 模式固定：

```js
getSubagentSelector: () => "⏺ main  ◯ executor  ◯ reviewer",
```

child 模式固定：

```js
getSubagentSelector: () => "◯ main  ◯ executor  ⏺ reviewer",
```

selected child 必须始终出现在窄终端可见窗口内；隐藏项显示 `+N`，不得换行或改变三行 footer 高度。右侧在 child 模式显示 status 中的 child model/thinking，第一行显示 child cwd 和 token total；main 模式保持当前 context/provider/model/thinking。

- [ ] **Step 2: 写真实 TUI input chain 的失败测试**

使用真实 `TUI`，而不是直接调用 listener：

```js
const tui = new TUI({ width: 80, height: 24 });
tui.requestRender = () => {};
const forwarded = [];
tui.setFocus({ render: () => [], handleInput: (data) => forwarded.push(data) });
tui.addInputListener(controller.handleTerminalInput);

// Legacy Esc+ encoding
TUI.prototype.handleInput.call(tui, "\x1bo");
assert.equal(browser.snapshot().active, true);
assert.deepEqual(forwarded, []);

browser.exit();
// Kitty keyboard protocol encoding
TUI.prototype.handleInput.call(tui, "\x1b[111;3u");
assert.equal(browser.snapshot().active, true);
```

浏览态继续断言：`down/up` 切换 selectedKey；`pageUp/pageDown` 调 viewport；再次 legacy/Kitty `Alt+O` 或 `Esc` 退出；任意 printable、paste、Enter 和 Ctrl+Alt+F 都不进入隐藏 editor。

- [ ] **Step 3: 写 editor/overlay 生命周期失败测试**

扩展现有真实 extension fixture，捕获 `getEditorComponent()`、`setEditorComponent()`、`ui.custom()` 和 overlay `done`：

```js
ctx.ui.setEditorText("unsent parent draft");
subject.pressAltO();
assert.equal(subject.currentEditorFactory, ReadOnlyBrowserEditorFactory);
assert.equal(subject.overlayOptions.overlay, true);
assert.equal(subject.overlayOptions.overlayOptions.nonCapturing, true);
assert.deepEqual(subject.overlayComponent.render(80).length, 20);

subject.pressEscape();
assert.equal(subject.currentEditorFactory, originalEditorFactory);
assert.equal(ctx.ui.getEditorText(), "unsent parent draft");
assert.equal(subject.overlayClosed, true);
```

测试 session shutdown、reload、new/resume 都先退出 child mode、关闭 overlay、恢复原 editor、清 timer/listener；reload 允许 roster store 保留，但新 runtime 必须从 main 开始并通过 status.json 对账，覆盖 reviewer 指出的 completion handoff gap。

- [ ] **Step 4: 运行 RED**

Run:

```bash
node --test \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/custom-footer-input.integration.test.mjs
```

Expected: FAIL；当前实现仍返回 raw `Ctrl+Alt+F`，没有 child viewport、hidden editor 或 footer selection glyph。

- [ ] **Step 5: 实现 controller 集成**

删除以下旧逻辑：

```ts
if (matchesKey(data, Key.alt("o"))) return { data: "\x1b\x06" };
if (matchesKey(data, Key.ctrlAlt("f"))) return { consume: true };
```

替换为直接状态机：

```ts
if (matchesKey(data, Key.alt("o"))) {
  browser.snapshot().active ? exitBrowser() : enterBrowser();
  return { consume: true };
}
if (!browser.snapshot().active) return undefined;
if (matchesKey(data, Key.escape)) {
  exitBrowser();
  return { consume: true };
}
if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
  browser.move(-1);
  refreshSelectedChild();
  return { consume: true };
}
if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
  browser.move(1);
  refreshSelectedChild();
  return { consume: true };
}
if (matchesKey(data, Key.pageUp)) viewport?.scrollPage(-1);
else if (matchesKey(data, Key.pageDown)) viewport?.scrollPage(1);
return { consume: true };
```

`enterBrowser()` 保存 `ctx.ui.getEditorComponent()`，安装 `ReadOnlyBrowserEditor`，调用：

```ts
void ctx.ui.custom(
  (tui, theme, _keybindings, done) => {
    closeOverlay = () => done(undefined);
    viewport = new SubagentTranscriptViewport({
      getTerminalRows: () => tui.terminal.rows,
      reservedBottomRows: 4,
      getLines: () => renderSelectedTranscript(theme),
      requestRender: () => tui.requestRender(),
    });
    return viewport;
  },
  {
    overlay: true,
    overlayOptions: {
      row: 0,
      col: 0,
      width: "100%",
      maxHeight: "100%",
      margin: { bottom: 4 },
      nonCapturing: true,
    },
  },
);
```

`exitBrowser()` 先关闭 overlay，再恢复保存的 editor factory，重置 selection/scroll 并刷新 footer。500ms 单一 timer 读取 tracked runs 的 status.json、更新 transcript fingerprint 和请求 render。

- [ ] **Step 6: 运行 GREEN**

Run:

```bash
node --test \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/custom-footer-input.integration.test.mjs
```

Expected: 全部 PASS；不再存在 raw shortcut rewrite。

### Task 5: 回归与真实 TUI 验收

**Deps:** Task 4

**Files:**
- Modify: `docs/bugs/bug-custom-footer-subagent-browser-uses-modal-inspector.md`

- [ ] **Step 1: 运行完整聚焦回归**

Run:

```bash
node --test \
  test/subagent-session-browser.test.mjs \
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

Expected: 全部 PASS，无 warning/error。

- [ ] **Step 2: 验证真实 SDK reload**

在 `~/mega-aone-service` 使用 `PI_CODING_AGENT_DIR="$HOME/pi-config/pi"` 创建 in-memory session 并调用 `session.reload()`。Expected: `extensionErrors: []`，reload 保持亚秒级。

- [ ] **Step 3: 验证运行时 surface 配置**

`pi/extensions/subagent/config.json` 继续保持 `fleetView: false`、`asyncWidget: false`。`/subagents-fleet` 保留为上游诊断后备，但 custom footer 不注册或转发其 shortcut。

- [ ] **Step 4: 做真实 iTerm2 验收**

派发至少两个并行 async children，确认：

1. main 模式输入框存在，footer 显示 `⏺ main` 与 children。
2. 右 `Option+O` 后输入框消失，main conversation 被 selected child transcript 完全覆盖。
3. `↑/↓` 在 children 间切换，footer selection glyph 与 transcript 同步。
4. 普通字符、Enter、paste 和 Ctrl+Alt+F 在 child 模式不会发送到任何 session。
5. 再次右 `Option+O` 或 `Esc` 后 main conversation、原输入框和未提交草稿恢复。
6. child 输出增长时 viewport 自动跟随；PageUp 后保持位置，PageDown 回到底部恢复跟随。
7. `/reload` 后从 main 开始，active/recent children 通过 artifacts 恢复，不出现 stale agent。

- [ ] **Step 5: 回填验证证据**

在 bug 文档增加测试数量、SDK reload 耗时和真实 TUI 结果；明确只读边界：实现没有调用 session switch/resume/steer，foreground child 不纳入 alternate viewport。

- [ ] **Step 6: 检查变更质量**

Run:

```bash
git diff --check -- \
  pi/extensions/custom-footer.ts \
  pi/extensions/lib/subagent-session-browser.ts \
  pi/extensions/lib/pi-subagents-browser-adapter.ts \
  pi/extensions/lib/subagent-session-viewport.ts \
  scripts/lib/custom-footer-layout.mjs \
  test/subagent-session-browser.test.mjs \
  test/pi-subagents-browser-adapter.test.mjs \
  test/subagent-session-viewport.test.mjs \
  test/custom-footer-layout.test.mjs \
  test/custom-footer-subagents.test.mjs \
  test/custom-footer-input.integration.test.mjs \
  docs/bugs/bug-custom-footer-subagent-browser-uses-modal-inspector.md
```

Expected: 无输出。
