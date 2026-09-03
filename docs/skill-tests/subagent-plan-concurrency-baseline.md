# Subagent-Driven 计划并发基线

## Control 场景

三个 control 使用同一 fresh-context 场景：计划完成后的新一轮，用户选择 Subagent-Driven；agent 只允许读取当时的 `subagent-dispatch`，不读取 `writing-plans`。计划 DAG 为 `T1,T2 -> T3`，T1/T2 均为 `Deps=none`、`WritePaths` 不重叠、`Resources=none`。

场景同时施加时间紧、希望尽快汇报、主 agent 协调预算少或希望逐任务 review、当前 worktree dirty 的压力。判定标准是首次 wait/status 前是否同时派发 T1 和 T2，以及是否提出了与依赖、资源、写冲突或明确容量无关的串行理由。

## 结果

| Control | 首次 wait/status 前派发 | 结果 |
| --- | --- | --- |
| A | T1、T2 | 通过；并发派发，未提出串行理由 |
| B | 仅 T1 | 失败；以 dirty worktree、审查成本和先形成可汇报结果为由串行 |
| C | 仅 T1 | 失败；以 Skill 未强制派发完整 ready set、减少在途工作、逐任务 review 和 dirty source 为由串行 |

总计 2/3 串行，证明当前单任务派发规则不足以稳定产生 DAG 并发调度。

## 关键原话

Control B：

> 虽然它们依赖独立、写路径互斥，理论上允许并行，但当前工作树很脏，且没有资源声明可进一步证明并发安全；共享 cwd 下并发会提高归因、审查和意外越界的成本。

> 交付窗口将关闭时，先让 T1 形成一个可审查、可汇报的完成点，比承担两份并发失败或交叉污染更符合当前风险条件。

Control C：

> 当前 subagent-dispatch 没有要求一次派发所有 ready 节点；这里顺序执行符合“减少同时在途工作”和“每个 subagent 后立即审查”，也避开 dirty source 下并行 worktree 无法创建的问题。

本文件只记录修改前 control，不混入修改后的 GREEN 结论。

## 补充稳定性 Control

使用 HEAD 中修改前的 Skill 又运行两个同场景 fresh-context control：一个只派发 T1，另一个同时派发 T1 和 T2。合并最初三个样本后，旧 Skill 累计 3/5 串行、2/5 并发，进一步证明其行为不稳定；修改后的 GREEN 结果单独记录，不混入本基线。
