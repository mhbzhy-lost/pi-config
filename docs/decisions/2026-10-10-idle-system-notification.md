# 主会话空闲系统通知：已确认结论（实现暂缓）

## 当前状态

T5/T10 已记录当前实现缺口，通知实现继续暂缓：所查代码没有专用主会话 run registry、resume 新 ID 登记及完整的 session replacement/reload epoch 合同。缺少现成实现不代表不能新增；后续需要明确领域 owner 与生命周期设计。原有产品语义继续有效，但不能把“所有 child 派发都经过登记”当作当前源码已实现的事实。

用户已确认通知判定语义；先沉淀结论，暂不实施，不并入 `docs/plans/2026-10-10-pi104-runtime-modernization.md`。本文不是实施计划，也不构成实现、模型调用、真实 status 查询、发送系统通知或申请系统权限的授权。

## 已确认的触发条件

**主会话发生 `agent_settled`，并且该主会话派发的所有 subagent 都不活跃时，发送通知。**

- `paused` 属于不活跃，无需等待其进入终态。
- completed、failed、stopped 等终态属于不活跃。
- running、queued 及尚在执行启动/恢复流程等活跃状态不满足条件。
- 无法识别的状态、status 查询失败或身份无法确认，不能据此认定不活跃；本次不发送。
- 不额外要求所有 subagent 成功、不要求 paused 获得 terminal proof，也不要求用户先处理 paused 任务。
- 不以等待 completion 回执被消费、workspace 释放或 supervisor ACK 作为新增通知条件；这些事实不是本通知的活跃性判据。

`ctx.isIdle()` / `ctx.hasPendingMessages()` 可用于异步检查完成后确认原 settled 边沿没有被新的活动打断，不改变上述产品条件，不额外扩展为“所有外部投递队列清空”的要求。新用户输入、显式 resume 或新派发发生后，旧候选通知失效。

## 本仓的统计与查询闭环

以下是已确认的目标合同，不是当前实现证明：未来实现必须先在 feature-owned owner 中补齐登记快照与 session epoch，再按逐 ID status projection 执行；本轮不创建该 registry、不调用真实 status。

1. 所有 child 派发都经过本仓 `subagent` tool。
2. 派发成功后记录其实际返回的 run ID，记录属于当前主会话；恢复成功产生的新 run ID 同样登记。
3. 登记表只用于提供完整的查询 ID 集合，**不是以本地活跃计数代替状态权威**。
4. 在 `agent_settled` 的检查中，对登记 ID 查询支持的 subagent status，按实际状态判断是否全部不活跃。
5. paused 和终态不会自行重新活跃；用户后续显式操作是新的活动，不是要求通知持续等待的理由。
6. 登记与主会话生命周期应独立核实。后续静态调查表明 heartbeat 只对完整绑定的 managed/coding runner 有条件保护，generic、绑定失败及 detached 后代不具备全覆盖保证；因此不能把“所有 child 在主会话消失后均被清理”作为通知前提。依据：`docs/bugs/2026-10-11-heartbeat-orphan-cleanup-provenance.md`。

因此：**上游没有 active-runs 全局枚举 API，不是本仓实现该通知的阻塞。**本仓可通过“唯一派发入口登记 ID + settled 时逐 ID 查询 status”闭合判定，而不依赖 EventBus started/complete 事件的无丢失计数。未来实现需核实成功回执的 ID 提取与主会话内的登记生命周期；本文未进行现场查询或真实 heartbeat 验证。

## macOS 侧结论

- `/usr/bin/osascript` 可以发送系统通知，不需要为此安装新的通知工具。
- 通知采用横幅还是提醒、是否驻留，由 macOS 的通知权限与样式设置控制，不能由发送端保证永久常驻。
- Pi 窗口内的 status/widget 与 macOS 系统通知是不同能力，不能混称。
- 不用反复定时重发伪造常驻，也不以通知失败影响 agent 或 child 的正常执行。

## 对初次研究的修正

初次只读研究位于 `/tmp/pi-idle-system-notification-feasibility.md`。它关于 `agent_settled` 公开语义和 macOS 样式限制的结论保留；以下论断被用户后续确认的本仓合同替代：

- “缺少全局枚举，所以不能准确判断全空闲”：未计入唯一派发入口与按 ID status 查询，不适用于本仓方案。
- “detached child 可跨主会话独立存活”：不能泛化为所有 child；后续静态调查也不支持“所有 child 均受 heartbeat 清理”。通知应依靠当前主会话登记/epoch 与权威 status，而不是任一无限生命周期保证。
- “paused 是否不活跃仍待产品决策”：已决策，paused 为不活跃。
- “必须等待所有 child 终态/消费完成通知”：不是用户要求，删除该额外条件。

## 派发回执的 triggerTurn 决策补充

纯派发回执可以与真实完成/失败通知区分：目标形态是单条 workflow 通知首行包含 `dispatch complete; N child(ren) running or uncollected`，且不是 `Background tasks completed (N):` 分组通知。对这类回执，当前 subagent tool 已经向主 agent 返回 root/child 控制 ID；回执新增的主要是 workflow receipt、artifact 和 resumability 定位元数据，当前没有必须立即执行的消费动作。

因此实现方向不是静默丢弃消息，而是仅对**精确识别的纯派发回执**将 `sendMessage` 的 `triggerTurn` 改为 `false`：

- `sendMessage` 仍成功投递，保留 `custom_message` 持久化、后续上下文可见性、TUI toast、result 文件确认删除和 `subagent:async-complete` 观察事件。
- 主 agent 不因这条没有新业务结果的回执立即启动/steer 新回合。
- 真正完成、失败、暂停、停止、部分结果以及分组通知不改变，继续使用其原有 `triggerTurn` 语义。
- 这不是纯 TUI / 不入上下文；若未来需要完全 UI-only，仍需 Host/upstream 提供新消息通道。
- 不能对所有 `subagent-notify` 全局关闭 `triggerTurn`，否则会抑制实际 child 完成和错误的及时处理。选择器不能复用当前会误匹配分组通知的宽标题正则，必须使用精确的单条 workflow dispatch 形态。

当前只记录该方向，未修改生产代码、未发送通知、未关闭任何 triggerTurn；本轮 T5/T10 暂缓实现，未来需先完成登记/epoch 合同、修订确切 WritePaths 并取得实施授权。triggerTurn 的当前调查与限制另见 `docs/decisions/2026-10-11-dispatch-receipt-trigger-turn.md`。
