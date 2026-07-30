# Pi Interactive Stderr Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Pi TUI 活跃期间阻止裸 `stderr` 直接写入终端，同时保留结构化消息流和可追查的诊断日志。

**Architecture:** 本地 extension 只在 `ExtensionContext.mode === "tui"` 时安装进程级 stderr guard。Guard 使用 `Symbol.for` 状态跨 extension reload 维持单一 writer，普通 stderr 写入轮转文件；release 或 uncaught exception 前恢复原始 writer，使正常退出与致命错误仍能在 TUI 停止后输出。

**Tech Stack:** TypeScript、Pi Extension API、Node.js `process.stderr` / `EventEmitter` / `fs`、Node 内置 test runner、Jiti。

---

## Execution Contract

```json
{"schemaVersion":"pi-plan.v1","verification":["node --test test/interactive-stderr-guard.test.mjs","node --test test/extension-reload-boundary.test.mjs","npm test"],"requiredGates":["deterministic","external-review","final-completeness"]}
```

## 文件结构

```text
.gitignore                             # 修改：排除本地 stderr 诊断日志
pi/extensions/
├── interactive-stderr-guard.ts       # 新增：Pi 生命周期注册与 TUI mode 门禁
└── lib/
    └── interactive-stderr-guard.ts   # 新增：进程级 guard、owner 协议和轮转日志
test/
└── interactive-stderr-guard.test.mjs # 新增：guard、reload、fatal、日志和 extension 契约
```

本计划不自动创建 git commit；当前工作区已有与本任务无关的用户改动，执行时只修改上述文件和根因文档。

### Task 1: 固定进程级 stderr guard 契约

**Files:**
- Create: `test/interactive-stderr-guard.test.mjs`
- Create: `pi/extensions/lib/interactive-stderr-guard.ts`

- [x] **Step 1: 编写失败测试，证明裸 stderr 当前仍会触达原始 writer**

测试通过 Jiti 导入预期 API，并构造带 `stderr` 与 `uncaughtException` 事件能力的 fake host：

```javascript
const release = installInteractiveStderrGuard({
  host,
  writeLog(chunk) { captured.push(chunk.toString("utf8")); },
});

let callbackCalled = false;
host.stderr.write("hidden", "utf8", () => { callbackCalled = true; });
await new Promise((resolve) => setImmediate(resolve));

assert.deepEqual(originalWrites, []);
assert.deepEqual(captured, ["hidden"]);
assert.equal(callbackCalled, true);
release();
host.stderr.write("visible");
assert.deepEqual(originalWrites, ["visible"]);
```

同一 RED 阶段再增加两个独立测试：第二个 owner 接管后旧 owner 的 `release()` 不得恢复 writer；触发 `uncaughtException` 时 guard 必须先恢复，使随后注册的 Pi crash handler 写入原始 stderr。

- [x] **Step 2: 运行聚焦测试并确认按预期失败**

Run: `node --test test/interactive-stderr-guard.test.mjs`

Expected: FAIL，原因是 `pi/extensions/lib/interactive-stderr-guard.ts` 或 `installInteractiveStderrGuard` 尚不存在，而不是测试装配错误。

- [x] **Step 3: 实现最小 guard**

在 `pi/extensions/lib/interactive-stderr-guard.ts` 导出：

```typescript
export interface StderrGuardHost {
  stderr: { write: NodeJS.WriteStream["write"] };
  prependListener(event: "uncaughtException", listener: (error: unknown) => void): unknown;
  removeListener(event: "uncaughtException", listener: (error: unknown) => void): unknown;
}

export function installInteractiveStderrGuard(options: {
  host?: StderrGuardHost;
  writeLog(chunk: Buffer): void;
}): () => void;
```

实现要求：

```typescript
const STATE_KEY = Symbol.for("pi-config.interactive-stderr-guard.v1");

// state 存在 host 上而不是模块全局，确保 Jiti reload 后仍只有一层 wrapper。
// 每次 install 生成新 owner；只有当前 owner 的 release 可以恢复原始 writer。
// guarded write 把 string/Uint8Array 规范化为 Buffer，调用 writeLog，并异步调用原 callback。
// writeLog 失败时不得 fallback 到原始 stderr；callback 接收该 Error，布局仍保持完整。
// uncaughtException listener 使用 prependListener，先 restore，再让 Pi 已有 crash handler 打印。
```

- [x] **Step 4: 运行聚焦测试确认 GREEN**

Run: `node --test test/interactive-stderr-guard.test.mjs`

Expected: PASS，且测试进程 stderr 没有 `hidden` 文本。

### Task 2: 增加轮转日志和 extension 生命周期

**Deps:** Task 1

**Files:**
- Modify: `.gitignore`
- Modify: `test/interactive-stderr-guard.test.mjs`
- Modify: `pi/extensions/lib/interactive-stderr-guard.ts`
- Create: `pi/extensions/interactive-stderr-guard.ts`

