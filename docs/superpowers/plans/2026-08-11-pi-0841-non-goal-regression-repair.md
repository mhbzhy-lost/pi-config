# Pi 0.84.1 非 Goal 回归修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: 使用项目 `subagent-dispatch` 与 `test-driven-development`，逐任务执行；不得使用 Goal Engine。

**Goal:** 修复 Pi `0.84.1` 与 `pi-subagents@0.45.2` 迁移中剩余的非 Goal 回归，使非 Goal 单元测试、真实 Pi workflow/RPC、Root Broker 启动与项目 typed facade 全部通过。

**Architecture:** 保留 public workflow root 与真实 leaf 身份分离；coding leaf 的等待窗口使用调用方已声明的执行期限，避免固定 30 秒先于权威 workflow 期限报错。Root Broker 继续以当前 ExtensionAPI 精确绑定，同时增加显式 root session identity 的进程内索引，解决 Pi 0.84 为不同 extension 创建不同 `events` facade 后无法跨 extension 查询的问题。测试夹具只通过 Pi 的真实工具调用链调用 `subagent`，不再把 `getAllTools()` 的只读 metadata 当作可执行定义。

**Tech Stack:** Node.js 22、Node test runner、TypeScript/Jiti、Pi `0.84.1`、`pi-subagents@0.45.2`、TypeBox `1.1.38`。

## Global Constraints

- 排除 Goal Engine：不调用 Goal typed tools，不修改 `scripts/lib/goal-engine/**`、Goal fixture、Goal state 或 handoff。
- 不读取、修改或暂存用户 `pi/settings.json`、`pi/npm/**`、`.state/**`、认证文件。
- 不执行 git commit、暂存、reset、restore、clean、stash、rebase、amend 或 raw worktree lifecycle。
- 每项 production/Skill 逻辑修改先有 `docs/bugs/bug-*.md`，再观察对应 RED，最后写最小 GREEN。
- public spawn 仅发送 `workflowScript`；coding acceptance 保持 `level:"checked"`，不得伪造 `verified/verify`。
- Root Broker、title registry 与 typed handle 只能绑定真实 leaf `runId/asyncDir`，不得退回 workflow root id。
- `pi/settings.json` 的模型列表是用户配置；测试只验证必要模型、默认模型、去重和 thinking level 不变量。

## 文件职责

- `scripts/lib/subagent-dispatch/root-broker-registry.ts`：同 ExtensionAPI 精确绑定和显式 root session identity 跨 extension 查询。
- `scripts/lib/subagent-dispatch/workflow-spawn.ts`：workflow root/leaf 关联与有界等待。
- `scripts/lib/subagent-dispatch/extension.ts`：按 coding/generic 调用合同选择 leaf-start 等待期限。
- `test/pi-subagents-project-workflow.integration.mjs`：通过真实 AgentSession 工具调用验证项目 typed facade、leaf lifecycle、broker ownership 与 terminal artifact。
- `test/subagent-runtime-root-broker-startup.integration.mjs`：验证 Pi 0.84 多 extension facade 下的 broker 查询。
- `test/global-rules.test.mjs`、`test/migration-contract.test.mjs`、`test/package-scripts.test.mjs`：验证稳定不变量，不硬编码用户可变配置或完整脚本对象。

## DAG

```text
T1 基线契约校准 ───────────────┐
T2 Root Broker 跨扩展身份 ─────┼──> T4 非 Goal 全量验收
T3 Workflow 等待与真实 facade ─┘
```

依赖边：
- `T1 -> T4`：T4 需要校准后的非 Goal 测试集合。
- `T2 -> T4`：T4 需要跨 extension broker integration 为 GREEN。
- `T3 -> T4`：T4 需要真实 typed facade 和假超时回归为 GREEN。
- T1、T2、T3 无相互依赖，可并发；T2 与 T3 使用不同 production 写入路径。

## Wave

- **Wave 1（并行）**：T1、T2、T3
- **Wave 2**：T4；任一前驱完成即可先做对应聚焦复测，但最终全量验收等待三个前驱全部完成。

---

### Task 1: 校准非 Goal 基线契约

**Deps:** none

**WritePaths:** `pi/AGENTS.md`、`test/global-rules.test.mjs`、`test/migration-contract.test.mjs`、`test/package-scripts.test.mjs`

