# Pi 独立计划执行仓与 Subagent RPC Migration Implementation Plan

> **供执行代理使用：** 每项逻辑变更必须先加载 `test-driven-development`，严格按复选框逐项执行。未经用户单独授权，不创建 Git commit。

**目标：** 使用 `pi-subagents@0.34.0` 承载 executor/reviewer 子会话，并在独立 Pi Plan Session 中封装一个计划从批准到 `validated` 的完整生命周期，使主 Agent 只负责启动和观察，不参与计划执行或完成判定。

**架构：** 主会话通过薄 Launcher 创建专属 Git worktree，并经 stable RPC v1 异步启动一个只执行该计划的 Plan Session。Plan Session 中的 Control Plane Extension 以 Pi custom session entries 保存计划领域事件，通过 child-safe nested `subagent` 工具执行 worker，并以 `pi-subagents` lifecycle artifacts 作为 attempt 的运行时事实源；所有 Gate 绑定同一 `baseCommit..headCommit`，只有全部 Gate 对同一 `validatedHead` 通过时才允许成功结束。

**技术栈：** Pi `0.80.6` Extension API、`pi-subagents@0.34.0` stable RPC v1、Node.js `22.19+`、TypeScript Extension 入口、ESM JavaScript 领域模块、Node 内置 test runner、Git worktree。

