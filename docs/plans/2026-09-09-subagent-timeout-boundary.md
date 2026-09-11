# Subagent 超时边界改造计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 从模型可见的 typed `subagent` dispatch ABI 中彻底移除可自定义的 `timeoutMs`，由 Host 统一注入执行超时，同时保留底层 watchdog、RPC 和 runtime 的失控保护。

**架构：** public dispatch input 不再接受 coding `execution.timeoutMs` 或 generic 顶层 `timeoutMs`。typed facade 在任何 model discovery、workspace 分配或 RPC 前严格拒绝该字段；coding 再由 Host 注入 30 分钟执行 timeout 后调用现有 canonical codec，generic 则继续省略 workflow execution deadline，仅保留现有 120 秒 child-start watchdog。canonical codec、Goal 可信 timeout/hash、底层 watchdog/RPC/runtime 和 upstream `pi-subagents` ABI 均保持不变。

**技术栈：** Node.js `>=22.19.0`、TypeScript 原生 type-stripping、Node test runner、JSON Schema 风格 tool schema。

## 全局约束

- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`；新增或迁移 TypeScript 实现由 `tsc --noEmit` 或等价静态检查覆盖。
- `scripts/` 只放 CLI、初始化脚本和诊断探针；本次实现归属 `packages/pi-subagents-enhanced/src/`，不得新增共享实现到 `scripts/`。
- 跨 feature 依赖只能通过公开入口或 package `exports`；不得从 production 反向依赖 `scripts/**`、`pi/extensions/**`。
- 生产逻辑变更必须遵循 TDD：先写并观察 RED，再写最小实现，最后验证 GREEN。
- 测试只验证行为，不为配置或文档字面值建立镜像断言；仅在验证 public schema 行为时断言字段不可接受。
- 文档、Skill 正文和代码注释使用中文；专业标识符、命令、路径和协议名称可保持原样。
- 不读取、记录、输出或提交凭据、密钥和证书；整个 `pi/settings.json` 不得修改、暂存或提交，只允许检查其路径状态。
- 不改变 upstream `pi-subagents` 原生 subagent tool schema；本计划只收紧项目自有 typed facade 的模型输入边界。
- 计划最后一个实现任务完成后，必须派发 reviewer 对整体完成情况执行一次 review；该 reviewer 派发需要用户另行明确批准。

## DAG

```text
T1（行为契约与 RED） ──> T2（Host timeout 注入实现） ──> T3（测试/Skill 迁移） ──> T4（全量回归）
                                  └──────────────────────> T4
```

依赖理由：T2 消费 T1 定义的 public/internal 分层和默认值；T3 消费 T2 的最终接口；T4 必须等待实现与全部 fixture 迁移完成。T1 不依赖其他任务。

## Waves

- Wave 1：T1
- Wave 2：T2
- Wave 3：T3
- Wave 4：T4

**关键路径：** T1 → T2 → T3 → T4。

---

### Task 1：固定 public ABI、拒绝时序与 Host timeout 策略

**Deps：** `none`

**WritePaths：**
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-dispatch-schema-security.test.mjs`
- `test/subagent-dispatch-validation-errors.test.mjs`
- `docs/bugs/`（仅当执行时按 TDD 规则需要建立本次 bug 记录）

**Resources：** `none`

**Files：**
- Test：为 coding/generic tool schema 增加失败用例，证明 agent supplied `timeoutMs` 被拒绝；增加 Host 注入 timeout 后仍可进入内部派发的行为样例。
- Test：覆盖 stringified `execution` 不得绕过 nested timeout 禁止规则。

**接口契约：**
- Consumes：现有 `TYPED_SUBAGENT_PARAMETERS`、`compileCodingDispatchIR`、generic workflow 输入。
- Produces：`preparePublicCodingDispatch(input, { cwd, timeoutMs })` 的测试契约：object 或 stringified `execution` 一旦包含 `timeoutMs` 就抛 `INVALID_CONTRACT`，否则向副本注入 Host `timeoutMs` 并交给现有 codec；拒绝必须发生在 discovery/workspace/RPC 前。coding Host timeout 固定为 `30 * 60_000`。generic 顶层 `timeoutMs` 同样在副作用前拒绝，但不向 workflow 注入 execution deadline；collector 继续使用 `120_000`，upstream profile/runtime deadline 维持原语义。

**验收标准：**
- 模型可见 coding schema 不再展示或接受 `execution.timeoutMs`；`runtimeValidated` 的宽松 object/string fallback 仍由 facade runtime adapter 严格拒绝，不能静默覆盖。
- 模型可见 generic schema 不再展示或接受顶层 `timeoutMs`。
- 直接 `tool.execute` 的拒绝测试证明 discovery、workspace 和 RPC 调用计数均为零。
- 测试在当前实现下先以预期原因 RED，而不是 fixture/import 错误。

- [x] **步骤 1：编写失败测试**
- [x] **步骤 2：运行相关测试确认 RED**
- [x] **步骤 3：记录 Host/internal timeout 分层和默认值决策**

### Task 2：实现 Host 注入与内部超时保留

**Deps：** `T1`（理由：消费 T1 产出的 public ABI 和默认值契约）

**WritePaths：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts`

**Resources：** `none`

**Files：**
- Modify：移除 typed tool schema 中两个 agent-facing timeout 字段和 coding `required` 项。
- Modify：在 `extension.ts` 实现并导出 `preparePublicCodingDispatch(input, { cwd, timeoutMs })`；它负责解析 object/stringified `execution`、拒绝 caller timeout、注入 Host timeout并调用现有 `compileCodingDispatchIR`。
- Preserve：`packages/pi-subagents-enhanced/src/contracts/dispatch-ir.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/ir.ts` 的内部 timeout 输入、正整数校验、canonical hash 和 prompt 语义不变；Goal 可以继续传入非默认可信 timeout。
- Modify：coding 继续向 workflow RPC、child-start collector 和 prompt 传递 Host 决定的 30 分钟值；generic workflow params 继续省略 timeout，collector 继续使用 120 秒；不删除 RPC/broker timeout。

**接口契约：**
- Consumes：T1 的 `preparePublicCodingDispatch` 行为契约与固定策略。
- Produces：public coding input 不含 timeout，内部 normalized IR 始终含 Host 正整数 timeout；generic workflow timeout 保持 `undefined`；`buildWorkflowSpawn`、collector、canonical codec 和 Goal 调用签名保持兼容。

**验收标准：**
- agent 无法通过 object 或 JSON stringified object 自定义执行 timeout。
- coding 派发生成带 Host timeout 的 workflow 参数；generic 派发继续不设置 workflow execution timeout。
- timeout 仍参与内部 deadline、child-start watchdog 和必要的 hash/审计事实。
- Goal 的非默认可信 timeout 重新编译后保持原值且 hash 不变。
- upstream 原生工具路径不被修改。

- [x] **步骤 1：根据 T1 RED 编写最小实现**
- [x] **步骤 2：运行 T1 测试确认 GREEN**
- [x] **步骤 3：运行 workflow spawn、RPC 和 runtime 相关回归**

### Task 3：迁移测试 fixture 与 Skill 文档

**Deps：** `T2`（理由：fixture 必须使用 T2 最终的 public/internal 分层）

**WritePaths：**
- `test/subagent-dispatch-ir.test.mjs`
- `test/subagent-dispatch-ir-coercion.test.mjs`
- `test/subagent-dispatch-schema-coercion.test.mjs`
- `test/subagent-dispatch-extension.test.ts`
- `test/subagent-runtime-membrane.test.mjs`
- `test/subagent-workflow-spawn.test.mjs`
- `test/goal-subagent-dispatch-parity.test.mjs`
- `test/goal-engine-dispatch.integration.mjs`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/subagent-model-selection.integration.mjs`
- `test/subagent-managed-worktree.integration.mjs`
- `test/pi-subagents-project-workflow.integration.mjs`
- `skill-overrides/subagent-dispatch/SKILL.md`

**Resources：** `none`

**Files：**
- Modify：tool-facing fixture 移除 timeout；直接测试 canonical codec 的 fixture 继续显式传入 timeout，覆盖内部正整数校验与 canonical hash，不能改成 facade helper 后掩盖 Goal 兼容性。
- Modify：删除/改写“agent 可以指定 timeout”的断言，保留 workflow/collector 的内部 timeout 测试。
- Modify：Skill 示例删除 `execution.timeoutMs` 和 generic `timeoutMs`，明确 timeout 由 Host/profile/runtime 决定。

**接口契约：**
- Consumes：T2 的 public schema、Host injection helper 和内部 normalized IR。
- Produces：所有相关测试与 Skill 示例使用一致的 ABI，不通过直接构造非法 public input 伪造 production 行为。

**验收标准：**
- 测试 fixture 不再要求模型填写 timeout。
- 内部 watchdog/RPC timeout 覆盖仍存在。
- Goal parity 包含非默认可信 timeout 的重编译/hash 回归。
- generic 回归明确断言 workflow timeout 仍为 `undefined`、collector timeout 为 `120_000`。
- Skill 不再教导 agent 填写 timeout。

- [x] **步骤 1：迁移 fixture 与断言**
- [x] **步骤 2：运行相关测试确认 GREEN**
- [x] **步骤 3：检查 schema、prompt 和 Skill 中无 agent-facing timeout 示例**

### Task 4：回归、静态检查与完成审查准备

**Deps：** `T3`（理由：消费全部实现和 fixture 迁移结果）

**WritePaths：**
- `none`（只读验证）

**Resources：** `none`

**Files：**
- Test：运行 typed dispatch、workflow spawn、runtime membrane、Goal parity 和相关 integration 测试。
- Test：运行 `npm run typecheck` 和 `git diff --check`。

**接口契约：**
- Consumes：T3 的完整测试集与最终 diff。
- Produces：可交付的验收证据；Task 4 完成后向用户申请一次单独批准，再派发 reviewer 审查整体完成情况。

**验收标准：**
- public typed subagent schema 不接受 timeout 自定义值。
- coding/generic 派发成功路径仍能工作。
- 内部 timeout 保护和终止路径仍有测试覆盖。
- 类型检查和相关回归全部通过，失败项有明确归因，不增加预防性兼容分支。

- [x] **步骤 1：运行 typed facade、schema、codec 与 workflow 回归**

运行：

```bash
node --test \
  test/subagent-dispatch-ir.test.mjs \
  test/subagent-dispatch-ir-coercion.test.mjs \
  test/subagent-dispatch-schema-coercion.test.mjs \
  test/subagent-dispatch-schema-security.test.mjs \
  test/subagent-dispatch-validation-errors.test.mjs \
  test/subagent-workflow-spawn.test.mjs \
  test/subagent-runtime-membrane.test.mjs \
  test/subagent-dispatch-rpc.test.mjs
node --test test/subagent-dispatch-extension.test.ts
```

预期：全部 PASS；不得仅依赖根 `npm test`，因为它不包含 `.test.ts` 和部分 `.integration.mjs`。

- [x] **步骤 2：运行 Goal、workspace 与真实 workflow 兼容回归**

运行：

```bash
node --test \
  test/goal-subagent-dispatch-parity.test.mjs \
  test/goal-engine-dispatch.integration.mjs \
  test/goal-engine-executor-binding.integration.mjs \
  test/subagent-model-selection.integration.mjs \
  test/subagent-managed-worktree.integration.mjs \
  test/pi-subagents-project-workflow.integration.mjs
```

预期：全部 PASS；环境性 skip 必须单独记录。若任一行为失败，回到其所属 Task WritePaths 修复并重跑，不在只读 T4 中临时改文件。

- [x] **步骤 3：运行静态检查和变更范围检查**

运行：

```bash
npm run typecheck
npm --prefix packages/pi-subagents-enhanced run typecheck
git diff --check
git diff --name-only -- pi/settings.json packages/pi-subagents-enhanced/node_modules
```

预期：类型检查与 diff 检查通过；`pi/settings.json` 和 upstream 安装目录没有本计划产生的变更。

- [x] **步骤 4：向用户申请计划完成后的 reviewer 审查批准**
- [x] **步骤 5：获得批准后派发 reviewer 执行一次整体 review，并根据意见修复**

## 实际验收结果

- typed facade/schema/codec/workflow 核心回归：`143/143` 通过。
- 最终 reviewer：未发现阻断性缺陷；唯一 P3 finding 为 generic facade collector 默认值缺少调用点覆盖。
- P3 收尾：新增虚拟时钟回归，证明 workflow timeout 为 `undefined`，collector 在 `120_000ms` 精确触发；`test/subagent-workflow-spawn.test.mjs` 为 `20/20` 通过。
- `test/subagent-dispatch-extension.test.ts` 当前 `28/29` 通过；唯一失败是本计划前已存在的 RPC diagnostic strict-reference 断言。
- Goal/workspace 验收为 `59 pass / 13 fail / 3 skip`；失败归因为缺失 Host peer 与既有 model-selection 断言矛盾，不是 timeout 边界回归。
- 根 TypeScript 检查通过；增强包 TypeScript 检查被缺失 Host peer 阻断；`git diff --check` 通过。
- `pi/settings.json` 与 `packages/pi-subagents-enhanced/node_modules` 没有本计划产生的变更；交付时必须按文件/hunk 隔离其他并行工作区变更。
