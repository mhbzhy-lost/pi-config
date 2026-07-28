# Plan Runner 自建 Runtime 与 IR 层

> **状态：已被替代。** 后续执行以 `docs/superpowers/plans/2026-07-24-plan-runner-pi-subagents-parallel-harness.md` 为准；IR工作和薄Host进程监管保留，通用自建Executor Runtime方向废止。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Plan Runner 解除对 `pi-subagents` RPC 的依赖，自建最小子进程 runtime，引入 IR 层实现 DAG 并行派发，并提供 TUI 流式可观测。

**架构：** 新增 `scripts/lib/plan/runtime/` 模块直接 spawn pi 子进程（detached, stdio 落盘），新增 `scripts/lib/plan/ir/` 模块将 Plan Document 编译为 Frozen IR 并提供 frontier 计算。Launcher 和 Plan-Runner Dependencies 改为调用自建 runtime 而非 `subagents-rpc-client`。TUI 通过 Pi Extension widget API 读取子进程输出流展示进度。

**技术栈：** Node.js child_process, Pi Extension API (`ui.setWidget` / message renderer), 现有 plan-events / plan-projection / gates / workspace 模块不变。

**角色权限约束：**

| 角色 | Skills | Extensions | Tools |
|------|--------|------------|-------|
| Plan-Runner | 继承主 agent 所有 skill | 仅自建 runtime wrapper，**不加载 pi-subagents** | Pi 基础工具 + plan_open/plan_status/plan_continue/plan_verify/plan_block |
| Executor | 无 | 无（`--no-extensions`） | 仅 Pi 基础工具（read/bash/edit/write/grep/find/ls） |

---

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v1",
  "verification": [
    "node --test test/plan-ir.test.mjs",
    "node --test test/plan-runtime-spawn.test.mjs",
    "node --test test/plan-runtime-monitor.test.mjs",
    "node --test test/plan-runtime-control.test.mjs",
    "node --test test/plan-coordinator.test.mjs",
    "node --test test/plan-launcher-extension.test.mjs",
    "node --test test/plan-capsule-extension.test.mjs",
    "git diff --check"
  ],
  "requiredGates": [
    "deterministic",
    "plan-audit",
    "external-review",
    "final-completeness"
  ]
}
```

### Task 1: IR 编译器 — Plan Document → Frozen IR

**Files:**
- Create: `scripts/lib/plan/ir/compile.mjs`
- Create: `scripts/lib/plan/ir/frontier.mjs`
- Create: `scripts/lib/plan/ir/index.mjs`
- Create: `test/plan-ir.test.mjs`

IR 编译器接收 `parsePlanDocument` 的输出，产出不可变 Frozen IR 对象。包含：

- DAG 结构校验（无环、无悬空依赖、id 唯一、无 unreachable 节点）
- 规范化节点列表（确定性排序）
- `runnableFrontier(ir, completedSet)` — 返回所有 deps 已满足的节点集
- IR 对象结构预留 `hash`、`nodeFingerprints`、`declaredDeps` 字段（第一期为 `undefined`）

IR 类型形态：

```javascript
// Frozen IR
{
  version: "plan-ir.v1",
  nodes: [{ id, title, deps, files, agent }],
  edges: [{ from, to }],
  // 预留，第一期 undefined
  hash: undefined,
  nodeFingerprints: undefined,
  declaredDeps: undefined,
}
```

### Task 2: 自建 Runtime — spawn 模块

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/plan/runtime/spawn.mjs`
- Create: `test/plan-runtime-spawn.test.mjs`

核心职责：启动一个 detached pi 子进程，stdio 落盘，返回运行句柄。

接口：