---

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v1",
  "verification": [
    "npm test",
    "npm run doctor",
    "PI_REAL_BIN=\"$(command -v pi)\" npm run test:integration",
    "PI_REAL_BIN=\"$(command -v pi)\" npm run test:subagents",
    "PI_REAL_BIN=\"$(command -v pi)\" npm run test:plan",
    "uv run --no-project --with httpx --with python-dotenv --with pyyaml python -m unittest discover -s skill-overrides/external-llm-review/tests",
    "git diff --check"
  ],
  "requiredGates": ["deterministic", "plan-audit", "external-review", "final-completeness"]
}
```

## 架构边界

### 必须保持的不变量

1. 一个 Plan Session 只执行一个已批准计划；计划由规范化内容的 SHA-256 固定。
2. 主 Agent 不执行计划任务、不写计划状态、不判定 `validated`；只保存 `planId`、Plan Session 和只读状态入口。
3. 一个计划拥有一个独立 worktree、一个 immutable `baseCommit` 和一个当前 `headCommit`。
4. v1 在单个执行仓内只允许一个 mutating attempt；多个计划可通过不同 worktree 并行。计划内部 DAG 决定串行拓扑顺序，不实现并行写合并。
5. Plan 领域状态的唯一事实源是 Plan Session 中 `customType: "pi-plan-event-v1"` 的 append-only entries。
6. executor 的 PID、running/failed、token、transcript 和 output 只从 `pi-subagents` artifacts 投影，不复制成第二套 job 状态。
7. Gate 结果不可变，并绑定 `inputHead`；任何后续文件或 HEAD 变化都会使旧 Gate 失效。
8. `validated` 只能由 deterministic、plan audit、external review 和 final completeness 全部通过后产生；失败或 unavailable 禁止 fail-open。
9. Plan Session 的成功结果只允许对应 `validated`。异常退出记录为 `interrupted`，等待决策记录为 `blocked`，用户终止记录为 `cancelled`。
10. 合回 origin 不属于 `validated`；只能由用户或主会话在验证后显式执行。
11. Plan Runner 只有在 `/plan-run` 时得到明确授权，才可在专属 `pi-plan/<planId>` 分支创建实现 commit；该授权不包含合回、push 或修改 origin 工作区。

### 明确不做

- 不移植 `plan-runner-harness.js` 的 JSON 索引、wake prompt、idle 推断、文件轮询或 fail-open 重试。
- 不实现新的子进程、PID、队列、transcript 或 token runtime。
- 不解析 `subagent` 工具或 TUI 的格式化文本。
- 不把计划领域事件保存在 Parent Session。
- 不允许普通 executor/reviewer 递归派生 Subagent。
- 不自动复制 OpenCode auth，不记录 token，不启用 `share: true`。
- 不在 v1 实现计划内并行写、自动 rebase、自动合回 origin 或跨进程 daemon。
- 不假设 child-safe nested extension 暴露完整 RPC bridge；RPC 只用于 Parent 启动和控制顶层 Plan Session。

## 文件结构

| 路径 | 职责 |
|---|---|
| `scripts/probes/pi-subagents-compat.mjs` | 隔离安装和兼容性硬门禁 |
| `test/pi-subagents-compat.test.mjs` | probe 命令构造和结果判定单元测试 |
| `test/pi-subagents-runtime.integration.mjs` | 真实 Pi、RPC、Plan child、nested safety 集成测试 |
| `scripts/lib/subagents-rpc-client.mjs` | stable RPC v1 的超时、校验和 listener 清理 |
| `scripts/lib/plan/plan-document.mjs` | 解析计划 Task、Deps、Files 和验证命令，生成 canonical hash |
| `scripts/lib/plan/plan-graph.mjs` | DAG 校验、环检测和确定性 runnable 计算 |
| `scripts/lib/plan/plan-events.mjs` | append-only 领域事件 schema 和 reducer |
| `scripts/lib/plan/plan-projection.mjs` | 从 session entries 与 artifacts 生成只读状态投影 |
| `scripts/lib/plan/workspace.mjs` | origin/worktree/base/head 所有权和 Git 边界 |
| `scripts/lib/plan/runtime-artifacts.mjs` | 读取并校验 `status.json`、`events.jsonl` 和 transcript 引用 |
| `scripts/lib/plan/coordinator.mjs` | 串行 DAG 调度、nested tool attempt 绑定和恢复决策 |
| `scripts/lib/plan/gates.mjs` | deterministic/audit/external/final GateAttempt |
| `scripts/lib/plan/plan-capsule-extension.mjs` | Plan Session tools、hooks、completion guard 和 widget |
| `scripts/lib/plan/plan-launcher-extension.mjs` | Parent Session 启动、查询、暂停、恢复和取消入口 |
| `pi/extensions/plan-capsule.ts` | Plan Session Extension 入口 |
| `pi/extensions/plan-launcher.ts` | Parent Session Launcher 入口 |
| `pi/agents/plan-runner.md` | 独立计划协调 Agent profile |
| `pi/agents/plan-reviewer.md` | 只读计划符合性 reviewer profile |
| `skill-overrides/plan-runner-dispatch/SKILL.md` | 主 Agent 的计划执行入口规范 |
| `skill-overrides/subagent-dispatch/SKILL.md` | 普通 executor/spark 的 RPC 调度规范 |
| `docs/pi-plan-execution-capsule.md` | 生命周期、恢复、Gate scope 和运维说明 |

### Task 1：建立 Pi 0.80.6 与 pi-subagents 0.34.0 兼容性硬门禁

**Files:**
- Create: `scripts/probes/pi-subagents-compat.mjs`
- Create: `test/pi-subagents-compat.test.mjs`
- Create: `test/pi-subagents-runtime.integration.mjs`
- Modify: `test/package-scripts.test.mjs`
- Modify: `package.json`

- [ ] **Step 1：先写 probe 判定的失败测试**

在 `test/pi-subagents-compat.test.mjs` 覆盖以下输入：Pi 版本不是 `0.80.6`、RPC ping 缺少任一 stable method、Plan child 未加载 sentinel Extension、普通 child 可见 `subagent`、Plan child 无法嵌套 spawn、nested tool result 缺少结构化 run/artifact details、`stop` 未进入终态。导出并断言统一结果：

```javascript
assert.deepEqual(evaluateCompatibility(fixture), {
  ok: false,
  failures: ["missing RPC method: stop"],
});
```

Run: `node --test test/pi-subagents-compat.test.mjs`

Expected: FAIL，提示 `scripts/probes/pi-subagents-compat.mjs` 不存在。

- [ ] **Step 2：实现无副作用的结果判定器**

`scripts/probes/pi-subagents-compat.mjs` 导出：

```javascript
export const REQUIRED_METHODS = ["ping", "status", "spawn", "interrupt", "stop"];
export function evaluateCompatibility(report) {
  const failures = [];
  if (report.piVersion !== "0.80.6") failures.push(`unexpected Pi version: ${report.piVersion}`);
  for (const method of REQUIRED_METHODS) {
    if (!report.rpcMethods.includes(method)) failures.push(`missing RPC method: ${method}`);
  }
  if (!report.planExtensionLoaded) failures.push("Plan child did not load plan-capsule extension");
  if (!report.planChildNestedSpawn) failures.push("Plan child cannot spawn an authorized nested worker");
  if (!report.nestedResultHasDetails) failures.push("nested subagent result lacks structured lifecycle details");
  if (report.workerCanSpawn) failures.push("ordinary worker can recursively spawn subagents");
  if (!report.stopReachedTerminalState) failures.push("stop did not reach a terminal artifact state");
  return { ok: failures.length === 0, failures };
}
```

Run: `node --test test/pi-subagents-compat.test.mjs`

Expected: PASS。

- [ ] **Step 3：实现隔离真实 probe**

Probe 必须使用 `mkdtemp()` 创建临时 package root，运行：

```bash
npm install --prefix "$TEMP_PACKAGE_ROOT" --ignore-scripts pi-subagents@0.34.0
```

然后保持正式 `PI_CODING_AGENT_DIR="$repoRoot/pi"`，以显式 `--no-extensions -e "$TEMP_PACKAGE_ROOT/node_modules/pi-subagents" --no-skills --no-prompt-templates --no-themes` 启动真实 Pi。这样只读使用 Pi `/login` 已管理的 auth，不复制凭据，也不把社区包写入正式配置。验证：RPC `ping`、async `spawn`、artifact 生成、Plan child 显式 Extension sentinel、授权 Plan child 的一次 nested spawn、nested tool result 的结构化 details、普通 worker 无 `subagent`、`interrupt` 和 `stop`。finally 只删除临时 package root；缺少 OpenAI 登录时以 `OpenAI Pi login required; run /login openai` 阻塞，禁止读取或输出 key。

- [ ] **Step 4：运行真实兼容性门禁**

Run:

```bash
PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs
```

Expected: 全部 PASS，并在测试输出中确认 `pi=0.80.6`、`pi-subagents=0.34.0`、RPC protocol `1`。若 Plan child 无法显式加载 Extension、无法安全 nested spawn，或 nested result 没有可用于 attempt 绑定的结构化 details，立即停止整个计划，不进入 Task 2，也不开发替代 Subagent runtime。

- [ ] **Step 5：增加独立 package script**

先修改 `test/package-scripts.test.mjs` 期望，再把 `package.json` scripts 增加：

```json
"test:subagents": "node --test test/pi-subagents-runtime.integration.mjs"
```

Run: `node --test test/package-scripts.test.mjs`

Expected: PASS。

### Task 2：固定社区包安装并扩展 doctor

**Deps:** Task 1

**Files:**
- Modify: `init-pi.sh`
- Modify: `scripts/doctor.mjs`
- Modify: `test/init-pi.test.mjs`
- Modify: `test/doctor.test.mjs`

- [ ] **Step 1：先写版本与安装契约测试**

要求 `init-pi.sh` 在正式 `PI_CODING_AGENT_DIR` 执行精确命令 `pi install npm:pi-subagents@0.34.0`，doctor 报告 package 缺失、版本不是 `0.34.0`、RPC probe 失败三类问题。测试不得断言或输出任何凭据。

Run: `node --test test/init-pi.test.mjs test/doctor.test.mjs`

Expected: FAIL，缺少 package 安装与检查。

- [ ] **Step 2：最小修改初始化入口**

在 `init-pi.sh` 固定：

```bash
PI_SUBAGENTS_VERSION="0.34.0"
PI_CODING_AGENT_DIR="$SCRIPT_DIR/pi" "$pi_binary" install "npm:pi-subagents@$PI_SUBAGENTS_VERSION"
```

安装发生在单元测试和真实 integration 之前；不得加 `--ignore-scripts` 绕过 Pi package manager 的正常安装契约。

- [ ] **Step 3：doctor 检查精确版本和必要入口**

`inspectWhitelist()` 重命名为 `inspectConfiguration()`，除现有 Skill 检查外，读取 Pi package metadata，并报告：

```text
missing Pi package: pi-subagents@0.34.0
unexpected pi-subagents version: <actual>; expected 0.34.0
```

Run: `node --test test/init-pi.test.mjs test/doctor.test.mjs`

Expected: PASS。

### Task 3：实现 stable RPC v1 Client

**Deps:** Task 1

**Files:**
- Create: `scripts/lib/subagents-rpc-client.mjs`
- Create: `test/subagents-rpc-client.test.mjs`

- [ ] **Step 1：先写 reply、超时和 dispose 测试**

测试 fake EventBus，覆盖先注册 reply listener 再 emit request、错误 envelope、5 秒超时、重复 reply 只结算一次、dispose 后无残留 listener。公开接口固定为：

```javascript
const client = createSubagentsRpcClient(pi.events, { timeoutMs: 5000, randomUUID });
await client.ping();
await client.spawn({ agent: "executor", task: "run", cwd: "/repo", async: true });
client.dispose();
```

Run: `node --test test/subagents-rpc-client.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现 versioned envelope**

