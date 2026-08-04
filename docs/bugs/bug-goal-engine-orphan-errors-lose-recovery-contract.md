# Bug：Goal Engine 孤儿派发错误丢失恢复契约

## 表现

`goal_dispatch` 检测到 verified 或 unverified orphan workspace 后，返回的 `Error` 只在 `message` 中保存 `observed`、`remediation`、`stateChanged=false`，只在对象属性中保存 `requiredNextAction` 与 `blockingReason`。任一消费边界若只保留消息文本或只读取结构化字段，都会丢失一部分恢复信息。

## 影响

- Pi Host 或跨进程边界只序列化 `Error.message` 时，verified orphan 的 `discard|preserve` 人工选择和 unverified orphan 的 `goal_status` 下一步不可恢复。
- 读取 Error 对象的调用方无法稳定取得 `observed`、`remediation` 与 `stateChanged`，只能再次解析字符串。
- status 与 dispatch 虽使用同一 inventory，但恢复信息的载体不一致，协调器可能把可恢复阻断降级为普通失败。

## 根因

orphan 门禁直接调用 `initError()` 后再零散赋值。`initError()` 只把 `code` 暴露为对象字段，其余基础字段仅拼入字符串；后续赋值又没有重建消息，因此没有一个统一构造器同时生成结构化对象和完整、可序列化的错误文本。

## 触发条件

1. projection 显示 active、pending、可重派的 task。
2. exact candidate attempt 的 workspace、lease 或 branch 资源被 inventory 分类为 `verified` 或 `unverified`。
3. 调用 `goal_dispatch`，并让调用方只保留 `Error.message`，或只读取 Error 的结构化属性。

## 修复方案

增加专用 orphan dispatch error 构造路径，一次性写入稳定 `code`、`observed`、`remediation`、`stateChanged=false`、`requiredNextAction` 与 `blockingReason` 对象字段，并把同一组值序列化进 `Error.message`。verified 多选继续使用 `requiredNextAction=null`，唯一选择集合只存在于 `blockingReason.choices`；unverified 只允许 schema-valid `goal_status`，不得加入 destructive choices。

## 验证方案

1. verified rollback fixture 调用 `goal_dispatch`，逐项断言对象字段完整，并从 `Error.message` 解析出完全相同的 `blockingReason` 与显式 `requiredNextAction=null`。
2. unverified partial-resource fixture 执行同样断言，确认对象与消息中的下一步均为 `goal_status`，且 `blockingReason` 不含 `choices`。
3. 两类拒绝前后比较 events、projection、registry、lease、refs 与 worktrees，确保错误构造不产生副作用。
4. 运行 extension、graph、workspace 及全部 Goal Engine 回归。
