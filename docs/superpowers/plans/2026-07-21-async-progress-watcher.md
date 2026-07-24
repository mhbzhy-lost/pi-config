# Async Progress Watcher Extension 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编写 Pi extension，在父会话 idle 时也能实时显示 async subagent 的执行进度（turn 数、当前 tool、token 用量），解决"卡住无更新然后突然跳到完成"的体验问题。

**Architecture:** Extension 在 `session_start` 时启动，监听 `subagent:async-started` 事件获取活跃 run 列表，对每个 run 的 `events.jsonl` 做增量 tail（fs.watch + 5s poll fallback），解析新事件生成一行摘要，通过 `pi.sendMessage({ display: true }, { triggerTurn: false })` 推送到 TUI 显示。Run 完成后停止监听。

**Tech Stack:** TypeScript, Pi Extension API (`@earendil-works/pi-coding-agent`), Node.js fs.watch

---

## Execution Contract

```json
{"schemaVersion":"pi-plan.v1","verification":["node --test test/async-progress-watcher.test.mjs"],"requiredGates":["deterministic","plan-audit","external-review","final-completeness"]}
```

## 文件结构

```
pi/extensions/
├── async-progress-watcher.ts    # 新增：extension 主文件
test/
├── async-progress-watcher.test.mjs  # 新增：单元测试
```

---

### Task 1: 事件解析器（纯函数，可测试）

**Files:**
- Create: `pi/extensions/async-progress-watcher.ts`（仅解析器部分）
- Create: `test/async-progress-watcher.test.mjs`

- [ ] **Step 1: 编写失败测试——解析 events.jsonl 行生成摘要**

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";

// 测试 parseProgressEvents 函数：输入 events.jsonl 的新增行，输出摘要字符串
test("parseProgressEvents summarizes turn and tool activity", () => {
  const lines = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "tool_execution_start", tool: "bash" }),
    JSON.stringify({ type: "tool_execution_end", tool: "bash", durationMs: 3200 }),
    JSON.stringify({ type: "turn_end" }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.equal(result.summary, "turn 1 | bash (3.2s)");
  assert.equal(result.state.turnCount, 1);
});

test("parseProgressEvents handles message tokens", () => {
  const lines = [
    JSON.stringify({ type: "turn_start" }),
    JSON.stringify({ type: "message_end", usage: { totalTokens: 42000 } }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.match(result.summary, /turn 1/);
  assert.match(result.summary, /42k tok/);
});

test("parseProgressEvents returns null for no meaningful events", () => {
  const lines = [
    JSON.stringify({ type: "session_info_changed" }),
  ];
  const result = parseProgressEvents(lines, { turnCount: 0 });
  assert.equal(result, null);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test test/async-progress-watcher.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: 实现 parseProgressEvents**

在 `pi/extensions/async-progress-watcher.ts` 中实现：

```typescript
export interface ProgressState {
  turnCount: number;
  lastTool?: string;
  lastToolDurationMs?: number;
  totalTokens?: number;
}

export function parseProgressEvents(
  lines: string[],
  state: ProgressState
): { summary: string; state: ProgressState } | null {
  // 解析事件行，更新 state，生成摘要
  // 无有意义事件时返回 null
}
```

摘要格式：`turn N | tool (duration) | Nk tok`（各段按需出现）

- [ ] **Step 4: 运行测试确认通过**

Run: `node --test test/async-progress-watcher.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(extension): 实现 async progress 事件解析器"
```

---

### Task 2: 增量 tail 逻辑（fs.watch + poll fallback）

**Deps:** Task 1

**Files:**
- Modify: `pi/extensions/async-progress-watcher.ts`
- Modify: `test/async-progress-watcher.test.mjs`

- [ ] **Step 1: 编写失败测试——增量读取 events.jsonl 新行**

```javascript
test("tailEventsFile reads only new lines since last offset", async () => {
  const tmpFile = join(tmpdir(), `test-events-${Date.now()}.jsonl`);
  await writeFile(tmpFile, '{"type":"turn_start"}\n{"type":"turn_end"}\n');
  const { lines, offset } = await tailEventsFile(tmpFile, 0);
  assert.equal(lines.length, 2);
  // 追加新行
  await appendFile(tmpFile, '{"type":"turn_start"}\n');
  const result2 = await tailEventsFile(tmpFile, offset);
  assert.equal(result2.lines.length, 1);
  assert.ok(result2.offset > offset);
  await rm(tmpFile);
});
```

- [ ] **Step 2: 运行测试确认失败**

- [ ] **Step 3: 实现 tailEventsFile**

```typescript
export async function tailEventsFile(
  filePath: string,
  fromOffset: number
): Promise<{ lines: string[]; offset: number }> {
  // 从 fromOffset 读取文件新增内容，按行分割返回
}
```

- [ ] **Step 4: 运行测试确认通过**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(extension): 实现 events.jsonl 增量 tail"
```

---

### Task 3: Extension 主体（watcher 生命周期 + sendMessage 推送）

**Deps:** Task 1, Task 2

**Files:**
- Modify: `pi/extensions/async-progress-watcher.ts`

- [ ] **Step 1: 实现 extension 注册函数**

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function asyncProgressWatcher(pi: ExtensionAPI) {
  const watchers = new Map<string, { stop: () => void }>();

  pi.events.on("subagent:async-started", (event) => {
    const { runId, asyncDir } = event;
    if (!asyncDir || watchers.has(runId)) return;
    const eventsPath = join(asyncDir, "events.jsonl");
    const watcher = startWatching(eventsPath, (summary) => {
      pi.sendMessage(
        { customType: "async-progress", content: `[${runId.slice(0, 8)}] ${summary}`, display: true },
        { triggerTurn: false }
      );
    });
    watchers.set(runId, watcher);
  });

  pi.events.on("subagent:async-complete", (event) => {
    const watcher = watchers.get(event.runId);
    if (watcher) { watcher.stop(); watchers.delete(event.runId); }
  });

  pi.on("session_shutdown", () => {
    for (const [, w] of watchers) w.stop();
    watchers.clear();
  });
}
```

`startWatching` 使用 `fs.watch` + 5s `setInterval` fallback，每次 tick 调用 `tailEventsFile` + `parseProgressEvents`，有摘要时回调。

- [ ] **Step 2: 验证 extension 能被 Pi 加载**

Run: `node -e "import('./pi/extensions/async-progress-watcher.ts').then(m => console.log(typeof m.default))"`（或通过 jiti）
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(extension): async subagent 实时进度推送到 TUI"
```

---

### Task 4: 集成验证

**Deps:** Task 3

**Files:**
- Modify: `test/async-progress-watcher.test.mjs`

- [ ] **Step 1: 编写集成测试——模拟完整 watcher 生命周期**

```javascript
test("watcher delivers progress summary on events.jsonl update", async () => {
  // 创建临时 events.jsonl
  // 启动 watcher
  // 追加事件行
  // 等待回调触发
  // 断言收到摘要
  // 停止 watcher
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `node --test test/async-progress-watcher.test.mjs`
Expected: All pass

- [ ] **Step 3: 手动验证**

启动 Pi 会话，派发一个 async subagent，观察 idle 时是否能看到进度更新。

- [ ] **Step 4: Commit**

```bash
git commit -m "test(extension): async progress watcher 集成测试"
```