```javascript
spawnPiAgent({
  task,              // 字符串，传给 pi -p
  systemPrompt,      // 文件路径或内联字符串 → --append-system-prompt
  model,             // 可选 → --model
  cwd,               // 工作目录
  skills,            // 可选 string[] → --skill
  extensions,        // 可选 string[] → --extension
  env,               // 额外环境变量
  runDir,            // 输出目录（stdout.jsonl / stderr.log / status.json）
}) → { pid, runDir, statusPath, stdoutPath, stderrPath }
```

实现要点：
- 使用 `child_process.spawn` + `detached: true` + `stdio` 重定向到 `runDir/stdout.jsonl` 和 `runDir/stderr.log`
- 子进程启动后立即写入 `runDir/status.json`：`{ state: "running", pid, startedAt }`
- 长 task 自动 spill 到临时文件（>4000 字符时用 `--prompt-file`）
- 设置 `PI_SUBAGENT_DEPTH` 环境变量
- 支持两种角色配置：
  - Plan-Runner：传入 `--skill` 继承主 agent skills，加载自建 runtime wrapper extension，**显式排除 pi-subagents**
  - Executor：传入 `--no-extensions --no-skills`，仅保留 Pi 默认基础工具，确保纯粹执行

### Task 3: 自建 Runtime — monitor 模块

**Deps:** Task 2

**Files:**
- Create: `scripts/lib/plan/runtime/monitor.mjs`
- Create: `test/plan-runtime-monitor.test.mjs`

核心职责：追踪子进程状态，提供轮询和事件通知接口。

接口：

```javascript
createMonitor(runDir, { pollIntervalMs = 200 }) → {
  state(),           // → "running" | "complete" | "failed" | "unknown"
  pid(),             // → number | null
  output(),          // → 最终 assistant 输出文本
  usage(),           // → { input, output, cost } 或 null
  waitForTerminal({ timeoutMs }) → Promise<"complete" | "failed" | "unknown">,
  dispose(),
}
```

实现要点：
- 解析 `stdout.jsonl`（Pi JSON mode 输出）提取最终 assistant message 和 usage
- PID 存活检测（`process.kill(pid, 0)` 或 `/proc` 检查）
- 子进程退出后根据 exit code 更新 `status.json`：`{ state: "complete"|"failed", exitCode, endedAt }`
- 子进程消失（crash）时标记 `{ state: "failed", reason: "process_disappeared" }`

### Task 4: 自建 Runtime — control 模块

**Deps:** Task 2

**Files:**
- Create: `scripts/lib/plan/runtime/control.mjs`
- Create: `test/plan-runtime-control.test.mjs`

核心职责：优雅终止子进程。

接口：

```javascript
stopAgent(pid, { graceMs = 5000 }) → Promise<"stopped" | "killed" | "already_dead">
interruptAgent(pid) → Promise<void>  // SIGINT
```

实现要点：
- `stopAgent`：SIGTERM → 等 graceMs → 若仍存活 SIGKILL
- `interruptAgent`：SIGINT（让 pi 优雅结束当前 turn）
- 处理进程已退出的边界（ESRCH）

### Task 5: 自建 Runtime — stream 模块（TUI 可观测）

**Deps:** Task 2, Task 3

**Files:**
- Create: `scripts/lib/plan/runtime/stream.mjs`
- Create: `scripts/lib/plan/runtime/index.mjs`

核心职责：从 `stdout.jsonl` 提取流式进度信息，供 TUI widget 消费。

接口：

```javascript
createOutputStream(runDir) → {
  tail(maxLines),      // → 最近 N 行结构化事件
  lastActivity(),      // → { timestamp, type, summary }
  onUpdate(callback),  // → 注册新行回调
  dispose(),
}
```

`runtime/index.mjs` 统一导出：

```javascript
export { spawnPiAgent } from "./spawn.mjs";
export { createMonitor } from "./monitor.mjs";
export { stopAgent, interruptAgent } from "./control.mjs";
export { createOutputStream } from "./stream.mjs";
```

### Task 6: Coordinator 并行派发重构

**Deps:** Task 1, Task 3

