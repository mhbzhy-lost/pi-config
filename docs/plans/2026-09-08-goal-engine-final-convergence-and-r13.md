# Goal Engine 最终收敛与 R13 验收实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**状态：** active；替代 `docs/plans/2026-09-07-goal-engine-minimal-convergence-and-acceptance.md`。

**基线：** `24bce3844d6eb7a1df48dac615d9b010988b29e7`。

**目标：** 修复当前唯一 Goal integration 断言，收口 Root Broker terminal-proof 内核，恢复完整静态与行为验收，在具备交互式 `openai-codex` 登录的环境中完成一次真实 binding smoke 和两轮独立三任务 R13 canary；最终保持 Manual Preview，不自动 cutover。

**架构：** 当前 Goal v1 public 闭环、Host-owned `RunAuthorization`、canonical workspace service、production final-review provider 均视为既有基线，不重复建设。终态证明只收敛共同的安全读取、解析、接纳和 snapshot 内核；同步 snapshot、settlement、restart、stop/poll 仍可作为不同生命周期 wrapper 存在。真实 canary 使用 env-gated Pi RPC、真实 production extensions、真实模型与 typed subagent，不将默认 skip、fixture 或 stub 计为 R13 证据。

**技术栈：** Node.js `>=22.19.0`、TypeScript 7、Node test runner、Pi `0.84.4` RPC JSONL、`pi-subagents-enhanced`、`pi-subagents@0.62.0` compiled runtime、managed workspace service、`openai-codex/gpt-5.6-luna`。

## 全局约束

- R13 完成前禁止使用 Goal Engine 执行、编排或验收本计划；实现只能由主 agent 按本计划 DAG 编排 subagent executor。
- production、配置或 Skill 行为修改必须 TDD：中文问题记录、精确 RED、观察正确失败、最小 GREEN；测试只验证行为。
- Root 主 agent 不直接编辑 production 或测试代码；仅维护计划、编排、证据核准和用户决策。
- 不恢复旧 T0–T7 工作，不重复实现已经提交到当前基线的 v1 writer、RunAuthorization、workspace receipt、settle、owned-stop、DAG offer、final-review provider 或 typecheck。
- Goal v1 是唯一新写 generation；Goal v2 仅 exact replay/read-only。Host/Broker authorization protocol 的版本不等同于 Goal generation。
- terminal proof 只能来自已授权、已绑定 run 的官方 `process-terminal.json` 或对应已验证内存事件；status、日志、caller evidence、facade observation 和模型自报都不能成为 proof。
- `scripts/` 不新增共享实现，禁止扩张 `scripts/lib/`；production 实现归 `src/goal-engine/` 或 `packages/pi-subagents-enhanced/src/`。
- package 深层 upstream import 只能集中在 `src/compat/pi-subagents-0.62.ts`；不得新增通用库、vendor 副本、自定义 loader、`NODE_PATH` 或全局绝对 import。
- TUI 精简只能发生在 renderer，不能改写 agent/tool/event/session 原始数据。
- 异常必须按 production 可达、测试制造、环境缺失或来源未证实分类；来源未证实时 fail closed，禁止预防性 fallback。
- 禁止 raw `git worktree` mutation、reset、restore、stash、强制清理及未授权历史资源处置。
- 不执行 `git add` 或 commit，除非用户另行明确授权。
- `pi/settings.json.enabledModels` 与 `pi/models.json` 本机定义不得提交；真实认证只能通过 Host 安全 resolver，agent 不读取、复制、请求、记录或复述凭据。已验证的 fresh Host 必须保留 `PI_CODING_AGENT_DIR=/Users/mhbzhy/pi-config/pi`，不得切换到未认证的默认 agent root。
- Doctor 的历史 orphan/legacy warnings 不构成清理授权。
- 长耗时、真实模型、两轮 canary 只能由 subagent 执行；使用事件和 deadline，不轮询。

## 当前已验证基线

