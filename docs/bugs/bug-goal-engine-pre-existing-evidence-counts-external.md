# Bug：Goal Engine 将预存证据误作外部验证

## 症状
`pre_existing` 证据会让完成判定和审计把目标标记为已获外部验证。

## 影响
历史工件存在不能证明独立评审已发生，`COMPLETE` 与健康审计会被错误提升。

## 稳定复现
提交 `source=pre_existing`、普通 `file` 证据后完成目标；旧分类把任何非 `self_produced` 来源视为外部证据。

## 根因
Extension 与 Audit 各自以“非 self”作为外部证据判断，reducer 也没有验证 evidence source 枚举和 external 类型组合。

## 促成因素
证据来源和证据类型没有由单一分类模块定义，直接重放事件可注入未知来源。

## 修复与验证策略
新增统一 evidence 分类：仅 `source=external` 且 `type=external_review` 是外部验证。reducer 在变更任务前拒绝未知来源及 external 普通证据，保留缺省来源为 `self_produced` 的历史兼容。以 self、pre_existing、混合和 external review 矩阵覆盖完成判定与审计信号。
