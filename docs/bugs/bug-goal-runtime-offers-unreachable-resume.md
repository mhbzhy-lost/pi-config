# runtime suspension 的 resume offer 不可达

## 现象

`obligation-policy` 已在 suspended runtime 的 frontier 中产生 `goal_amend / resume_runtime`，但扩展的 `goal_amend` schema 与 handler 未接受该 exact variant。因此 full suspension closure 后状态接口可签发的动作不能执行，runtime 永久停在 suspended。

## 期望

full closure 仅签发绑定 `goal_id` 与 `operation: "resume_runtime"` 的 action offer；同一次 `goal_amend` 原子追加 `goal.action_consumed`、`goal.runtime_resumed`。resume payload 必须绑定当前 `suspensionId` 和 closure hash；追加失败可重试，durable-then-throw 可通过 reload 识别已恢复且不重复。

## 回归范围

拒绝错误 token、session、goal、closure hash 和未闭合 suspension，且这些拒绝不消费 offer。该路径不处理 execution amendment 或 reverify。