- staged：0；unstaged tracked：0；untracked 历史材料 15 项，执行时重新核对。
- `npm test`：796/796。
- Root Broker / authorization / workspace focused：65/65。
- `npm run test:goal-engine`：1072/1073；唯一失败是 RPC diagnostic options 断言边界。
- 默认 real canary：6 pass / 1 env-gated skip。
- typecheck、package verify、Doctor、diff checks：通过。
- 真实 env-gated smoke 仍受 standalone Pi `openai-codex` 登录前置约束；skip 不是成功证据。

## Definition of Done

1. Goal/non-Goal spawn options 与 wire envelope 的身份/诊断边界有精确测试，完整 Goal suite 全绿。
2. Root Broker 只有一个 terminal artifact 安全读取/解析/accept/snapshot 内核；settlement、snapshot、restart、stop/poll wrapper 职责清楚且无重复 authority。
3. typecheck、package verify、Root Broker、Goal、unit、Doctor、Pi runtime 和 diff checks 在同一当前基线全部通过。
4. fresh Host 保留 `PI_CODING_AGENT_DIR=/Users/mhbzhy/pi-config/pi`，且通过公开 model catalog 证明 `openai-codex/gpt-5.6-luna` available；不复制凭据，也不要求重复登录。
5. env-gated `real root RPC binds one Goal typed subagent` 真实运行通过，RPC events、ToolResult details 与 Goal ledger binding 一致。
6. 两轮 fresh Host 三任务 canary 连续通过，覆盖 exact-eight、真实 typed child、失败/处置/修订/恢复、settle/integrate/accept/finalize、reload/restart 和资源审计。
7. 两轮没有新增 orphan workspace、lease、runner、missing receipt 或未分类债务；最终总结明确 Manual Preview、未自动 cutover、未提交。

## DAG

```text
P0（RPC diagnostic options 边界） ─┐
                                  ├──> P2（全矩阵验收） ──> P3（真实 one-task smoke） ──> P4（两轮三任务 R13）
P1（terminal-proof 内核收敛） ─────┘
```

## Waves

- Wave 1：P0、P1。二者分别写 dispatch extension 与 Root Broker；若 P1 需要修改同一 dispatch extension，必须等待 P0 完成后重放 RED，不能并发写同一路径。
- Wave 2：P2，等待 P0/P1 当前证据全部通过。
- Wave 3：P3，等待 P2 通过和用户完成交互式登录。
- Wave 4：P4，等待 P3 真实 binding smoke 通过。

**关键路径：** `P0/P1 → P2 → P3 → P4`。P0 与 P1 都阻塞 P2；P3 的环境门禁是保留已验证的 project agent root 与目标模型 available，不复制凭据、不切换 agent root。

---

### P0：冻结 RPC diagnostic options 与 wire identity 边界

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-08-subagent-rpc-diagnostic-options-boundary.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `test/goal-engine-executor-binding.integration.mjs`
- `test/subagent-dispatch-rpc.test.mjs`

**Resources：** 无真实 provider；使用确定性 RPC mock。

**Files：**
- Create：中文边界记录。
- Modify：仅在测试证明 production 错误时修改 dispatch extension。
- Test：Goal executor-binding 与 RPC wire tests。

**接口契约：**
- Goal coding spawn local options exact 包含：
  ```ts
  {
    requestId: `goal-executor-${ticketId}`;
    spawnKey: `goal-executor-${ticketId}`;
    diagnostic: { toolCallId: string; sink: unknown };
  }
  ```
- non-Goal coding/generic 不得携带 Goal `requestId/spawnKey`；允许 local-only diagnostic 的事实必须由当前公开 extension contract 证明。
- wire envelope 只消费 `options.requestId`；`spawnKey` 与 `diagnostic` 不进入 RPC JSON request。

**验收标准：** 当前唯一 1073 中的失败被正确分类；Goal identity、non-Goal 无 Goal claim、wire 无诊断泄漏同时成立。

- [ ] **步骤 1：建立精确 RED 与 provenance**

