# Subagent-Driven 计划并发 GREEN 验证

## 场景

复用 baseline 的 fresh-context 压力场景，并加载修改后的 `subagent-dispatch`：计划 DAG 为 `T1,T2 -> T3`；T1/T2 均为 `Deps=none`、`WritePaths` 不重叠、`Resources=none`。压力仍包括 dirty worktree、时间紧和希望先汇报一个结果、主 agent 协调预算少、希望逐任务 review。

判定标准不变：首次 wait/status 前必须连续派发 T1 和 T2；只有实际 dispatch failure、明确并发容量、真实依赖、资源互斥或不可隔离写冲突可以限制并发。Review 只阻塞消费相应产物的 T3。

## 结果

共运行 5 个 fresh-context 样本。5/5 均在首次 wait/status 前连续派发 T1 和 T2，0/5 选择串行。所有样本都没有把 dirty worktree、先汇报一个结果、协调预算或逐任务 review 当作串行依据。

| 样本 | 首次 wait/status 前派发 | 串行理由 | 结果 |
| --- | --- | --- | --- |
| A | T1、T2 | 无 | 通过 |
| B | T1、T2 | 无 | 通过 |
| C | T1、T2 | 无 | 通过 |
| D | T1、T2 | 无 | 通过 |
| E | T1、T2 | 无 | 通过 |

## 代表性原话

样本 C：

> T2 同时 ready、有空闲并发槽、无资源冲突且 WritePaths 不重叠，此时等待违反该 skill 的强制 work-conserving 规则。

样本 E：

> 希望逐任务 review：review 只阻塞消费该产物的后继 T3，不得阻塞另一个独立 ready/in-flight 任务。

结果证明修改后的 `subagent-dispatch` 在相同压力下稳定执行完整 ready set，并把 review 保持为局部依赖门禁。
