# Completed Goal 无法记录后续发现

## 1. 预期行为

Goal 完成后仍应作为工程上下文账本接收绑定 session 的 discovery/checkpoint；相关后续工作通过新增 task 开启新 epoch，旧 accepted task 与 evidence 保持不可变。

## 2. 实际行为

Reducer 把 `completed` 当成绝对终态，在事件分派前拒绝所有后续事件；`goal_amend` 也只接受 active Goal。

## 3. 稳定复现

完成一个单任务 Goal 后追加 discovery 或 amendment，`applyEvent` 固定抛出 `goal is terminal: completed`。

## 4. 根因

生命周期模型只表达一次性 DAG，没有区分“当前 epoch 完成”和“整个工程上下文不可再演进”，也没有持久化 observation、session binding 与 completion history。

## 5. 影响范围

小修复只能留在聊天或临时改动；compaction/reload 后无法从 Goal 恢复，Agent 也容易绕过 task/workspace/evidence 门禁直接修改。

## 6. 修复与验证

引入 v3 epoch/continuity events。completed Goal 允许只读上下文类事件，并仅在全部旧任务 accepted、相关 discovery 已转为 tasked 时 `goal.reopened`；旧 task 不可更新或删除。先写 completed→discovery→reopen RED，再验证 v1/v2 replay。