运行唯一失败并捕获 `rpc.spawn(params, options)` actual keys；记录 `subagent.execute → executeCoding → spawnWorkflowLeaf → rpc.spawn` 调用链。

```js
assert.deepEqual(Object.keys(goalOptions).sort(), ["diagnostic", "requestId", "spawnKey"]);
assert.equal(goalOptions.requestId, goalOptions.spawnKey);
assert.equal(Object.hasOwn(nonGoalOptions ?? {}, "spawnKey"), false);
```

- [ ] **步骤 2：冻结 wire RED**

在 RPC test 中断言发送 JSON 只有 protocol 支持的 request identity，不含 `spawnKey`、diagnostic sink 或 toolCallId。

- [ ] **步骤 3：运行 RED**

```bash
node --test test/goal-engine-executor-binding.integration.mjs test/subagent-dispatch-rpc.test.mjs
```

预期：只有当前边界不一致断言失败；spawn 行为本身成功。

- [ ] **步骤 4：最小 GREEN**

若 actual local diagnostic 是已支持行为，仅改过期 fixture；若 diagnostic 或 Goal identity 泄漏到 wire，最小修改 `extension.ts`/RPC call boundary。不得删除 tracing、不得让 non-Goal claim Goal ticket。

- [ ] **步骤 5：验证**

重跑步骤 3、package typecheck/verify 和 `git diff --check`，预期全部通过。

---

### P1：收敛 terminal-proof canonical 内核

**Deps：** `none`

**WritePaths：**
- `docs/bugs/2026-09-08-root-broker-terminal-reader-convergence.md`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `test/root-subagent-broker.test.mjs`
- `test/root-subagent-broker-protocol.test.mjs`
- `test/root-subagent-broker-r10b-suspension.integration.mjs`

**Resources：** 每例独立 async temp dir；Root Broker 文件独占写入。

**Files：** Modify/Test 均为上述路径；只有 settle 接线证明仍有缺口时，另行向用户/协调器申请 `src/goal-engine/extension.ts`，本任务不得预先扩大。

**接口契约：**
- 共同 canonical core：安全 artifact 读取 → `parseProcessTerminal` → `acceptTerminalProof` → `executorProofSnapshot`。
- settlement 唯一异步入口：
  ```ts
  inspectExecutionProofForSettlement(runId: string): Promise<ExecutionProofEnvelope | null>
  ```
- 同步 snapshot 只读内存事实；restart 返回 observed/attention；stop/poll 保留 cancellation、timeout、cleanup 语义。它们是 lifecycle wrapper，不是平行 authority。

**验收标准：** 不追求“只有一个函数名”；追求一个 authority 内核。删除只发生在无生产调用、替代测试、restart/stop 语义和 replay 证据同时满足后。

- [ ] **步骤 1：调用方与 shape inventory**

列出 `inspectExecutionProof`、`inspectExecutorProofAsync`、`recoverExactTerminalProof`、`pollTerminalArtifact`、registry wrappers 的所有生产调用方和返回 shape，写入问题记录。

- [ ] **步骤 2：建立重复 authority RED**

用真实 writer artifact 验证 settlement/restart/stop 对同一 authorized run 使用相同 parser、proofId、outcome 与 conflict 事实；任一 wrapper 独立解析或接受不同字段时测试失败。

- [ ] **步骤 3：安全负例 RED**

覆盖 `0600/0644`、owner uid、普通文件、非 symlink、`nlink=1`、foreign runId、malformed、non-observed、conflict、status-only、facade-only、未绑定。

- [ ] **步骤 4：最小收口**

抽取或复用 server owner 内已有安全 reader；settlement、restart、poll 只组合该内核与自己的生命周期返回值。不得改变 public tool schema、不得将 restart attention 折叠成 settlement proof。

- [ ] **步骤 5：条件化删除**

仅当 `rg` 无生产调用且 focused tests 覆盖替代路径时删除旧 wrapper；否则保留并在记录中说明其独立职责。

