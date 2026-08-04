# v1 amendment 重复 remove 被静默接受

## 现象
v1 `goal.created(t1 pending)` 后提交 `goal.amended(removeTasks:[t1,t1])` 被接受，投影推进到 version 2；同一重复 remove 与 `addTasks.t1`、`updateTasks.t1` 组成 replacement 时也被接受。

## 影响
历史 v1 日志与 `94654c5^` 的拒绝语义不一致：基线按 remove 顺序执行，第二次查找已删除的任务而拒绝。错误事件被写入 `events.jsonl` 并改变 projection、task map 与 registry，破坏重放一致性。

## 复现条件
以固定 v1 JSONL 写入 `goal.created(t1 pending)`，再追加 reason 合法且 `removeTasks` 为 `["t1", "t1"]` 的 `goal.amended`；可任选同时提供 `addTasks.t1` 与 `updateTasks.t1`。

## 根因
amendment 预验证将 `removeTasks` 转成 `Set`，重复 ID 在候选构造前被丢弃；之后的 `candidate.delete()` 是幂等操作，因而不再出现基线第二次 remove 的 unknown task 拒绝。

## 修复方案
在创建或修改 candidate 前按原数组检测重复 remove ID，并抛出稳定的 `duplicate remove task: <id>` 错误。v1、v2 均采用该无歧义拒绝规则；其余 remove、add、update 和 remove→add→update replacement 顺序不变。

## 防回归
固定 v1 store JSONL 用例验证纯重复 remove 与重复 replacement 均拒绝，且 events 行数、projection version、task map 和 registry 不变；同时保留单次 remove 与 replacement 成功回归。扩展含重复 ID 的差分矩阵确认 HEAD 与 `94654c5^` 的成功/失败结果一致。
