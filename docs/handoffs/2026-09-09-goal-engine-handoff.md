# Goal Engine 暂停交接文档

- 交接日期：2026-09-09
- 合同：`dispatch-ir.v1`
- 任务：暂停 Goal Engine 开发
- 当前决策：暂停；不继续实现 P4，不做新功能，不执行 cutover。

## 一、原始目标与暂停结论

本轮目标是收敛 `planned.v1` / `goal-runtime.v1` 的公共闭环：`goal_init → goal_dispatch → Host RunAuthorization → workspace/run binding → official terminal proof → goal_settle → managed disposition → goal_accept → goal_finalize`，并完成 P0–P4 的分层验证，最终仍保持 Manual Preview。

当前结论是 **P0–P3 已有真实 GREEN 证据，P4 BLOCKED/未完成**。特别是，P3 的真实 one-task smoke 已通过（16 pass / 1 skip / 0 fail）；这不是 P4 的两轮三任务 R13 证据。不得宣称 R13 完成、不得自动 continuation、不得 production cutover。

## 二、当前实测 Git 基线

本次交接以命令实测为准，而非沿用旧的 `24b` 或旧 summary：

- HEAD：`10275ad53a90e1c0afd1528db47f34af7ed89db2`
- 最新提交：`10275ad chore(git): 忽略 Pi 运行时配置与任务状态`
- 分支：`main`，与 `origin/main` 同指该 HEAD。
- staged：无（当前 `git diff --cached --name-status` 为空）。
- unstaged tracked：13 个：
  - `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
  - `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
  - `src/goal-engine/finalization.ts`
  - `src/goal-engine/suspension.ts`
  - `test/goal-engine-executor-binding.integration.mjs`
  - `test/goal-engine-finalization.integration.mjs`
  - `test/goal-engine-r10b-extension-quarantine.integration.mjs`
  - `test/goal-engine-r10b-extension-suspension.integration.mjs`
  - `test/goal-engine-suspension.integration.mjs`
  - `test/goal-runtime-real-canary.integration.mjs`
  - `test/root-subagent-broker-r10b-suspension.integration.mjs`
  - `test/root-subagent-broker.test.mjs`
  - `test/subagent-dispatch-rpc.test.mjs`
- untracked：当前主要是 13 个 Goal bug 文档、1 个 investigation、6 个 Goal 计划/summary 材料（以 `git status --short` 的完整清单为准），不等同于已提交基线。
- 当前工作区相对 HEAD 的 tracked diff：579 additions / 81 deletions；`git diff --check` 通过。

已提交基线与工作区残留必须分开审阅；本次没有 `git add`、commit、push、reset、restore、stash 或 raw worktree 操作。

## 三、已完成建设与架构边界

已完成并作为当前基线使用的建设包括：Goal v1 public 闭环基础、Host-owned `RunAuthorization`、dispatch contract/task identity 校验、managed workspace service、Root Broker official terminal-proof 读取/授权边界、settlement/disposition/accept/finalize 协议、生产入口 exact-eight 工具面、final-review 接线及 runtime canary harness。

架构边界如下：

1. Goal ledger 是业务意图、task/attempt、binding、receipt 和 finalization 状态的记录，不是 workspace 或 Git 资源权威。
2. Host/Broker 的 `RunAuthorization` 是执行身份与 capability 权威；不能按 agent 名称或同名 profile 提权。
3. Root Broker 只接受已授权、已绑定 run 的官方 `process-terminal.json`（或已验证的内存事件）；status、日志、caller evidence、facade observation 和模型自报不能升级为 proof。
4. managed workspace service 是 workspace、lease、disposition 的资源事实权威；Goal receipt 不复制第二套资源账本。
5. `goal-runtime.v1` 仍为 Manual Preview，只允许人工依据 `goal_status` 返回的 typed action 推进，不引入 auto-continuation。

## 四、P0–P3 证据状态

### P0：RPC diagnostic / wire identity

P0 已 GREEN。Goal coding spawn 保留 `requestId`、`spawnKey` 与 local diagnostic 边界；non-Goal 不携带 Goal claim；RPC wire 不泄漏 `spawnKey`、diagnostic sink 或 `toolCallId`。相关当前变更和证据见 `test/goal-engine-executor-binding.integration.mjs`、`test/subagent-dispatch-rpc.test.mjs` 及对应 diff。

### P1：Root Broker terminal-proof 内核

P1 已 GREEN。Root Broker 的安全读取、解析、接纳、snapshot 及 lifecycle wrapper 已按 authority 边界复验；identity、ownership、official observed terminal、foreign/malformed/unsafe/conflict/status-only 等负例保持 fail closed。相关当前变更见 `root-broker-server.ts`、`root-broker-registry.ts` 与 `test/root-subagent-broker.test.mjs`。

### P2：post-review2 全矩阵

P2 post-review2 全矩阵为 **GREEN**。静态检查、package verify、Root Broker/authorization/workspace focused、Goal finalization 及完整行为矩阵均以最新修复后基线复验；不把默认 skip 计为真实 canary 成功。验证摘要入口为 `docs/summaries/2026-09-08-goal-engine-final-convergence-verification.md`，旧的 `docs/summaries/2026-09-08-goal-engine-minimal-convergence-verification.md` 仅作历史 provenance，不能覆盖当前结论。

### P3：真实 one-task smoke

P3 真实 one-task smoke 为 **GREEN：16 pass / 1 skip / 0 fail**。证据包含：四个工具 `goal_init`、`goal_status`、`goal_dispatch`、`subagent` 的 start/end；dispatch contract、binding identity；typed ToolResult 的 `details.runId` / `details.asyncDir`；以及 ledger binding 一致性。四工具、binding、ledger 一致，skip 仅是默认 env-gated 真实入口的非调用分支，不能与真实通过混写。

