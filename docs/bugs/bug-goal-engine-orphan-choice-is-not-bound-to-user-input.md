# Goal Engine 的孤儿处置未绑定真实用户输入

## 1. 预期行为

`discard`/`preserve` 等不可逆或保留资源的分支只能来自 challenge 之后、同 session 的真实交互/RPC 用户输入；Objective/Scope/Non-Goals/DoD 修改也必须绑定用户明确批准的 proposal hash。

## 2. 实际行为

当前 recovery 只把可选动作写进 status 文本，mutation 参数不携带真实 input identity。Agent 可以把“看一下 status”解释为 discard，也能自行决定 Goal 元数据变更。

## 3. 稳定复现

TokenRec 会话中用户没有选择 discard/preserve，Agent 仍自行执行 orphan discard；Reducer/Extension 只验证 action 字符串，不验证任何用户 entry。

## 4. 根因

状态模型缺少 pending human challenge 和 recorded decision，Extension 也没有区分 interactive/RPC 用户输入与自身注入消息。

## 5. 影响范围

可能丢弃仍需检查的 workspace、保留无主资源，或未经授权改写 Goal 的 Objective/Scope/Non-Goals/DoD，审计日志无法证明选择来源。

## 6. 修复与验证

新增真实选择纯逻辑：只接受 challenge 之后、同 session、source 为 interactive/RPC 且文本精确匹配单一 choice 的 user entry；元数据审批额外绑定已展示 proposal 的 SHA-256。先写 source/session/time/歧义 RED，G6 再接入事件与工具。

G6 orphan 接线验收冻结为六要素：
1. **challenge**：首次 `goal_status` 对 verified orphan 在 session custom entry 持久化 `orphan_disposition` challenge（含 `challenge_id`、goal/task/attempt、sanitize 后 inventory 与 64 位 `inventory_hash`），只展示精确 `discard`/`preserve`；不得泄露凭据、完整 Git command 或 tool output。
2. **decision**：仅 challenge 后同 session 的 `interactive`/`rpc` 精确文本可持久 receipt；`extension` source、模糊文本、machine action 与 challenge 前输入均 fail closed，custom entry 不保存完整用户文本。
3. **consumed**：仅 discard/preserve 真正成功后持久 consumed receipt；mutation 失败保留 decision 以供重试，且同 inventory 的后续 status 可重签 token。
4. **inventory hash**：status 在签发前重新 inspect；HEAD 或 lease identity 改变即将旧 challenge 标 stale，返回绑定新 verified inventory 的新 id/hash 并重新等待选择；若变为 unverified，返回 `REINSPECTION_REQUIRED` 且无 destructive choice/token。
5. **reload/cross-session**：同 inventory 的未决重复 status 不重复写 challenge 且返回同 id；reload 保留同 session lifecycle，跨 session 不得使用旧 challenge、receipt 或 token，必须形成自己的 challenge 并等待真实 input。
6. **exact action token**：decision 后只为展示的 exact action 签 `goal_integrate`，params 精确为 `goal_id/task_id/action`，`machineAction`、`action_token` 与 projection `actionOffer` 一致；错误 action/challenge、伪造或旧 token 和跨 session 调用均不得产生 workspace side effect。

实现复审发现（仍按上述六要素冻结）：
1. **challenge**：可见 `machineAction` 与 projection `actionOffer` 曾发生分裂；当 metadata 优先且 orphan 已决定时，offer 不得混入 orphan `challenge_id`。
2. **decision**：orphan 与 metadata 是异类 challenge；共享 input `try/catch` 会使 orphan 不匹配（如 `approve`）阻断 metadata 审批，二者必须独立解析。
3. **consumed**：公开 orphan machine action 必须可原样执行，human gate 以同 session、当前 inventory 和唯一 choice 定位记录；可选传入的 `challenge_id` 仅作额外精确校验。已释放的上一 attempt 仍会保留在 projection；不得以 `!task.workspace` 判断下一 attempt 是否存在，否则 attempt 2 orphan 会绕过授权与恢复。
4. **inventory hash**：stale 是 terminal tombstone；即使 owner identity/inventory hash 回滚为旧值，也不得复活 stale record 或展示不可消费的等待态。
5. **reload/cross-session**：durable stale 在 reload、追加失败恢复和 identity 回滚后仍必须保持终态，并为当前 identity 创建新 challenge。
6. **exact action token**：metadata 与 orphan 两种可见 action 都要求 `machineAction.tool/params` 和 `actionOffer.tool/params` 精确 deep equal，token 只为这一组公开 params 签发。