**Files:**
- Modify: `scripts/lib/plan/coordinator.mjs`
- Modify: `scripts/lib/plan/plan-graph.mjs`
- Modify: `test/plan-coordinator.test.mjs`

改动点：

1. `plan-graph.mjs` 新增 `runnableFrontier(projection)` — 返回所有可并行执行的 task 数组
2. `coordinator.mjs` 的 `authorizeNext()` 改为 `authorizeFrontier()` — 一次性产出多个 dispatch intent
3. 支持同时存在多个 `dispatch-requested` / `active` attempt（当前 `requestDispatch` 限制了只能有一个 active attempt，需要放开）
4. `plan-events.mjs` 放开 "active attempt already exists" 约束，改为基于 task 级别互斥（同一 task 不能有两个 active attempt，不同 task 可以并行）

### Task 7: Plan Launcher 重构 — 去除 subagents RPC

**Deps:** Task 2, Task 3, Task 4

**Files:**
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`
- Delete: `scripts/lib/subagents-rpc-client.mjs`（仅从 plan 路径移除引用，文件本身保留供其他模块使用时不删）
- Modify: `test/plan-launcher-extension.test.mjs`

改动点：

1. `launchPlan` 中的 `rpc().spawn(...)` 替换为 `spawnPiAgent({ task: bootstrap(...), systemPrompt: planRunnerEntry, cwd: worktree, extensions: [runtimeWrapper], ... })`
2. 去除 `waitForSessionFile` 对 `pi-subagents` asyncDir artifact 的依赖，改为从自建 runtime 的 `runDir/status.json` 读取
3. `stopRun` 中的 `rpc().stop()` 替换为 `stopAgent(pid)`
4. `plan-recover` / `plan-pause` 改用自建 runtime 的 monitor + control
5. handle 结构中 `asyncDir` 替换为 `runDir`（自建 runtime 的输出目录）

### Task 8: Plan Runner Dependencies 重构 — Executor 直接 spawn

**Deps:** Task 2, Task 3, Task 4, Task 6

**Files:**
- Modify: `scripts/lib/plan/plan-runner-dependencies.mjs`
- Modify: `scripts/lib/plan/plan-capsule-extension.mjs`
- Modify: `test/plan-capsule-extension.test.mjs`

改动点：

1. `continuePlan` 不再产出 `tool` 对象让 plan-runner agent 调用 `subagent` tool，而是直接调用 `spawnPiAgent` 派发 executor
2. 去除 `plan-capsule-extension.mjs` 中对 `tool_call`/`tool_result` 的 `subagent` 拦截逻辑
3. `handleNestedResult` 改为监听自建 runtime 的 monitor 事件
4. `defaultStopNestedRun` 从 `createSubagentsRpcClient(pi.events).stop()` 改为 `stopAgent(pid)`
5. `waitForRuntimeOutcome` 从读取 pi-subagents artifact 改为读取自建 runtime 的 `status.json`
6. 并行派发：`authorizeFrontier()` 返回多个 task 时，为每个 task spawn 独立 executor 子进程（`--no-extensions --no-skills`，纯基础工具执行者）

### Task 9: TUI Widget — Plan 执行进度可视化

**Deps:** Task 5, Task 7, Task 8

**Files:**
- Create: `scripts/lib/plan/tui/plan-widget.mjs`
- Modify: `scripts/lib/plan/plan-launcher-extension.mjs`

通过 Pi Extension `ui.setWidget()` API 注册一个 plan 执行状态 widget，展示：

- Plan 整体状态（running / verifying / blocked / validated）
- 每个活跃子进程（plan-runner + executors）的最新活动摘要
- 从 `createOutputStream` 读取各 `runDir` 的 tail 信息
- 子进程完成/失败时更新显示

Widget 注册在 `plan-launcher-extension.mjs` 的 `launchPlan` 成功后激活，plan 达到终态后清理。