Client 只允许 `ping/status/spawn/interrupt/stop`，请求格式固定为：

```javascript
{
  version: 1,
  requestId,
  method,
  params,
  source: { extension: "pi-plan-capsule" },
}
```

使用 `events.on(replyChannel, handler)` 返回的 unsubscribe；timeout、reply、dispose 三条路径都必须清 timer 和 listener。`spawn` 强制 `async: true`、`clarify: false`，拒绝 `action`。

Run: `node --test test/subagents-rpc-client.test.mjs`

Expected: PASS。

### Task 4：删除自研 Task 7 runtime 并迁移普通 Agents

**Deps:** Task 2, Task 3

**Files:**
- Delete: `scripts/lib/subagent-jobs.mjs`
- Delete: `scripts/lib/subagent-extension.mjs`
- Delete: `scripts/lib/subagent-agents.mjs`
- Delete: `pi/extensions/subagent.ts`
- Delete: `test/subagent-jobs.test.mjs`
- Delete: `test/subagent-extension.test.mjs`
- Delete: `test/subagent-agents.test.mjs`
- Modify: `test/migration-contract.test.mjs`
- Modify: `pi/agents/executor.md`
- Modify: `pi/agents/spark.md`
- Modify: `skill-overrides/subagent-dispatch/SKILL.md`