**Files:**
- Modify: `pi/AGENTS.md`
- Modify: `test/global-rules.test.mjs`
- Modify: `test/migration-contract.test.mjs`
- Modify: `test/package-scripts.test.mjs`

**Interfaces:**
- Consumes: 当前失败证据：global rules 缺少 `docs/bugs/bug-` 规则；模型测试硬编码三个可选 provider；脚本测试要求完整对象精确相等。
- Produces: 只约束稳定不变量的非 Goal 基线，不修改用户 settings 或 package scripts。

- [ ] **Step 1: 保留并确认现有 RED**

Run:
```bash
node --test test/global-rules.test.mjs test/migration-contract.test.mjs test/package-scripts.test.mjs
```
Expected: 三项分别因 bug 文档规则缺失、可选模型硬编码、额外 managed worktree 脚本而 FAIL。

- [ ] **Step 2: 恢复 bug 文档前置规则**

在 `pi/AGENTS.md` 的 TDD 段明确加入：所有非单行 production/Skill 逻辑修改，必须先建立 `docs/bugs/bug-*.md` 并观察 RED。不得改变既有 TDD 豁免语义。

- [ ] **Step 3: 将模型测试改为稳定不变量**

`test/migration-contract.test.mjs` 必须逐项断言以下必要模型存在，而不是深度相等整个 `enabledModels`：

```js
const requiredModels = [
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.3-codex-spark",
  "deepseek/deepseek-v4-flash",
];
```

继续断言列表无重复、`defaultProvider/defaultModel` 在列表中、`defaultThinkingLevel` 属于既有枚举。不得改 `pi/settings.json`。

- [ ] **Step 4: 将 package scripts 测试改为必要键逐项断言**

继续精确验证 `test`、`test:integration`、`test:subagents`、`setup:subagent-runtime`、`doctor`；同时精确验证 `worktree` 与 `worktree:audit` 指向 managed lifecycle CLI。不得用完整对象 `deepEqual` 拒绝未来安全脚本。

- [ ] **Step 5: 验证 GREEN**

Run:
```bash
node --test test/global-rules.test.mjs test/migration-contract.test.mjs test/package-scripts.test.mjs
```
Expected: 全部 PASS；`git diff --check` PASS。

---

### Task 2: 修复 Pi 0.84 Root Broker 跨 extension identity

**Deps:** none

**WritePaths:** `docs/bugs/bug-pi-0841-extension-facades-split-root-broker-identity.md`、`scripts/lib/subagent-dispatch/root-broker-registry.ts`、`test/root-subagent-broker.test.mjs`、`test/fixtures/root-broker-registry-probe.ts`、`test/subagent-runtime-root-broker-startup.integration.mjs`

**Files:**
- Create: `docs/bugs/bug-pi-0841-extension-facades-split-root-broker-identity.md`
- Modify: `scripts/lib/subagent-dispatch/root-broker-registry.ts`
- Modify: `test/root-subagent-broker.test.mjs`
- Modify: `test/fixtures/root-broker-registry-probe.ts`
- Modify: `test/subagent-runtime-root-broker-startup.integration.mjs`

**Interfaces:**
- Consumes: `RootBrokerServer.rootSessionId: string`；Pi 0.84 的每个 extension 拥有不同 `pi` 和 `pi.events` facade，但同一 lifecycle 提供相同 `sessionManager.getSessionId()`。
- Produces: `requireRootBroker(pi, { rootSessionId? })` 与 `inspectRootBrokerExecutorProof(pi, runId, { rootSessionId? })`；无显式 session identity 时继续只允许当前 ExtensionAPI 精确命中。

- [ ] **Step 1: 记录缺陷文档**

文档必须说明：旧 `Symbol.for + WeakMap<pi.events>` 只解决 Jiti 模块副本，不解决 Pi 0.84 每 extension facade 分裂；显式 session identity 仅用于同进程跨 extension 查询，错误、冲突或缺失 identity 必须 fail closed。

- [ ] **Step 2: 增加并观察 RED**

在 `test/root-subagent-broker.test.mjs` 增加：
- API A 绑定后，拥有不同 `events` 的 API B 仅在提供相同 `rootSessionId` 时可查询。
- 错误 rootSessionId、空 identity、不同 broker 争用同一 session id 都拒绝。
- unbind 仅删除与 exact broker 匹配的 session 索引，不得删除替代绑定。

