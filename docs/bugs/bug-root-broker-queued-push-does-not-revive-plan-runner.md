# Root Broker queued push 未唤醒 Plan Runner

## 1. 现象

真实 flat Harness 中，初始 Plan Runner 打开计划后等待 lifecycle；首次 revival 的 Plan Runner 成功派发两个 Executor。两个 Executor 都完成且 lifecycle 已到达 Root，但 Runner 仍停在 `PLAN_RUNNER_WAITING_LIFECYCLE`，没有进入 `plan_status`、integrate、verify 或 `validated`，计划状态保持 `running`。

这不是 Harness 的“总共只允许一次 revival”限制。正确不变量是同一稳定 logical caller 同时至多一个 revival；Executor 的异步完成波次可以要求第三代或更多有限 generation。最终验收应检查无 storm、每个 dispatch 一次、generation 有限且完成 validated，不能锁定总 generation 等于 2。

## 2. 真实证据与时序

证据来自 [task63an-flat-harness-provider-instance-state.md](../../.pi-subagents/artifacts/verification/task63an-flat-harness-provider-instance-state.md)，当时 HEAD 为 `84314a8`。准确 Harness 命令仅运行一次且为 RED：`PLAN_HARNESS_PRESERVE=1 PI_REAL_BIN=/opt/homebrew/bin/pi node --test test/plan-flat-runtime-harness.integration.mjs`，约 32 秒超时。

时序为：initial generation 的 `plan_open` 一次，进入 `PLAN_ROOT_WAITING_LIFECYCLE`；私有 wake 后 revived generation 的 `plan_continue` 一次；该 generation 各派发一次两个 Executor，所有 toolCallId、taskId、dispatchId、contractHash、runId 均唯一，requested-unavailable 为 0；两个 Executor 均到达 complete/lifecycle；随后没有第三 generation，也没有 `plan_status`、integrate、verify，状态仍为 `running`。

该次证据还证明唯一 Root 的严格清理：其受管临时根删除后 `realpath` 返回 `ENOENT`，四个 PID（initial Runner、revived Runner、两个 Executor）探测均为 `ESRCH`。它不把 `async-complete`、status complete、ACK 或进程终止观测当作 official proof，也不声称未产生的 validated/close ordering。

## 3. 根因

`scripts/lib/subagent-dispatch/root-broker-server.ts` 的 `lifecycle()` 仅调用 `deliverOrQueuePush()`。当 active caller 没有 subscriber 时，push 进入稳定 logical caller 的 `callerPushQueues`，但入队本身不触发 revival 检查。

即使 official proof 随后已被接受，`reviveCallerAfterProof()` 与 `performCallerRevive()` 都只认可非空 `callerFollowUps`；队列非空仍被诊断为 `wake-missing`。首次成功 revival 又会消费 snapshot 中的 explicit followup，即一次性的 `plan-opened` wake 已被删除。因此 active revived Runner 即使已有 accepted official proof，仍会因缺少 explicit wake 停止，FIFO lifecycle backlog 没有机会驱动下一代 Runner。

`async-complete` 不是 proof。唯一 event authority 仍是 official `subagent:process-terminal` 且 `state: observed`；Root 必须先接受该 proof，再转发 terminal lifecycle。不得以 `async-complete`、ACK、status stopped 或 signal 放宽该边界。

## 4. 正确修复

修复边界仅限 `root-broker-server.ts` 与 `root-broker-revival.test.mjs`，预计不需要 protocol、Capsule、provider 或 Harness production 改动。将稳定 logical caller 的非空 `callerPushQueues` 视为 Root-owned durable wake debt：它与显式 `callerFollowUps` 二选一满足 revival wake 门禁。

queue 插入后应 kick revival 检查；official proof accepted 后也应 kick；两条路径统一复用每个 logical caller 唯一的 `revivePromise`，保持 single-flight。`performCallerRevive()` 在没有 explicit followup 但 queue 非空时，可使用仅内部、已净化的 synthetic diagnostic wake label；不得扩展公开的 `caller.followup` schema 或模型参数。

成功 revival 只消费其 snapshot 的 explicit followup。queued push 必须保留至新 actual generation 以 ACK-first subscribe 建立订阅后 FIFO flush，不能在 resume 或 grant 时删除。若旧 active subscriber 在 proof 前已成功 flush 队列，proof 到达时队列为空，不得 revival；多个 queued push 合并为一次 revival 并保持 FIFO；revival 期间新增 push 要么由同一新 generation flush，要么保留为下一轮 debt。

不得改变 Capsule 去重语义，不得重装 `plan-opened` wake，不得增加轮询、sleep 或次数上限，不得恢复 Standalone、删除 alias、改变 stable logical caller 或 grant stale fence。

## 5. TDD 验证

先在 `root-broker-revival.test.mjs` 写 RED，再实施修复并转 GREEN，至少保留以下独立矩阵：

1. proof-first：official proof 先到，随后 queued lifecycle push 必须触发 resume。
2. queue-first：proof 前入队不得 resume；proof 后恰好一次 resume。
3. 两个 queued lifecycle：合并为恰好一次 revival；新 generation subscribe 后按 FIFO flush，且 ACK 前 queue 不丢失。

同时保留 alias 跨三代与 stale fence 的回归，以及 `async-complete` 非 proof 的既有回归。Harness 修复后的最终检查采用无 storm、每 dispatch 一次、finite generations、validated，而不是“exact 一次 revival”或固定两代的错误时序断言。

## 6. 影响与边界

影响面是 Root lifecycle FIFO 在 Plan Runner 暂无 subscriber、且其 Executor lifecycle 已形成 backlog 的恢复链路；当前缺口会让已完成的 Executor 无法推进计划后续阶段。该问题不改变 dispatch 去重、公开调用者协议、Runner 的逻辑身份或安全 fence。

本缺陷文档记录的是真实 Harness RED 的首个失败边界，不把它扩展为 green 结论。完整 executor acceptance ledger、official close ordering 与 `plan.validated` 仍需在授权修复后由新的 Harness 运行证明；本次不重跑 Harness。