- [ ] **Step 1：先改 migration contract 并确认 RED**

删除 `task/task_status` 期望，改为断言旧四个生产文件均不存在，Agent profile 使用完整模型 ID，且普通 Agent 工具列表不含 `subagent`：

```javascript
assert.equal(executor.model, "openai/gpt-5.6-terra");
assert.equal(spark.model, "openai/gpt-5.3-codex-spark");
assert.equal(executor.tools.includes("subagent"), false);
assert.equal(spark.tools.includes("subagent"), false);
```

Run: `node --test test/migration-contract.test.mjs`

Expected: FAIL，旧 runtime 仍存在。

- [ ] **Step 2：删除旧 runtime 和对应测试**

删除表中七个旧文件，不保留兼容 wrapper，不同时注册 `task`、`task_status` 或自研后台队列。

- [ ] **Step 3：重写 Subagent dispatch Skill**

Skill 只描述 `subagent`/Adapter 的 async 生命周期：executor 用于多文件或安全任务，spark 只用于单文件快速修改；必须后台；调用后查询 artifact-backed status；普通 worker 禁止递归。删除所有 `task({ ... })` 和 `task_status({ ... })` 示例。

- [ ] **Step 4：验证迁移合同**

Run:

```bash
node --test test/migration-contract.test.mjs
npm test
```

Expected: migration contract 和完整单元测试 PASS。

### Task 5：定义可验证的 Plan 文档与真实 DAG

**Deps:** Task 4

**Files:**
- Create: `scripts/lib/plan/plan-document.mjs`
- Create: `scripts/lib/plan/plan-graph.mjs`
- Create: `test/plan-document.test.mjs`
- Create: `test/plan-graph.test.mjs`

- [ ] **Step 1：先写 canonical plan 和 DAG 失败测试**

覆盖：重复 Task ID、未知依赖、自依赖、有环、空 Files、缺少唯一的顶层 `## Execution Contract` JSON block、verification 为空、requiredGates 不完整；以及不同换行符产生同一 hash。规范化结果固定为：

```javascript
{
  schemaVersion: "pi-plan.v1",
  title,
  tasks: [{ id: "task-1", title, deps: [], files: ["src/a.mjs"], body }],
  verification: ["npm test"],
  sha256,
}
```

Run: `node --test test/plan-document.test.mjs test/plan-graph.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现严格解析和稳定 hash**

只接受唯一的顶层 `## Execution Contract` JSON block，以及 `### Task N`、可选 `**Deps:** Task ...`、必需 `**Files:**` 的当前计划格式。验证命令只从 contract 的 `verification` 数组读取，不从自然语言或任意 `Run:` 代码块猜测；先转换 LF、去行尾空格，再对 canonical JSON 计算 SHA-256。解析错误包含计划路径和 Task 标识，不猜测缺失字段。

- [ ] **Step 3：实现确定性串行 DAG 调度**

`createPlanGraph(plan)` 必须拒绝环；`nextRunnableTask(projection)` 在所有 deps accepted 的 pending 节点中按计划文档顺序返回一个节点。v1 不返回多个 mutating 节点。

Run: `node --test test/plan-document.test.mjs test/plan-graph.test.mjs`

Expected: PASS。

### Task 6：建立 Plan Session append-only 领域事件

**Deps:** Task 5

**Files:**
- Create: `scripts/lib/plan/plan-events.mjs`
- Create: `test/plan-events.test.mjs`

- [ ] **Step 1：先写 reducer 与非法迁移测试**

事件 envelope 固定为：

```javascript
{
  schemaVersion: "pi-plan-event.v1",
  eventId,
  planId,
  occurredAt,
  type,
  data,
}
```

覆盖 `plan.created`、`attempt.bound`、`attempt.settled`、`task.accepted`、`gate.finished`、`plan.validated`、`plan.blocked`、`plan.cancelled`、`plan.interrupted`；拒绝不同 planId、重复 eventId、非终态任务上的 validated、不同 inputHead 的 Gate。

