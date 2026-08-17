# Scheduler adapter 范围膨胀

- 状态：已由薄膜设计替代

此前 adapter 在仓库内重写了 Store、lease/lock、timer、occurrence 和 `agent_settled` 状态机。这既复制了上游调度语义，也把上游并发和完成缺陷变成了本仓需要维护的承诺，偏离“仅隔离并选择性接受 Pi 上下文”的目标。

修复是调用精确安装的上游 default Extension，并仅在 Pi API 边界过滤注册、包装 create/delete 确认与输入扫描、标记 scheduler 消息。dataDir 通过 session_start 前设置的 canonical cwd 惰性 getter 解析；无原型冻结 facade 只暴露两种生命周期和四个受控能力。磁盘内容在 sendUserMessage 和 list/get 返回前均重新扫描、标记并截断。上游调度可靠性及完成语义仍是已知限制，不由本仓补偿。

## 终审薄膜根因与 GREEN 摘要

终审发现的剩余缺口均位于边界层：目录检查在第一个现存祖先提前返回，且仅在 `realpath` 后检查叶节点；授权摘要未移除 Unicode 格式控制符；`details: {}` 等值在清空前被接受；测试未固定实际 hash 目录、成功消息参数和输出临界值。它们不需要、也不应通过重建上游 Store、Lock、timer 或 occurrence 修复。

M1–M5 现由 hermetic adapter/runtime 测试覆盖：从绝对根逐组件 `lstat`、mkdir 前 hash 叶节点拒绝、创建后 containment/0700、唯一 session 与 `finally` shutdown、授权摘要和成功消息参数、严格 `details === undefined`，以及含来源头/marker 的 50KB 和 2000 行边界。runtime 枚举临时 state 中唯一 hash 目录而不调用 `repositoryDataDir` 制造期望路径。未新增 Store、Lock、timer 或 occurrence 实现。