Run:
```bash
node --test test/root-subagent-broker.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/subagent-runtime-root-broker-startup.integration.mjs
```
Expected: 新单元断言和现有真实 integration 因跨 facade 查询 unavailable 而 FAIL。

- [ ] **Step 3: 实现最小 session 索引**

在 `process` 上用新的 `Symbol.for(...)` slot 保存 `Map<string, RootBrokerServer>`；保留原 WeakMap 精确索引。`bindRootBroker` 一次计算 API key，并原子检查 exact key 与 `broker.rootSessionId` 冲突后同时写入；`requireRootBroker` 先查 exact key，只有调用方提供安全、非空、与索引精确匹配的 `rootSessionId` 时才查 session Map；不得做“全局只有一个 broker 就返回”的模糊 fallback。`unbindRootBroker` 与启动失败回滚只删除当前 broker 自己的两个索引。

- [ ] **Step 4: 让真实 probe 提供权威 session id**

`test/fixtures/root-broker-registry-probe.ts` 从 `ctx.sessionManager.getSessionId()` 取得 identity，并显式传给 `requireRootBroker`。integration 继续断言 broker root id 等于 session id、socket 存在且 EOF 后删除。

- [ ] **Step 5: 验证 GREEN**

Run:
```bash
node --test test/root-subagent-broker.test.mjs test/subagent-runtime-resource-isolation.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/subagent-runtime-root-broker-startup.integration.mjs
```
Expected: 全部 PASS；错误 identity 仍 fail closed；`git diff --check` PASS。

---

### Task 3: 消除 workflow leaf 假超时并修正真实 facade integration

**Deps:** none

**WritePaths:** `docs/bugs/bug-pi-subagents-workflow-leaf-start-false-timeout.md`、`scripts/lib/subagent-dispatch/extension.ts`、`scripts/lib/subagent-dispatch/workflow-spawn.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/subagent-workflow-spawn.test.mjs`、`test/pi-subagents-project-workflow.integration.mjs`

**Files:**
- Create: `docs/bugs/bug-pi-subagents-workflow-leaf-start-false-timeout.md`
- Modify: `scripts/lib/subagent-dispatch/extension.ts`
- Modify only if needed by RED: `scripts/lib/subagent-dispatch/workflow-spawn.ts`
- Modify: `test/subagent-runtime-membrane.test.mjs`
- Modify: `test/subagent-workflow-spawn.test.mjs`
- Modify: `test/pi-subagents-project-workflow.integration.mjs`

**Interfaces:**
- Consumes: coding IR 的 `execution.timeoutMs`；generic input 的可选 `timeoutMs`；真实 `subagent:async-started` 中的 `sessionId/agent/workflowKey/parentWorkflowRunId/runId/asyncDir`。
- Produces: coding dispatch 在其声明的 workflow execution deadline 前持续等待匹配 leaf；显式测试 override 仍可提供短 deadline；generic 未提供 timeout 时使用有界 120000ms fallback。成功结果仍只返回 leaf handle。

- [ ] **Step 1: 记录缺陷文档**

文档必须区分：leaf identity 缺失/冲突是协议故障；workflow root 仍在合法期限内而 leaf 尚未发布不是故障。记录当前固定 30000ms 先于 coding IR 的 900000ms 期限报错，并注明不得用 workflow root id 兜底。

- [ ] **Step 2: 增加 deadline RED**

在 `test/subagent-runtime-membrane.test.mjs` 用短时间比例复现：coding IR 声明较长 timeout，matching leaf 在旧固定 start window 之后到达，期望工具成功返回该 leaf；另保留显式 `workflowChildStartTimeoutMs: 10` 的 no-leaf 测试，证明测试 override 仍会快速 fail closed。generic 无 timeout 的默认值通过导出常量或注入时钟断言为 120000ms，不得实际等待两分钟。

Run:
```bash
node --test test/subagent-runtime-membrane.test.mjs test/subagent-workflow-spawn.test.mjs
```
Expected: delayed matching leaf 用例在旧实现上得到 `WORKFLOW_CHILD_START_TIMEOUT`。

- [ ] **Step 3: 选择权威 deadline**