P3 运行入口为：

```bash
node --test test/goal-runtime-real-canary.integration.mjs
```

真实 smoke 的 env-gated 入口（仅作为已完成证据记录，暂停后不得重跑）为：

```bash
PI_RUN_GOAL_REAL_CANARY=1 node --test test/goal-runtime-real-canary.integration.mjs
```

脱敏诊断由 canary harness 写入 owner 目录；本次失败/重试相关临时目录已在 `finally` 清理，不记录其秘密内容或已失效 capability。可复核的静态/本地证据在 `docs/bugs/2026-09-08-goal-real-smoke-test-missing.md`、`docs/bugs/2026-09-08-goal-canary-dispatch-result-contract.md`、`docs/bugs/2026-09-08-goal-canary-smoke-contract-and-redaction.md`。

## 五、P4 阻塞与未完成事项

P4 两轮 fresh Host、每轮三任务 DAG、失败/处置/amend/resolve/redispatch、settle/integrate/accept/finalize、真实 RPC user approval、production final review、reload/restart 及资源审计 **尚未完成**。

P4 第一轮历史真实执行失败：合法 RPC Host 中 root model 的首次 `goal_init` tool call 返回 error，随后发生 retry；exactly-one 合同因此 fail closed。由于当时 args/typed evidence 不足，来源保持 `unknown`，未运行第二轮，也未把失败伪装成成功。后续 P4 静态合同修复已完成并有 local harness 证据，但 P4 真实两轮尚未再次完成。证据见：

- `docs/bugs/2026-09-08-goal-r13-multitask-canary-missing.md`
- `docs/bugs/2026-09-09-goal-p4-canary-static-contracts.md`
- `docs/summaries/2026-09-08-goal-engine-final-convergence-verification.md`

因此 P4 保持 **BLOCKED**，不得称为 R13 GREEN 或 R13 完成。

## 六、reviewer 发现及处理项

最新独立 review 发现的三项 canonical 问题均已修复并复验，不能把 review 过程中的旧结论写成当前失败：

1. finalization canonical managed-workspace receipt：已改为消费 canonical receipt 的 state/disposition、owner attempt、Goal/service hash 与 settled verified executor head；legacy 字段只保留 replay 兼容校验。见 `docs/bugs/2026-09-09-goal-finalization-canonical-receipt-gap.md`。
2. approval shape：已按当前 public approval/manifest contract 校验，避免以旧 shape 阻塞有效 finalization。
3. suspension identity：stop request 改从 durable dispatch/binding record 取得 `contractHash` 与 `baseHead`；runtime projection 值不再作为 caller authority，caller 覆盖仍 fail closed。见 `docs/bugs/2026-09-09-goal-suspension-contract-identity.md`。

P4 的 retry、attempt、两轮 identity、canonical disposition receipt/final-review intent 和递归脱敏也已补入 local harness；这些修复不等于真实 P4 通过。

## 七、残余风险

- R13/P4 的真实多任务闭环和两轮资源隔离没有证据。
- 真实 provider/final-review 在真实三任务路径上的结果尚未证明。
- 历史 workspace/orphan/legacy warnings 未清理，且不应在暂停期间清理；它们不能被解释为本轮新债务已解决。
- 工作区有大量 tracked 修改和 untracked 材料，尚未形成安全提交边界；不能把它们整体视为可提交产物。
- 旧计划 `docs/plans/2026-09-07-goal-engine-minimal-convergence-and-acceptance.md` 已 superseded；不得沿用其中过期数字或结论。

## 八、暂停后的最小恢复路径

1. 先以新的实测 HEAD/status 和 fresh evidence inventory 重新确认本交接仍适用。
2. 逐项审阅并决定允许进入提交的 production/test/docs 文件；先排除机器配置和凭据类文件。
3. 在不修改 parser、不边跑边修的前提下，运行 local P4 harness，确认其合同证据稳定。
4. 经明确批准后，使用 fresh Host 仅运行一次 P4 第一轮；失败即停止并记录脱敏 provenance，不自动进入第二轮。
5. 第一轮完整通过后使用全新 Host/identity 运行第二轮，再做资源审计和 P2 快速回归。
6. 即使恢复路径全部通过，也只提交用户明确批准的安全范围，并继续保持 Manual Preview；cutover 需另行明确决定。

## 九、安全提交边界

后续提交审阅中**必须排除**：

- `pi/settings.json` 中的 `enabledModels`（本机机器配置）；
- `pi/models.json` 中的本机 provider/model 定义；
- 任意 `auth`、`key`、`token`、`certificate`、secret、credential store 或其导出/快照/日志；
- 任何包含秘密内容、失效 action capability 或未脱敏 provider 响应的诊断文件。

本交接只记录字段名、路径类别和非敏感相关性；没有读取、打印或记录秘密内容。安全规则优先于“全量提交”要求。

## 十、暂停状态与验证命令记录

本次交接实际执行的只读命令：

- `git status --short`：确认上述 tracked/untracked inventory，无 staged 项。
- `git rev-parse HEAD`、`git log -1 --oneline --decorate`、`git log -8 --oneline --decorate --all`：确认当前 HEAD 与提交历史。
- `git diff --stat`、`git diff --numstat`、`git diff --name-status`：确认工作区残留规模与路径。
- `git diff --check`：通过。

本次按任务约束**未运行测试、Goal Engine、真实 provider、真实 P4 canary 或长测试**；P0–P3 的验证命令和历史日志/证据路径如上文及对应 `docs/bugs/`、`docs/summaries/` 文件所示。没有修改代码、测试或配置，没有 Git 写操作。

最终状态：**暂停开发；Manual Preview；P4 BLOCKED；R13 未完成；不 cutover。**
