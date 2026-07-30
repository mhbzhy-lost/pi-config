# Bug: Cleaned spawn 重试复用上一运行的 lifecycle evidence

## 症状

Secure spawn 已 emit `async-started`，随后 Executor grant 写失败且 stop 成功，ledger 进入 `cleaned`。同 spawnKey 受控重试时，`startSpawn()` 只清除 reply/binding，没有清除 entry.started 和 pending lifecycle。若新 run 的 process-terminal 到达时新 started evidence 尚不可用，broker 会用旧 run 的 asyncDir/cwd/sessionId 补齐新 run push。

## 影响

领域 dispatchId 与新 runId 会被组合到上一运行的 asyncDir/session，child backend可能绑定错误 artifact 目录或产生错误 completion fact。最坏情况下读取上一已停止运行的产物，破坏 Attempt 与 runtime binding 的一一对应。

## 复现

1. 第一次 spawn 在 reply 前 emit run-1 started；Executor grant 写失败，broker stop run-1 成功，lookup 为 cleaned。
2. 同 key 重试得到 run-2，但不先提供 run-2 started evidence。
3. emit run-2 的真实 ProcessTerminalV1（不含 asyncDir/cwd/sessionId）。
4. 当前实现从 entry.started 取 run-1 identity并发送 run-2 completion push。

## 根因

Ledger entry 被设计为同 key重试时复用，以保留 params hash 和幂等状态；状态转换只重置 spawn reply/binding，没有把 lifecycle evidence视为单次 spawn attempt 的成员。`lifecycle()` 又允许 terminal 从 entry.started补全缺失字段，导致跨 attempt 污染。

## 修复

每次从 `not-started`/`cleaned` 进入新的 `spawning` 前，原子清空 started 与 pending lifecycle。Delivered dedupe可保留，因为 key含runId；旧证据不能保留。没有当前 run started/session evidence时，terminal不得使用旧值构造push；正常 upstream 顺序仍由新started建立证据后处理。

## 验证

增加独立 RED：cleaned retry得到新run后，在新started前emitterminal，owner不得收到execution.completed；随后emit新started只能携带新run identity。既有early-started缓存、cleaned retry、complete与真实terminal映射保持通过。