Run: `node --test test/plan-events.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现正交 projection**

Projection 必须分别保存：

```javascript
{
  lifecycle: "created|running|verifying|validated|blocked|cancelled|interrupted",
  tasks: Map,
  attempts: Map,
  gates: Map,
  workspace: { originRoot, worktree, baseCommit, headCommit },
  validatedHead: null,
}
```

`plan.validated` 的 reducer 前置条件是：所有 task accepted、无 active attempt、worktree clean、四类 Gate 均 `passed` 且 `inputHead === headCommit`。

Run: `node --test test/plan-events.test.mjs`

Expected: PASS。

### Task 7：实现执行仓所有权和 Gate Git scope

**Deps:** Task 5

**Files:**
- Create: `scripts/lib/plan/workspace.mjs`
- Create: `test/plan-workspace.test.mjs`

- [ ] **Step 1：先写真实临时 Git 仓库测试**

覆盖：origin dirty 不被纳入 plan diff、worktree 从固定 base 创建、另一个 worktree 的变化不可见、plan worktree 未跟踪文件可见、HEAD 变化使 Gate stale、非 owner planId 不能操作 worktree。

Run: `node --test test/plan-workspace.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现 WorkspaceLease**

公开接口固定为：

```javascript
await createPlanWorkspace({ originRoot, stateRoot, planId, baseCommit });
await inspectPlanWorkspace(lease);
await removePlanWorkspace(lease, { requireValidatedHead });
```

branch 命名为 `pi-plan/<planId>`，worktree 位于 `var/plan-worktrees/<planId>`。所有 Git 命令使用 argv 调用，不拼接 shell 字符串；禁止路径逃出 `var/plan-worktrees`。

- [ ] **Step 3：定义 Gate change set**

`inspectPlanWorkspace()` 返回 committed diff `baseCommit..HEAD`、未跟踪文件、dirty tracked files 和 `headCommit`。Gate 输入 hash 由 `baseCommit`、`headCommit`、未跟踪文件内容 hash 组成；主工作区状态不参与。

Run: `node --test test/plan-workspace.test.mjs`

Expected: PASS。

### Task 8：只读投影 pi-subagents lifecycle artifacts

**Deps:** Task 3, Task 6

**Files:**
- Create: `scripts/lib/plan/runtime-artifacts.mjs`
- Create: `scripts/lib/plan/plan-projection.mjs`
- Create: `test/plan-runtime-artifacts.test.mjs`
- Create: `test/plan-projection.test.mjs`

- [ ] **Step 1：先写 artifact 容错测试**

覆盖 atomic `status.json`、缺文件、尾部半行 `events.jsonl`、未知 event、result file 已被 watcher 删除、sessionId UUID 与 path identity 不相等。不得把 status 的格式化 `text` 作为状态来源。

