# `goal_finalize` 不能与 planned 自动完成语义混用

- **问题描述：** 旧终审方案若原地接管 `planned.v1` 的完成路径，会破坏最后一个 Task `accept` 自动追加 `goal.completed` 的历史语义。
- **复现步骤：** 创建一个仅含一个 Task 的 `planned.v1` Goal，完成 settle、integrate 后 accept 最后 Task；若该路径等待或签发 `goal_finalize`，则兼容性已被破坏。
- **修复方案：** 将 `goal_finalize` 冻结为 Root ABI 的第八个工具；所有现有 generation 在任何持久化、评审或资源副作用前返回 `FINALIZATION_UNSUPPORTED_GENERATION`。R11 才为 `goal-runtime.v1` 接通终审。
