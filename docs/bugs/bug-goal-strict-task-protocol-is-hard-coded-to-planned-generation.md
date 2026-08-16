# 严格 Task 协议被硬编码为 planned generation

## 问题
现有实现以 `PLANNED_SCHEMA_VERSION` 判断 criteria-only 合同、Executor 绑定和双路径结算；因此新增 `goal-runtime.v1` 的 remediation Task 会误入旧 evidence 路径，无法获得严格绑定。

## 复现步骤
1. 以 `goal-runtime.v1` 创建 draft，并派发一个 Task。
2. 绑定 Executor 或提交 succeeded settlement。
3. reducer 因只接受 `planned.v1` 的绑定与结算分支而拒绝，或走 legacy `evidenceSource` 校验。

## 修复方案
新增冻结的 generation capability matrix；所有 Task 合同、绑定、结算、完成和 revision 判断均从该矩阵取得能力。新增 runtime draft 事件投影与严格实体状态机，并以事件重放作为快照权威来源。