- [ ] **步骤 6：验证**

```bash
node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/root-subagent-broker-r10b-suspension.integration.mjs
npm --prefix packages/pi-subagents-enhanced run verify:package
npm run typecheck
git diff --check
```

---

### P2：同一基线完整分层验收

**Deps：** `P0`（RPC 边界 GREEN）、`P1`（proof wrapper/内核 GREEN）。

**WritePaths：**
- `docs/summaries/2026-09-08-goal-engine-final-convergence-verification.md`

**Resources：** 长测试由 executor 执行；不调用真实 provider。

**Files：** Create 验证总结；本任务不修 production。发现失败时按 owner 回流 P0/P1 或新增经用户批准的精确任务。

**接口契约：** 消费 P0/P1 当前代码与测试证据，产出可复现命令、exit、总数、失败分类和当前 Git/资源 inventory。

**验收标准：** 下列命令全部同轮通过；不存在 skip 被计成 real canary 成功。

- [ ] **步骤 1：静态与 package**

```bash
npm run typecheck
npm --prefix packages/pi-subagents-enhanced run verify:package
```

- [ ] **步骤 2：Broker/authorization/workspace focused**

```bash
node --test test/root-subagent-broker-protocol.test.mjs test/root-subagent-broker.test.mjs test/root-subagent-broker-r10b-suspension.integration.mjs
node --test test/subagent-run-authorization.test.mjs test/goal-engine-executor-binding.integration.mjs test/goal-engine-extension.integration.mjs
node --test test/goal-engine-managed-disposition.integration.mjs test/goal-engine-managed-workspace.test.mjs test/subagent-managed-worktree.integration.mjs
node --test test/goal-engine-final-review.integration.mjs test/goal-engine-finalization.integration.mjs test/goal-engine-finalize-extension.integration.mjs
```

- [ ] **步骤 3：完整行为矩阵**

```bash
npm run test:goal-engine
npm test
npm run test:integration
npm run doctor
git diff --check
git diff --cached --check
```

- [ ] **步骤 4：记录边界**

记录实际总数、Node/Pi/package版本、staged/unstaged/untracked、Doctor warnings 分类；不清理历史资源。

---

### P3：执行 env-gated 真实 one-task RPC binding smoke

**Deps：** `P2`（完整矩阵同轮 GREEN）、环境门禁（fresh child 保留 `PI_CODING_AGENT_DIR=/Users/mhbzhy/pi-config/pi`，公开 catalog 中目标模型 available）。

**WritePaths：**
- `docs/summaries/2026-09-08-goal-engine-final-convergence-verification.md`
- `test/goal-runtime-real-canary.integration.mjs`（仅当当前 smoke helper/断言有经本地 RED 证明的测试缺陷）。

**Resources：** `/opt/homebrew/bin/pi`、`openai-codex/gpt-5.6-luna`、单一真实模型/typed child；总 timeout 900 秒。

**接口契约：**
- Gate：`PI_RUN_GOAL_REAL_CANARY=1`。
- RPC 严格 LF JSONL、`StringDecoder`、prompt response → events → `agent_settled`。
- Goal ToolResult 从 `result.content[]` JSON 读取；subagent binding 从 `result.details.runId/asyncDir` 读取。
- temp Goal/workspace state root 通过 authoritative locator；删除全部 child `PI_SUBAGENT_*` markers，但不读取/打印其他环境或 auth。

**验收标准：** 一次运行成功；禁止失败后边改边无限重试。若 child 在目标模型已公开 available 的同一 agent root 中仍报认证缺失，先判定 spawn env 丢失/覆盖，不能要求重复登录或复制凭据。

- [ ] **步骤 1：环境门禁确认**

用公开 `--list-models` 或 `ModelRuntime.getAvailable()` 仅确认目标模型 available，并断言 child env 保留精确 `PI_CODING_AGENT_DIR`；不打开 credential store。

- [ ] **步骤 2：默认无费用测试**

