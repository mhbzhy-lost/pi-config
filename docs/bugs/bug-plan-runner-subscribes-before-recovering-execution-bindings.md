# Plan Runner 在恢复 execution binding 前订阅 lifecycle

## 1. 现象

task63bd 的真实 flat Harness 在 `765a83e` 加两批准 dirty migration 的基线上只运行一次，结果为 RED：第三代有限 Plan Runner 在两个 Executor 已成功退出后没有 assistant tool call；两个 attempt 仍为 `active`，`resultCommit` 为 `null`，后续没有 `attempt.settled`、integrate、verify 或 `validated`。这说明 completion fact 没有被下游消费，turn 可能在恢复完成前已被 lifecycle follow-up 提前触发。

该次 exact Harness 的唯一命令是：

```sh
PLAN_HARNESS_PRESERVE=1 PI_REAL_BIN=/opt/homebrew/bin/pi node --test test/plan-flat-runtime-harness.integration.mjs
```

它在约 33 秒后超时，TAP 为 `tests 1`、`pass 0`、`fail 1`。报告记录了三代 Plan Runner，而不是预设代数；每代之后都有前一代 official `process-terminal.json` 的 observed exit 0。两名 Executor 都执行固定 bash、提交 Git、输出 fenced acceptance，并有 official terminal observed exit 0。

## 2. 真实证据/反证

task63bd 报告的三来源精确一致：Plan Runner 的 assistant `subagent` 调用恰好两个唯一 handle，匹配的 `tool_result` 恰好两个成功结果，实际顶层 async run 目录也恰好对应两名 Executor。两者分别具备非空 runId，故 exact-once dispatch 已被证明；这不是重复派发、provider marker，亦不是 Executor acceptance 失败。

报告还确认：没有 fanout 子授权冲突；恢复后的 Plan Runner descriptor 不带 `tools`，Executor descriptor 有预期 inventory；两个 Executor 的提交分别为 `4ef16ec` 与 `b8f1c99`。受管 root 经 realpath 边界验证后清理，最终为 `ENOENT`；所有收集 PID 探测为 `ESRCH`；批准 migration 的内容和 diff hash 不变，index 不变。

第三代没有 assistant tool call 是启动或 flush 缺口的重要现象，但保存物没有 Broker journal。因此不得虚构具体 queued push 的入队、ACK 或 FIFO flush 次序，也不能从该报告声称某一条 push 必然先于另一条。根因需要由源码顺序证实，而非把缺失 journal 补成时序事实。

## 3. 根因

第一层是安装时序。`installPlanRunner` 当前按 `bootstrapRuntimeRoots -> await rootOwned.startLifecycleSubscription -> createPiSubagentsExecutionBackend -> createDependencies -> createPlanCapsuleExtension` 执行。subscribe 的 ACK 可以同步 flush 已排队 lifecycle；Root-owned `onPush` 已确认先 `pi.events.emit`，后 `pi.sendMessage`。此时 execution backend 的 listener 尚未注册，Capsule 的 tools/hooks 也尚未注册，lifecycle fact 可直接丢失，并且 follow-up turn 可以过早排队。

第二层是 durable ledger。仅把 backend 挪到 subscribe 前仍不足以修复：revival 新建的是空 pending ledger，而 lifecycle 的 `execution.completed` 依 dispatchId、runId 与 cwd 匹配 pending request/binding。必须先从 durable Plan projection 恢复 `dispatch-requested` intent，或恢复 `active`/`waiting-attention` binding；否则 queued completion 只能产生 `LIFECYCLE_BINDING_NOT_FOUND`，而不是 `execution.completed` fact。

## 4. 正确修复

installer 应先 bootstrap roots、创建 execution backend 与 dependencies、注册 Capsule；不得在 extension loading 时订阅。Capsule 的 `before_agent_start` 应先 assert capabilities，再调用 prepare hook：从当前 projection 恢复 execution state，随后才 `startLifecycleSubscription`，最后继续既有 supersede recovery。初始 session 没有 Plan 时，prepare 为 no-op，但仍要订阅。`before_agent_start` 是私有 resume/startup turn 边界，flush 产生的 follow-up 由 Pi 正常排队，不得在加载 extension 时抢跑。

durable 恢复规则如下：

1. `dispatch-requested` 使用持久化的、精确 normalized request 调用 `recoverDispatch`，只恢复 ledger，绝不 spawn。
2. `active` 或 `waiting-attention` 必须具备 `dispatchId`、`attemptId`、`runId`、`asyncDir`、tool `cwd`、`output` 与 `sessionFile`；以 `sessionId=sessionFile` 调用 `recoverBinding`。
3. 字段缺失、跨 session 或 identity mismatch 一律 fail closed。`supersede-requested` 保持现有专用恢复，不能在新恢复路径重复扫描；`validated` 与 `integrated` 不需要订阅 completion fact。

修复不得引入 polling/sleep、由 status 文本猜测状态、module global/env/file 旁路，或修改 Broker 公共 push schema；不得借机恢复 Standalone、fanout 或 re-root。

## 5. TDD 验证

先保持以下三层 RED，再分别使其 GREEN：

1. `plan-runner-dependencies` 新测构造同时含 `dispatch-requested` 与 active attempt 的 durable projection，调用新的公开 dependency method（建议 `recoverExecutionState`），必须精确调用一次 `recoverDispatch` 和一次 `recoverBinding`，spawn 计数为 0；另测或同例子例验证 active 缺少 `sessionFile` 会 reject。
2. Capsule 既有 `before_agent_start checks capabilities before recovering an opened Plan` 增加 prepare hook，顺序严格为 `capabilities, prepare, recovery`；并证明空 projection 也调用 prepare。
3. root-subagent-broker 的 delayed real grant 测试中，installer promise 完成且尚未触发 `before_agent_start` 时 subscription 没有 runId；触发 `before_agent_start` 后恰好一个 subscription。当前分别因 method 缺失、hook 未调用和 eager subscribe 而 RED。

GREEN 修改仅限 `scripts/lib/plan/plan-runner-dependencies.mjs`、`scripts/lib/plan/plan-capsule-extension.mjs` 与已批准 dirty migration `pi/child-extensions/plan-runner.ts`。该 migration 在真实 Harness GREEN 前仍不得提交；其他 production/tests 按父级后续提交策略拆分，不能混入既有 dirty。

门禁依次包括 dependencies 与 Capsule focused tests、固定 socket root suite 的单独串行运行、相关 backend/supervisor tests，以及最终新的 task 真实 Harness exact 一次。

## 6. 影响边界

影响范围是 Plan Runner revival 的 lifecycle 恢复窗口：已完成 Executor 的 completion 无法进入空 backend ledger，或在 listener/Capsule 注册前被 flush，导致计划停在 active 而不进入 settled、集成和验证。它不推翻 task63bd 已证明的 exact-once dispatch、Executor acceptance、root 所有权或清理结果。

本文件只记录真实 Harness RED 与已确认源码顺序，不宣称修复已完成或 Harness 已 GREEN。剩余风险是缺少保留的 Broker journal，不能将诊断升级为具体 push 次序证明；修复后仍须以三层 TDD 和一次新的真实 Harness 验证完整 lifecycle。
