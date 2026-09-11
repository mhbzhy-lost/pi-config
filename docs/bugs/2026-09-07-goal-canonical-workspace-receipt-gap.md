# Goal canonical workspace receipt public-chain gap

## 现象与首偏离

`planned.v1` public dispatch 的调用链为：`goal_dispatch` → coordinator allocation/bind → Host 返回 `managed-workspace.v1` canonical receipt → `goal_settle` → `goal_integrate` → disposition intent/terminal receipt → graph/action → `goal_accept`/redispatch。workspace service 是该 receipt 的唯一资源权威。

首偏离发生在 Goal 消费者把 public receipt 当作旧 workspace 投影：读取 `workspace.phase` 得到 `undefined`、把对象 `workspace.disposition` 拼接成 `[object Object]`、读取 `workspace.released` 得到 `undefined`。这会阻断合法 canonical fixture 的 lifecycle；orphan 检查也只比对局部字段，可能把 service snapshot 与 Goal receipt 错配。service 已 terminal 而 Goal receipt append 中断时，same-intent retry 还可能被误判为 already started。

## 根因与边界

public receipt 是完整的 `managed-workspace.v1`：`state` 和 `disposition.action/strategy`，并绑定 `owner`、`workspaceId`、`leaseId`。旧 `phase/released/string disposition` 只属于已经持久化的 legacy event replay decoder，不能作为 public coordinator 的 mutation 输入，更不能由 fixture/service 回退生成。

本修复在 `managed-workspace.ts` 建立唯一 owner-local canonical accessors。events、graph、extension 的新 public 分支只经该 receipt 读取 state/disposition/owner；snapshot identity 使用完整 public receipt，不读取 private token。terminal retry 先 inspect service；同 identity、action、strategy 的 terminal receipt 只补现有 Goal receipt event，任何 owner/action/strategy/hash drift 均由 reducer 拒绝。

## 验证 provenance

`goal-engine-managed-disposition.integration.mjs` 覆盖 active receipt 无 receipt fact、terminal intent/receipt 的 action/strategy/owner/hash drift、preserve→explicit release→redispatch。`goal-engine-managed-workspace.test.mjs` 使用真实 service allocation/status/inventory，覆盖 canonical owner/workspace/lease snapshot。bounded public integrate/retry 位于 executor binding integration tests。