Run: `node --test test/plan-runtime-artifacts.test.mjs test/plan-projection.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现 typed artifact reader**

只读取 stable lifecycle 字段：`runId`、`sessionId`、`state`、`asyncDir`、`sessionFile`、`outputFile`、`results`、`children`、`model`、`attemptedModels`。未知字段忽略；JSON 未完成写入返回 `transient`，不改写领域事件。

- [ ] **Step 3：生成可再生只读 status projection**

将 Plan session entries 和 artifacts 投影到 `var/plan-runs/<planId>/status.json`，标记：

```javascript
{ schemaVersion: "pi-plan-status.v1", derived: true, planId, lifecycle, headCommit, validatedHead, tasks, gates }
```

该文件只供 Parent/UI 读取；恢复必须从 Plan Session entries 重放，禁止从 status projection 驱动迁移。

Run: `node --test test/plan-runtime-artifacts.test.mjs test/plan-projection.test.mjs`

Expected: PASS。

### Task 9：实现 Plan Coordinator 和 exactly-once 保守恢复

**Deps:** Task 6, Task 7, Task 8

**Files:**
- Create: `scripts/lib/plan/coordinator.mjs`
- Create: `test/plan-coordinator.test.mjs`

- [ ] **Step 1：先写调度与 crash window 测试**

覆盖：一次只授权一个 runnable task、非预期 nested `subagent` 调用被阻断、nested tool result 后 append `attempt.bound`、attempt 完成但未审查不接受 task、`dispatch.requested` 后无 tool result 时进入 `blocked: dispatch_uncertain`、失败重试创建新 attempt、恢复不盲目重复 spawn。

Run: `node --test test/plan-coordinator.test.mjs`

Expected: FAIL，模块不存在。

- [ ] **Step 2：实现 expected attempt intent**

Coordinator 先 append `attempt.dispatch-requested`，并向 Plan Runner 返回唯一允许的 nested tool 参数：

```javascript
{
  agent: task.agent ?? "executor",
  task: buildExecutionPrompt(plan, task, projection),
  cwd: projection.workspace.worktree,
  context: "fresh",
  async: true,
  clarify: false,
}
```

Plan Capsule 的 `tool_call` hook 只允许与该 intent 完全匹配的一次 `subagent` 调用，并拒绝第二个 mutating attempt。`tool_execution_end/tool_result` 从 Task 1 已证明的结构化 details 追加 `attempt.bound`，保存 `runId`、`asyncDir`、`sessionFile`。tool call 已发生但无可恢复 result 时，必须 blocked 并要求 `/plan-recover` 人工 reconcile。

- [ ] **Step 3：实现恢复**

恢复顺序固定为：重放 entries、扫描当前 Plan Session 的 persisted nested tool result 补齐已返回但未 append 的 binding、读取 `status.json`、将明确终态追加为 `attempt.settled`、再计算下一 runnable task。Parent 可用 RPC `status` 触发顶层 Plan Run reconciliation；Plan child 不依赖完整 RPC bridge。不得重发已有 binding。

Run: `node --test test/plan-coordinator.test.mjs`

Expected: PASS。

### Task 10：实现 commit-bound GateAttempt 和 fail-closed 验证

**Deps:** Task 7, Task 9

**Files:**
- Create: `scripts/lib/plan/gates.mjs`
- Create: `test/plan-gates.test.mjs`
- Modify: `scripts/lib/external-review-runner.mjs`
- Modify: `test/external-review-runner.test.mjs`

- [ ] **Step 1：先写 Gate 失效和 fail-closed 测试**

覆盖：无 diff、dirty worktree、running attempt、deterministic command 非零、audit invalid schema、external Critical/Important、provider unavailable、Gate 后 HEAD 改变。以上情况均不得产生 `validated`。

Run: `node --test test/plan-gates.test.mjs test/external-review-runner.test.mjs`

Expected: FAIL，Gate 模块不存在或 external review 仍返回 Markdown-only verdict。

- [ ] **Step 2：实现四类 GateAttempt**

每次结果固定为：

```javascript
{
  gateId,
  type: "deterministic|plan-audit|external-review|final-completeness",
  inputHead,
  changeSetHash,
  status: "passed|failed|unavailable",
  evidence: [{ kind, path, sha256 }],
  findings: [],
}
```

deterministic 运行计划声明的验证命令；plan-audit 使用只读 reviewer；external review 返回结构化 severity；final completeness 检查所有 tasks、attempts、worktree 和前三类 Gate。

- [ ] **Step 3：绑定同一 immutable head**

开始 Gate 前要求 clean worktree，并记录 `inputHead`。每个 Gate 后重新读取 HEAD；变化则当前和先前 Gate 全部 stale，生命周期退回 `running`。repair 后必须重跑受影响的全部 Gate。

Run: `node --test test/plan-gates.test.mjs test/external-review-runner.test.mjs`

Expected: PASS。

### Task 11：实现 Plan Capsule Extension 和 completion guard

**Deps:** Task 3, Task 6, Task 9, Task 10

**Files:**
- Create: `scripts/lib/plan/plan-capsule-extension.mjs`
- Create: `pi/extensions/plan-capsule.ts`
- Create: `test/plan-capsule-extension.test.mjs`
- Create: `pi/agents/plan-runner.md`
- Create: `pi/agents/plan-reviewer.md`

- [ ] **Step 1：先写 Extension activation 与权限测试**

`plan-runner` profile 必须显式加载 Plan Capsule Extension；其他 Agent profile 不加载它。Extension 首先只注册 `plan_open` bootstrap tool，成功绑定 `planId`、`planPath`、`planHash`、`baseCommit`、`worktree` 后才开放 `plan_status`、`plan_continue`、`plan_verify`、`plan_block`。reviewer 只读，executor/spark 均不可见这些工具。

Run: `node --test test/plan-capsule-extension.test.mjs`

Expected: FAIL，Extension 不存在。

- [ ] **Step 2：实现 session entry 持久化和恢复**

首次 `plan_open` 校验 plan hash、worktree owner 和 base commit 后 `pi.appendEntry("pi-plan-event-v1", event)`。`session_start`/resume 只扫描当前 `getBranch()` 的同 customType entries，拒绝多个 planId。`session_tree` 导航到不含 plan.created 的分支时停止 coordinator 并标记需要恢复。若 Plan Runner 从未调用 `plan_open`，acceptance verify 必须失败。

- [ ] **Step 3：实现最小工具面**

工具只发出领域意图：查询、继续一个状态迁移、开始验证、声明 blocker。LLM 工具不得写 `review.accepted`、修改 DAG、改 plan hash、直接删除 worktree或直接产生 `validated`。

- [ ] **Step 4：实现 completion guard**

`agent_settled` 时重建 projection：若为 `validated`，输出成功摘要；若为 `blocked/cancelled`，输出对应非成功终态；若仍有 runnable/active/verifying 工作，通过 Pi follow-up message 继续 coordinator；若无法安全继续，append `plan.interrupted`。Plan Runner 的顶层 `pi-subagents` acceptance verify command 必须读取 derived projection 并仅在 `lifecycle === "validated" && validatedHead === headCommit` 时退出 0。

- [ ] **Step 5：固定 Agent profile**

`plan-runner` 固定 `openai/gpt-5.6-terra`，只授予 Plan tools、read-only inspection 和授权 nested `subagent`；`plan-reviewer` 固定 `openai/gpt-5.6-terra`，只授予 read/grep/git diff 所需只读工具，不含 edit/write/subagent。二者 `share: false`，使用独立 session，禁止模型 fallback；异源性由现有 external review 的 Claude reviewer 提供。

Run: `node --test test/plan-capsule-extension.test.mjs`

Expected: PASS。

### Task 12：实现 Parent Launcher，但不拥有 Plan 状态

**Deps:** Task 7, Task 11

**Files:**
- Create: `scripts/lib/plan/plan-launcher-extension.mjs`
- Create: `pi/extensions/plan-launcher.ts`
- Create: `test/plan-launcher-extension.test.mjs`
- Create: `skill-overrides/plan-runner-dispatch/SKILL.md`
- Modify: `agents/skills.list`

- [ ] **Step 1：先写 Parent 边界测试**

测试 `/plan-run <path>` 创建 worktree 并启动 async Plan Runner；Parent entry 只含 handle：

```javascript
{ planId, planHash, runId, asyncDir, sessionFile, statusPath, worktree }
```

Parent 不保存 tasks、Gate、attempt 或 validated 判定。两个计划可从同一 Parent 启动到不同 worktree。

Run: `node --test test/plan-launcher-extension.test.mjs`

Expected: FAIL，Launcher 不存在。

- [ ] **Step 2：实现启动与只读观察命令**

注册 `/plan-run`、`/plan-status`、`/plan-open`、`/plan-pause`、`/plan-cancel`、`/plan-recover`。启动前要求计划文件可读、Git 有具体 base commit、planId 未占用，并由交互确认“允许在专属 plan 分支创建 commit，但不允许 merge/push”；RPC/headless 调用必须显式传 `allowPlanCommits: true`。通过 RPC spawn Plan Runner，prompt 包含一个机器可读 bootstrap JSON，要求第一步调用 `plan_open`：

```javascript
{ planId, planPath, planHash, baseCommit, worktree, allowPlanCommits: true }
```

- [ ] **Step 3：实现控制语义**

pause 使用 `interrupt`；cancel 先在 Plan Session 记录 cancel intent，再调用 `stop`，并从 artifact 确认终态。由于上游 `stop` 可能表现为 `failed/timedOut`，Parent UI 显示 Plan 领域的 `cancelled`，但保留上游原始状态；stop 失败不得显示取消成功。

- [ ] **Step 4：写 dispatch Skill**

Skill 明确：先用 `writing-plans` 生成批准计划，再调用 `/plan-run <exact-path>`；主 Agent 不执行计划任务；收到 `blocked` 时向用户取决策；只有结构化 `validatedHead` 才能报告计划完成。

Run: `node --test test/plan-launcher-extension.test.mjs test/skill-list.test.mjs`

Expected: PASS。

### Task 13：实现 restart、compaction、取消和证据失效 E2E

**Deps:** Task 11, Task 12

**Files:**
- Create: `test/plan-capsule.integration.mjs`
- Modify: `test/pi-runtime.integration.mjs`
- Modify: `package.json`

- [ ] **Step 1：写真实 E2E 场景**

使用临时 Git repo 和 fake deterministic worker 覆盖：正常执行到 validated、主会话切换话题不影响 Plan child、同时运行两个 Plan、Plan Session compaction、进程重启 resume、验证后文件变化导致 Gate stale、pause/resume、cancel、worker crash、review unavailable。

- [ ] **Step 2：运行 RED 并确认失败发生在尚未接通的 lifecycle**

Run:

```bash
PI_REAL_BIN="$(command -v pi)" node --test test/plan-capsule.integration.mjs
```

Expected: 在真实 Extension/Plan child 链路未接通处 FAIL，而不是因缺凭据或访问 OpenCode 状态失败。

- [ ] **Step 3：补齐真实 Extension wiring**

根据 Task 1 已证明的加载方式，把 `plan-launcher.ts` 只加载在 Parent，把 `plan-capsule.ts` 和 child-safe nested subagent 只加载在 Plan Runner。RPC 模式 widget 只使用 string lines，不依赖 TUI-only component。

- [ ] **Step 4：增加集成测试命令**

`package.json` 增加：

```json
"test:plan": "node --test test/plan-capsule.integration.mjs"
```

Run:

```bash
npm test
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan
```

Expected: 全部 PASS。

### Task 14：文档、doctor 和最终验收

**Deps:** Task 2, Task 4, Task 13

**Files:**
- Create: `docs/pi-plan-execution-capsule.md`
- Modify: `README.md`
- Modify: `scripts/doctor.mjs`
- Modify: `test/doctor.test.mjs`
- Modify: `test/migration-contract.test.mjs`

- [ ] **Step 1：写运行和恢复文档**

文档必须说明：一计划一 Session、一计划一 worktree、Parent 只是 handle、状态权威来源、Gate scope、`validatedHead`、blocked/recover/cancel、失败现场保留、显式 merge-back。加入以下命令示例：

```text
/plan-run docs/superpowers/plans/2026-07-15-example.md
/plan-status <plan-id>
/plan-open <plan-id>
/plan-recover <plan-id>
/plan-cancel <plan-id>
```

- [ ] **Step 2：扩展 doctor 最终合同**

doctor 检查：Pi 和 package 精确版本、RPC ping、两个普通 Agent 和两个 Plan Agent、Plan child Extension 加载能力、旧 Task 7 文件不存在、Skill 白名单精确、`var/` 运行状态被 Git 忽略。

- [ ] **Step 3：运行全部自动验证**

Run:

```bash
npm test
npm run doctor
PI_REAL_BIN="$(command -v pi)" npm run test:integration
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
PI_REAL_BIN="$(command -v pi)" npm run test:plan
uv run --no-project --with httpx --with python-dotenv --with pyyaml \
  python -m unittest discover -s skill-overrides/external-llm-review/tests