- [x] **Step 1: 编写失败测试固定日志和 mode 门禁**

增加以下测试：

```javascript
test("rotating sink keeps stderr diagnostics out of the terminal", () => {
  const sink = createRotatingStderrSink({ logPath, maxBytes: 32, now: () => fixedDate });
  sink(Buffer.from("first diagnostic\n"));
  sink(Buffer.from("second diagnostic exceeds the active file\n"));
  assert.match(readFileSync(logPath, "utf8"), /second diagnostic/);
  assert.match(readFileSync(`${logPath}.1`, "utf8"), /first diagnostic/);
});

test("extension installs only for tui sessions and releases on shutdown", () => {
  registerInteractiveStderrGuard(pi, dependencies);
  handlers.session_start({ reason: "startup" }, { mode: "rpc" });
  assert.equal(installs, 0);
  handlers.session_start({ reason: "startup" }, { mode: "tui" });
  assert.equal(installs, 1);
  handlers.session_shutdown({ reason: "quit" }, { mode: "tui" });
  assert.equal(releases, 1);
});
```

- [x] **Step 2: 运行聚焦测试并确认 RED**

Run: `node --test test/interactive-stderr-guard.test.mjs`

Expected: FAIL，缺少 `createRotatingStderrSink`、`registerInteractiveStderrGuard` 或 extension 入口。

- [x] **Step 3: 实现日志 sink 与 extension 入口**

在 lib 文件导出同步、无终端 fallback 的轮转 sink：

```typescript
export function createRotatingStderrSink(options: {
  logPath: string;
  maxBytes?: number;
  now?: () => Date;
}): (chunk: Buffer) => void;
```

每次写入增加 ISO 时间戳；活动文件加本次记录将超过上限时，将旧文件原子重命名为 `.1`，最多保留一份历史。单条超大诊断也必须裁剪到上限内；日志目录和文件权限分别固定为 `0700` 与 `0600`。目录创建、stat、rename、append、chmod 的失败由 sink 内部吞掉，不允许错误处理再次写 stderr；`.gitignore` 排除 `/pi/logs/`。

在 `pi/extensions/interactive-stderr-guard.ts` 中实现并导出可注入依赖的注册函数：

```typescript
export function registerInteractiveStderrGuard(
  pi: ExtensionAPI,
  dependencies = defaultDependencies,
): void;

export default registerInteractiveStderrGuard;
```

`session_start` 先释放本 extension 先前 owner；仅 `ctx.mode === "tui"` 时安装。默认日志路径为 `${PI_CODING_AGENT_DIR ?? ~/.pi/agent}/logs/interactive-stderr.log`。`session_shutdown` 始终释放当前 owner。

- [x] **Step 4: 运行聚焦测试和 reload 边界测试**

Run: `node --test test/interactive-stderr-guard.test.mjs`

Expected: PASS。

Run: `node --test test/extension-reload-boundary.test.mjs`

Expected: PASS，新增 extension 不引入 reload-sensitive `.mjs` 依赖。

### Task 3: 验证完整配置且不修改消息流

**Deps:** Task 1, Task 2

**Files:**
- Modify only if a test reveals a defect: `pi/extensions/interactive-stderr-guard.ts`
- Modify only if a test reveals a defect: `pi/extensions/lib/interactive-stderr-guard.ts`
- Modify only if a test reveals a missing contract: `test/interactive-stderr-guard.test.mjs`

- [x] **Step 1: 运行 extension 加载探针**

Run:

```bash
PI_CODING_AGENT_DIR="$PWD/pi" node --input-type=module -e '
import { createJiti } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const jiti = createJiti(import.meta.url, { moduleCache: false, alias: { "@earendil-works/pi-coding-agent": "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js" } });
const mod = await jiti.import("./pi/extensions/interactive-stderr-guard.ts");
if (typeof mod.default !== "function") process.exit(1);
'
```

Expected: exit 0，无 stderr 输出。

- [x] **Step 2: 运行全量测试**

Run: `npm test`

Expected: PASS；若存在与本任务无关的既有失败，记录准确测试名并保持本任务聚焦测试全绿，不修改无关文件。

- [x] **Step 3: 检查最终 diff 和日志边界**

Run: `git diff --check`

Expected: exit 0。

Run: `git diff -- .gitignore docs/bugs/bug-raw-stderr-corrupts-pi-tui.md docs/superpowers/plans/2026-07-30-interactive-stderr-guard.md pi/extensions/interactive-stderr-guard.ts pi/extensions/lib/interactive-stderr-guard.ts test/interactive-stderr-guard.test.mjs`

Expected: 只有本任务文档、guard、entry 和测试；没有修改 `pi-subagents` 安装目录或全局 Pi dist。
