# Runtime activation 审批使用伪造用户条目

一句话：runtime activation 输入钩子把不存在于 Pi `InputEvent` 的 `entryId`（或随机值）写入审批，导致审计条目并非真实用户消息。

## 真实 Pi 复现

1. 在真实 Pi 中创建等待 runtime activation 审批的 Goal，并调用 `goal_status` 生成 challenge。
2. 提交 ABI 规定的 `{ type, text: "approve", source: "interactive" }` InputEvent；该事件没有 `entryId`、`sessionId` 或 `occurredAt`。
3. 当前输入钩子立即以 `event.entryId || randomUUID()` 写入 decision；随后 Pi 才追加带真实 `id`、`parentId`、`timestamp` 的 user SessionMessageEntry，故审批记录绑定了伪造 ID。

## 修复方案

输入钩子只追加与当前 challenge 身份精确绑定的 canonical approval intent；下一次 `goal_status` 仅通过 `sessionManager.getBranch()` 在 active branch 配对 intent 后唯一的真实纯文本 user message，并以该 message.id 写入 decision 和 Goal approval。intent/decision 仅作为 Pi 域收据，Goal event 与 Projection 是最终权威；orphan、transfer、metadata challenge 的共享 helper 迁移留作后续债务。

## 本次补充发现

- approval intent 是审批审计收据而非 R10B 门禁；若写入 `runtimeIntentGates` 并由 `before_agent_start`、`tool_call` 的任意 gate 判断，会在审批消费后永久阻断已进入 calibrating 的 Goal。
- reload 可以从 `getEntries()` 恢复 runtime challenge/decision 收据，但 decision 只能在 active `getBranch()` 中重新证明：恰一个匹配 intent、其直接下一条且 `parentId` 绑定 intent 的真实 user message、纯文本精确 choice，以及 `userEntryId`、choice、source 一致。`getEntries()` 不能作为用户消息权威。
- R10B pending 记录暂不含真实 `userEntryId`，因此继续按 `kind=pending` fail-closed；后续 R10B 切片必须绑定真实用户条目后再扩大协议。

## Round 1 评审发现

`goal.runtime_approval_recorded` 在 append 后抛错时会以已持久化 Projection 恢复。原恢复条件遗漏本次栈内计算的 `capabilityDigest`，因此除 digest 外身份完全一致但 digest 被伪造的事件会被误认为本次成功并吞掉异常。恢复必须同时精确比对 `proposalHash`、`userEntryId`、`sessionId`、`executionContractHash`、`baseHead` 与本次 digest；只保存 digest，绝不记录原始 nonce。

同时，Pi custom metadata 是不可信恢复输入：格式错误的 decision 不得恢复审批权，格式错误的 consumed/stale/rejected tombstone 不得终结合法 challenge，格式错误的 R10B pending 不得形成 gate。测试中的 active branch 必须是连续 parent 链；已删除 user message 的 branch 不得保留其 descendant decision。

## Round 2 复现与修复

- **Pi 自动压缩配对失败**：真实 `SessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore)` 会生成 `intent → type=compaction → user` 的连续 active branch。旧代码只接受 user 是 intent 的直接子项，因而拒绝真实批准，并让遗留 intent 卡住后续配对。现在只在 `getBranch()` 中允许恰好一个、带合法 id、时间戳和连续 parentId 的 Pi compaction；随后必须是时间晚于 challenge 的真实纯文本 user。custom、assistant、system、双 compaction、断链及非法字段均 fail-closed。
- **无 decision tombstone 伪造终态**：reload 以前把精确 `{id}` 的 consumed/stale/rejected custom 收据写入 runtime 状态，攻击者无需真实 choice 就能让 challenge 终止。现在 terminal custom 仅保留为审计收据，恢复时绝不据其设置业务状态：reject 必须由 active branch 上重新证明的 decision.choice 派生，stale 由当前 projection 与 world drift 重新计算，consumed 由 Goal Projection 的 runtimeApproval/runtimeState 派生。这样合法 reject 仍可恢复，合法 approve 的 durable Goal approval 也不会被伪造 tombstone 阻断。