git diff --check
```

Expected: 所有测试和 doctor PASS；`git diff --check` 无输出。

- [ ] **Step 4：执行手工边界验收**

在两个独立示例仓同时启动两个计划；主会话继续普通对话；确认每个 `/plan-status` 只显示自身 change set。修改主工作区非计划文件，确认两个 Gate 均不扩大范围。修改某个已验证执行仓，确认其状态从 `validated` 失效，而另一计划保持不变。

- [ ] **Step 5：检查工作区和凭据边界**

Run:

```bash
git status --short --branch
git diff -- . ':!pi/auth.json'
```

Expected: 只有本计划声明文件发生预期变化；没有 auth、token、session transcript、`var/plan-runs` 或 `var/plan-worktrees` 被 Git 跟踪。未经用户授权不 commit、不 push。

## Terminal Gate

整个迁移只有在以下条件全部满足时才完成：

- Task 1 的真实兼容性硬门禁通过。
- 自研 Task 7 runtime 和旧测试已删除。
- Parent Session 不保存 Plan DAG、Gate 或 attempt 状态。
- Plan Session 可从 session entries 和上游 artifacts 完整恢复。
- 两个计划可并行存在且 Gate change set 互不污染。
- 普通 worker 无 nested subagent，Plan Runner 的 nested 权限受深度限制。
- 任一 Gate failed/unavailable、HEAD 漂移、active attempt、dirty worktree 都无法产生 `validated`。
- 成功结果包含 `planId`、`planHash`、`baseCommit`、`validatedHead` 和证据引用。
- 合回 origin 仍需用户或 Parent 显式动作。
- 完整自动验证通过，且没有凭据或运行状态进入 Git。

## 自审结果

- 需求覆盖：独立上下文、独立 worktree、封闭 Gate scope、多计划并行、恢复和 `validated` 强语义均有对应任务。
- 架构纠偏：没有以 OpenCode Harness 为迁移目标，只保留计划绑定、隔离、证据和 fail-closed 门禁。
- 状态边界：Plan 决策归 Plan Session；worker runtime 归 `pi-subagents` artifacts；Parent 只持有 handle。
- 变更边界：所有审查和 Gate 固定为执行仓 `baseCommit..headCommit`，主工作区不参与。
- 并发边界：v1 支持计划间并行，计划内 mutating attempt 串行，避免引入 child merge 复杂度。
- 兼容风险：Plan child Extension 加载和 nested safety 在 Task 1 先证明；失败即停，不用自研 runtime 绕过。
- 安全语义：不存在第二次失败放行；unavailable、invalid output 和 stale evidence 均 fail-closed。
- 提交策略：计划不包含 commit 步骤；未经用户授权不 commit、不 push。