将 `workflowChildStartTimeoutMs` 改为可选 override：显式提供时用于测试/诊断；production coding 使用 `ir.execution.timeoutMs`；generic 使用 `input.timeoutMs ?? 120000`。collector 仍在 deadline 到达后释放 listener 并抛 `WORKFLOW_CHILD_START_TIMEOUT`，对 identity 冲突继续立即抛 `WORKFLOW_CHILD_BINDING_INVALID`。不得轮询 Goal、不得读取文本状态、不得返回 root binding。

- [ ] **Step 4: 重写真实项目 facade integration**

`test/pi-subagents-project-workflow.integration.mjs` 的 deterministic provider 必须直接生成名为 `subagent` 的 tool call，并传完整 `dispatch-ir.v1`；probe extension 只监听 `tool_execution_end` 与 `subagent:async-started`，不得从 `pi.getAllTools()` 调用 `.execute()`。测试从真实 tool result 读取 typed leaf handle，再验证：
- result `isError !== true`；
- handle `runId/asyncDir` 与 matching lifecycle leaf 一致；
- handle 与 workflow root id 不同；
- terminal `status.json` 的 `runId/asyncDir` 与 handle 一致并正常完成。

Root Broker proof 的跨 extension 查询使用 Task 2 产出的显式 root session identity API；若 Task 2 尚未合入，可先完成除 proof 外的 RED/实现，最终 proof 断言在 T4 前补齐。

- [ ] **Step 5: 验证 GREEN**

Run:
```bash
node --test test/subagent-runtime-membrane.test.mjs test/subagent-workflow-spawn.test.mjs
PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-project-workflow.integration.mjs test/pi-subagents-045-workflow.integration.mjs
```
Expected: 全部 PASS；无 `WORKFLOW_CHILD_START_TIMEOUT` 假失败；`git diff --check` PASS。

---

### Task 4: 非 Goal 全量验收

**Deps:** T1（稳定基线测试）、T2（Root Broker session identity）、T3（workflow deadline 与真实 facade）

**WritePaths:** none

**Files:**
- Test only; no source edits. 若发现新失败，停止并按新 bug 文档 + RED 创建独立修复任务，不在验收任务中顺手修改。

**Interfaces:**
- Consumes: T1、T2、T3 的 GREEN 工件。
- Produces: 可审计的非 Goal 验收矩阵。

- [ ] **Step 1: 运行全部非 Goal `.test.mjs`**

Run:
```bash
files=$(find test -maxdepth 1 -name '*.test.mjs' ! -name 'goal-*' ! -name 'using-goal-engine-skill.test.mjs' | sort)
node --test $files
```
Expected: 0 fail、0 cancelled。Goal Engine 测试明确不在集合中。

- [ ] **Step 2: 运行真实 Pi 与 subagent integrations**

Run:
```bash
PI_REAL_BIN="$(command -v pi)" node --test \
  test/pi-runtime.integration.mjs \
  test/pi-subagents-runtime.integration.mjs \
  test/pi-subagents-045-workflow.integration.mjs \
  test/pi-subagents-project-workflow.integration.mjs \
  test/subagent-runtime-root-broker-startup.integration.mjs
```
Expected: 全部 PASS，且没有 `extension_error`、RPC timeout 或 fake leaf binding。

- [ ] **Step 3: Doctor、版本与格式**

Run:
```bash
pi --version
node -e 'console.log(require("./pi/npm/node_modules/pi-subagents/package.json").version); console.log(require("./pi/npm/package.json").dependencies.typebox)'
node scripts/doctor.mjs
git diff --check
```
Expected: `0.84.1`、`0.45.2`、`1.1.38`；Doctor 的 Skill 与 Root Broker 为 ready；格式检查通过。Doctor 的 Goal/worktree 历史 warning 不计入本目标，但不得隐藏。

- [ ] **Step 4: 独立评审**

对本计划相关 diff 做一次独立 code review，重点检查：session identity 是否可能跨 root 错配、unbind 是否删除替代 broker、deadline 是否无界、integration 是否真正通过 AgentSession 调用 public tool。只修有源码证据的 Critical/Important；修复仍须新 RED。

- [ ] **Step 5: 输出结论**

报告通过数、失败数、明确排除项和仍存风险。只有上述命令全部 GREEN，才能声明“除 Goal Engine 外全部能力通过”。
