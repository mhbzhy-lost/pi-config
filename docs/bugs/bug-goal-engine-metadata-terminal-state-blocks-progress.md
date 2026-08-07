# Goal Engine 元数据终态阻塞正常推进

- **现象**：元数据审批已 `CONSUMED` 或 `REJECTED` 后，`goal_status` 虽恢复普通 DAG/discovery `machineAction`，却可能单独把响应 params 改写为 `triage`，与持久化 `actionOffer.params` 不一致；reject 后的 base metadata 漂移还可能改报 `REPROPOSE_REQUIRED`。
- **影响**：显示给调用方的 action/token 不能作为同一签发 offer 的准确能力；拒绝这一终态审计可被后续 base 漂移覆盖，造成错误的重提议流程。
- **根因**：terminal 响应在 `issueActionOffer` 后使用不同的 machineAction 形状；metadata 状态选择先检查 base stale、后检查 reject。
- **触发条件**：同会话 proposal 成功 apply 后或用户 reject 后查询 `goal_status`；尤其 reject 后追加合法 `goal.contract_amended` base metadata 事件时。
- **修复方案**：`CONSUMED`/`REJECTED` 的响应 machineAction（tool/params）和 `action_token` 必须逐项来自 authoritative projection `actionOffer`；`REJECTED` 为终态审计，优先于 base stale，只有 `APPROVED` 受 stale 影响。
- **验证与回归**：每次 terminal `goal_status` 后读取 projection.actionOffer，深比较 tool/params/token；reject runtime 回归先取得普通 `goal_amend` 形状，追加合法 base amendment 后仍断言 `REJECTED` 与同一 offer 形状；保留既有 metadata 主流程 GREEN。