```bash
node --test test/goal-runtime-real-canary.integration.mjs
```

预期：local tests 通过，real smoke 明确 skip。

- [ ] **步骤 3：运行一次真实 smoke**

```bash
PI_RUN_GOAL_REAL_CANARY=1 node --test test/goal-runtime-real-canary.integration.mjs
```

预期：真实 Goal entry + subagent runtime；`goal_init → goal_status → goal_dispatch → subagent`；contract/task/hash、ToolResult details 与 Goal ledger `executorBinding` 的 runId/asyncDir 一致；无 extension_error、无 Facade conflict。

- [ ] **步骤 4：资源审计**

确认 temp subprocess/session/state/workspace 全部清理，主仓库未新增 Goal/workspace/runner 债务。

---

### P4：两轮 fresh Host 三任务 R13 canary

**Deps：** `P3`（真实 one-task binding smoke GREEN）。

**WritePaths：**
- `docs/summaries/2026-09-08-goal-engine-final-convergence-verification.md`
- `test/goal-runtime-real-canary.integration.mjs`（仅实现 env-gated multi-task test/helper，不改 production）。

**Resources：** 两个独立 fresh Pi RPC Host；`openai-codex/gpt-5.6-luna`；每轮最多 900 秒，串行。

**Files：** Modify canary 与总结；禁止 production 修改。若 canary 揭示 production 缺陷，停止并建立新的用户批准任务，不在验收任务修复。

**接口契约：**
- 每轮不同 temp repo、agent/session、Goal root、workspace root、runId、action token、approval entry。
- 三任务 DAG：至少一个前置实现任务、一个依赖任务、一个验收/恢复任务；全部 writePaths/criteria 精确。
- RPC user prompt 驱动 root model 调用工具；不能直接调用 tool handler/coordinator。
- final approval 必须是新的 RPC user message/session entry；production final-review provider 必须真实调用明确模型。

**验收标准：** 两轮连续通过，不复用任何 authority/resource；至少覆盖一次受控 failed/blocked → disposition → amend/resolve → redispatch，以及正常 settle/integrate/accept/finalize。

- [ ] **步骤 1：本地 multi-task harness RED/GREEN**

在不调用模型的测试中验证两轮环境隔离、最大 continuation 数、deadline、UI response、abort/finally cleanup、证据收集和禁止 identity 复用。

- [ ] **步骤 2：第一轮 fresh Host**

真实运行三任务 DAG，保存 RPC JSONL、tool events、Goal ledger、Broker proof、workspace receipts、final review result references 与资源 inventory。

- [ ] **步骤 3：第二轮 fresh Host**

全新环境重复同一验收矩阵；不得复用第一轮 token/session/workspace/approval。

- [ ] **步骤 4：最终回归**

重跑 P2 全矩阵；任何失败或新增资源债务均使 R13 FAIL/BLOCKED。

- [ ] **步骤 5：写最终总结**

总结逐项映射 Definition of Done，记录真实 provider/model runtime metadata、两轮时序和残余风险；明确 Manual Preview、未自动 cutover、`noStagedFiles` 真实值和历史 warnings 非清理授权。

## 计划自检

- **旧计划处置：** 09-07 计划已标记 superseded，全文保留，不再重复执行。
- **当前问题覆盖：** 唯一 Goal suite failure 归 P0；proof 平行内核归 P1；完整回归归 P2；auth/smoke 归 P3；R13 两轮归 P4。
- **过度建设控制：** 不强制删除有独立生命周期职责的 wrapper；不新增 generation、event、projection、workspace service、RPC production library或通用 package。
- **DAG 一致：** P0/P1 并行，P2 汇合，P3 依赖人工登录，P4 依赖真实 binding。
- **TDD：** P0/P1 行为变更必须 RED→GREEN；P2 是只读验收；P3/P4 的 harness 先本地测试，真实运行不用于边跑边猜修。
- **安全：** 不访问 credential、不清理历史 resources、不用 Goal Engine 自举、不提交。
