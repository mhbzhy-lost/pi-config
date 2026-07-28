# Bug：Subagent coding dispatch 使用无类型 task 字符串

## 1. 现象

执行 Subagent-Driven 计划时，主 Agent 通过通用 `subagent({ agent, task })` 把 coding 任务压成一段自由文本。Executor/Spark 可能误解目标、重新调查主 Agent 已确认的信息、扩大修改范围，或生成当前工具 schema 不接受的字段。

## 2. 影响

Child 会把 token 和时间消耗在重复探索上，错误方向通常到实现或 review 阶段才暴露。Parent 无法在 spawn 前机械确认 prompt 是否包含已知事实、已定决策、禁止重复工作、写入范围和验收命令，Subagent-Driven 的隔离上下文反而放大了信息丢失。

## 3. 稳定复现

给三个 fresh `delegate` 相同压力场景：计划很长、用户等待、要求控制 prompt token，同时提供完整 task 和主 Agent 已确认的调查结论；要求它们生成 executor 派发参数。

三个结果都能在本次显式材料中复述主要事实，但两个结果使用不存在的 `background: true`，只有一个使用当前 `pi-subagents@0.37.0` 的 `async: true`。所有结果仍把目标、事实、边界和验收压成一个不可验证的 `task` 字符串。真实运行中只要 parent 少复述一项，该项就会静默丢失。

## 4. 证据

当前 `skill-overrides/subagent-dispatch/SKILL.md` 只规定 executor/spark 选择和 async lifecycle，没有 handoff contract。它还没有列入 `skill-overrides/skills.list`，因此运行时 available-skills 中不存在，`pi/AGENTS.md` 的“必须遵循”无法生效。

上游 `subagent-driven-development` 要求提供 full task text 和 scene-setting context，但仍是自由文本模板；当前白名单也不暴露该 skill。`pi-subagents` 的 `SubagentParams` 对顶层执行字段有 TypeBox schema，但 `task` 只是 string，包内不会检查其语义完整性。

## 5. 根因

Coding delegation 同时混合了两个职责：主 Agent 组织结构化执行合同，以及 `pi-subagents` 启动通用 child。现有实现只提供后者，前者依赖每次 prompt 手工拼接和模型记忆；缺少 versioned IR、canonical compiler 和 spawn 前 fail-closed validation。

## 6. 修复与验证策略

项目保留熟悉的 `subagent` 工具名，但由自有 extension 注册唯一的 delegation facade。Coding branch 只接受 `executor|spark` 的完整 `dispatch-ir.v1`；合同表达目标、需求、已知事实、已定决策、相关文件、声明写入范围、排除工作、风险、工作流豁免、验收条件和验证命令。规范化后计算 canonical SHA-256、deep-freeze，并生成固定 section 的 child task。

Facade 使用独立 RPC v1 client，source 固定为 `typed-subagent-runtime`，spawn 强制 `fresh + async:true + clarify:false`；先协商 `ping/spawn` capability 和 session identity，再返回 `coding-dispatch-handle.v1`，其中包含 runId、asyncDir 和 contract hash。非 coding agent 进入 generic branch，原始 `task` 字符串不改写；控制 branch 只允许 `status/steer/interrupt/stop`。

不再注册第二个 `dispatch_coding_agent`，也不使用全局 `tool_call` gate 或 bypass marker。Upstream package resources 通过 zero-resource filter 禁用，原生 `subagent` definition 不进入真实 Pi registry，因此不存在可绕过 typed branch 的同名工具。`subagent-dispatch` skill 已加入白名单，并通过截止时间、占位符和替代调用名压力场景验证。

RED/GREEN 覆盖 IR 缺字段、额外字段、Spark 越界、路径逃逸、稳定 hash、prompt 完整性、RPC envelope、reload dispose、skill 压力场景和真实 SDK lifecycle。
