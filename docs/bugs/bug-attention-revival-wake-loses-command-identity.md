# Bug：Attention revival wake 与 durable command 身份脱钩

## 1. 现象

真实 A2 Harness 对每个 Plan 先提交 task-2 reply，再提交 task-1 reply。Root 对四条 command 均记录了
exact `followup.accepted`，logical caller、actual alias 和 canonical session 全部正确；但每个 Plan 的
generation 2 实际收到 task-1 reply，generation 3 又重复收到同一 task-1 reply。task-2 reply 从未写入
canonical Plan session。

## 2. 证据与反证

Broker 的 wake 队列只保存 `{ wakeId, reason }`，而 `resume()` 始终发送固定文本
`A durable Root broker wake is pending.`。revived Plan Runner 不知道本 generation 认领了哪个 request，
只能扫描共享 `control/attention/*.reply.json`；该目录按文件名排序，与 Root 接受 wake 的顺序无关。

四条 wake 均有 `followup.accepted`，四次 revival 均有 `grant.issued` 和 `revival.succeeded`，所以没有在
wire caller stale fence 或 grant fence 丢失。缺失发生在正确 Plan 的 command 选择边界，不是跨 Plan
路由错误。

## 3. 根因

revival single-flight 只保证同一 logical caller 同时最多一个 `resume()`，没有把被认领的 wake identity
持久绑定到新 actual generation。`performCallerRevive()` 还会一次快照并清除当时全部 wakeId，使一个
generation 可以消费多个调度债务，却没有能力证明自己处理了对应的 durable command。

## 4. 正确修复

每个 revival generation 只认领 caller FIFO 中一个 distinct follow-up；exact duplicate 在 pending 或当前 generation-bound
状态都必须去重。Broker 在 grant 提交时把该 generation 的 wake identity 绑定到 actual run，并通过已认证的 private
bootstrap 数据提供给 Plan Runner。固定 private wake 文本保持不变，child wire
`caller.followup` 仍只接受 `plan-opened`。

Attention recovery 只选择与本 generation 的 `attention-reply-<requestId>` 匹配的 durable command。
command 成功 native reply、领域 resolved 与 ack 后，后续 official proof 才允许下一个 pending wake
创建新 generation。

## 5. TDD 验证

先增加 Broker RED：同一 logical caller 在 proof 前登记两个不同 Attention wake，只允许 generation 2
认领第一条；generation 2 official proof 后 generation 3 才认领第二条。每代 private bootstrap 必须返回
唯一 exact wake identity，不能批量清空。

再增加 dependencies RED：目录同时存在两条 reply 时，传入 generation wake A 只能返回 A 的 custom
message；wake B 只能返回 B；未知或非 Attention wake不得猜测任一 command。最终 canonical session 中
每个 requestId 必须恰好一个 Supervisor call/result。

## 6. 影响边界

影响 Root-owned private bootstrap、logical caller follow-up FIFO 和 Plan recovery command 选择。不改变
public broker request schema、Root wake固定文本、Supervisor reply合同或跨 Executor FIFO。选错时会在同一
Plan 并发 Attention 首次暴露，可能把用户决定交给错误 Executor，修复代价高。
