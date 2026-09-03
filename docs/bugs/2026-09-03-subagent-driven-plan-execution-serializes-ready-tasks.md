# Subagent-Driven 计划错误串行化 ready 任务

## 问题

用户在计划完成后的新一轮选择 Subagent-Driven 时，计划 DAG 已明确存在可并发任务，主 agent 仍可能只派发一个任务、等待并审查后再派下一个。该行为拉长关键路径，也违背用户选择 Subagent-Driven 时对 DAG 并发执行的合理预期。

## 数据来源与分类

该异常属于“预期 production 数据未被正确处理”：入口是用户对既有实现计划选择 Subagent-Driven 的合法交互；计划中的 `Deps`、`WritePaths` 和 `Resources` 都来自正常计划产物，任务身份、依赖顺序和资源事实有效。三个 control 均在 fresh context 中只读取当前 `subagent-dispatch`，没有手工拼 projection/event、绕过 public 入口、非法时间、缺字段 mock、过期 fixture 或不可达状态。

权威任务事实为同一 DAG：`T1,T2 -> T3`；T1/T2 的 `Deps=none`、`WritePaths` 不重叠、`Resources=none`。因此首次调度的完整 ready set 是 `{T1, T2}`，不存在依赖、资源或写冲突阻止并发。

## 首个偏离点与调用链

完整生成调用链为：用户在计划后的新一轮选择 Subagent-Driven → agent 加载 `subagent-dispatch` → 读取计划中的 DAG、`Deps`、`WritePaths` 和 `Resources` → 计算或隐式判断 ready 任务 → 调用 subagent 派发 → 调用 wait/status → 处理完成、workspace proof、disposition 与后继任务。

首个偏离点发生在首次 wait/status 之前：agent 已能确认 T1/T2 同时 ready，却自行把派发集合缩为 `{T1}`。当前 Skill 只约束一次派发的 `dispatch-ir.v1`、workspace 和 disposition，没有定义 work-conserving ready-set 调度循环，也没有禁止把 dirty worktree、先看一个结果或逐任务 review 当作串行理由。

## RED 证据

三个同场景 control 中，只有 1 个在首次 wait/status 前派发 T1 和 T2；另外 2 个只派发 T1，失败率为 2/3。串行样本的关键原话包括：

> 虽然它们依赖独立、写路径互斥，理论上允许并行，但当前工作树很脏，且没有资源声明可进一步证明并发安全；共享 cwd 下并发会提高归因、审查和意外越界的成本。

> 交付窗口将关闭时，先让 T1 形成一个可审查、可汇报的完成点，比承担两份并发失败或交叉污染更符合当前风险条件。

另一个串行样本明确指出规则缺口：

> 当前 subagent-dispatch 没有要求一次派发所有 ready 节点；这里顺序执行符合“减少同时在途工作”和“每个 subagent 后立即审查”，也避开 dirty source 下并行 worktree 无法创建的问题。

## 最小修复

- 在 `pi/AGENTS.md` 只维护三种执行方式的稳定路由。
- 在 `subagent-dispatch` 中定义 work-conserving DAG 循环：每轮计算 ready set；有空闲槽位时先派发所有可隔离、资源兼容的 ready 任务，再等待；完成并集成后立即重算并补槽。
- 明确只有真实依赖、资源互斥、不可隔离写冲突、用户指定并发上限或实际派发失败可以限制并发；review 仅阻塞消费相应产物的后继。
- 从 `writing-plans` 删除执行器协议，使其只生产计划并把执行选择交还全局规则。

修改后的 Skill 已在同一 fresh-context 场景中完成 5 次 GREEN 验证，全部在首次 wait/status 前派发 T1 和 T2；证据记录见 `docs/skill-tests/subagent-plan-concurrency-green.md`。
