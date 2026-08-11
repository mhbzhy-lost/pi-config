# 新会话继承未归属 Active Goal

## 现象
同一 canonical cwd 中，session A 已创建并绑定 active Goal 后，新 session B 会收到 A 的 recovery，`goal_status` 会隐式选中 A 并可能签发 action offer，且 `goal_init` 会被 A 阻止。

## 影响
不同 Pi session 可读取并尝试操作彼此的 Goal，破坏会话隔离；错误 token 或显式 `goal_id` 路径可能触及事件、registry 或 workspace。

## 复现条件
1. session A 在仓库根目录创建 active Planned Goal。
2. 使用相同 cwd 创建全新 session B。
3. 触发 `before_agent_start` 或调用 B 的隐式 `goal_status`、`goal_init`。

## 根因
active Goal 的选择只排除当前 session 已 detached 的 binding，未要求 Goal 的 immutable owner 与当前 session 正向匹配；全局 active 列表也被直接用于隐式解析和初始化 guard。

## 修复方案
以首个 `goal.session_bound` 的 `sessionId` 为 immutable owner。仅 owner 可隐式选择、恢复、获得或消费 offer、进行 mutation；无 binding 的 legacy Goal 仅保留显式兼容。每个 session 可在同一 cwd 创建自己的 active Goal。

## 验证
使用真实 extension/session fixture 覆盖 A/B recovery、隐式 status、offer、显式越权零副作用、多 owner 并行，以及 owner reload/compaction。
