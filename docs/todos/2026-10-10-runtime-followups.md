# Runtime 后续待办（不纳入当前现代化计划）

本文是待办账本，不是实施计划，也不构成自动执行、真实流程验证、系统权限申请或提交授权。当前 `docs/plans/2026-10-10-pi104-runtime-modernization.md` 继续按既定 DAG 推进；以下三项均未实施。

## 三项遗留任务

- [ ] **主会话空闲系统通知**（用户明确暂缓实现）
  - 已确认产品条件：`agent_settled` 且全部成功派发并登记的 subagent 不活跃；paused 与终态都算不活跃。登记表提供 ID 集合，逐 ID 查询 status，不用本地计数推断。
  - 新活动使旧通知候选失效，status 查询失败或身份不明不发送；不另加任务成功、workspace 释放、terminal proof 或 completion 消费要求。
  - macOS `osascript` 可发系统通知，常驻样式由系统设置决定，不能保证永久常驻。
  - 依据：`docs/decisions/2026-10-10-idle-system-notification.md`。
  - 后续必须结合下述 heartbeat 覆盖缺口核实登记及主会话生命周期，不能把“所有 child 都受 heartbeat 保护”当作已证事实。尚未发送通知或申请权限。

- [ ] **纯派发回执选择性关闭 `triggerTurn`**
  - 以相对于本仓 subagent tool 最终返回的有效新增信息为判据。重复 child ID、仍在运行、空 results 与诊断路径通常无需单独唤醒主 agent。
  - 候选范围仅无实际结果/错误/需决策事项的纯派发回执；真正完成、失败、部分结果、决策请求及混合批量通知保持原语义。
  - 方向为仅改变投递 options 的 `triggerTurn`，消息仍投递、持久化、可供后续上下文使用，保 TUI、投递确认与下游事件；不是静默丢弃，也不是纯 TUI 化。
  - 精确选择器与信息对照必须在实施时核实，不复用会误匹配批量首行的宽正则，不全局关闭 subagent 通知唤醒。
  - 依据：`docs/decisions/2026-10-10-idle-system-notification.md` 的 triggerTurn 补充，以及 `/tmp/pi-workflow-dispatch-receipt-context-impact.md`（报告部分“必须入会话/首次 child ID”结论已在决策记录中纠正）。

- [ ] **heartbeat / 主进程意外退出后的孤儿清理覆盖**
  - 静态诊断显示：完整绑定的 managed/coding child 有 broker 15 秒续租、60 秒 lease、child 5 秒检查；正常调度前提下主进程 SIGKILL 后约 45–65 秒终止 runner。
  - 现有保证并非全覆盖：generic detached、绑定失败的 child 及 runner 执行的独立 bash/后代进程存在清理缺口；自终止只有 SIGTERM，未证明强制升级或全部后代清理。
  - 依据：`/tmp/pi-heartbeat-parent-death-orphan-cleanup-current.md`，静态报告，未做真实 parent-SIGKILL 端到端实验。
  - 后续先核实合法 production 入口、权威身份、启动/ACK/lease/进程顺序与实际首偏离，完成数据来源分类，才设计最小修复及获授权的隔离验证。不要把独立 session-owner registry 测试当 subagent 清理证据。
  - 不在本轮扩大 broker 能力、改变 child 生命周期、运行危险 kill 实验或增加预防性 fallback。

## 另外两项独立调查（不混入上述三项）

- RPC `rpc:v1/session` 协商失败：`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`，来源待证，按用户要求现代化后处理。
- supervisor reply/pending/steer 视图差异：`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`，门禁与消费窗口已解释，存疑样本及产品限制保留待查，未修控制面。

以上条目保持未勾选；现代化结束不自动解释为以上实施已获授权。
