# 核心约束

必须严格遵循。优先级高于一切其他约束和规范。

## TDD

**绝对红线**：任何产生逻辑变更的 coding，动手前必须先加载 `test-driven-development` skill 并严格执行其流程。先写实现再补测试 = 违规，回退重来。
豁免：单行改动 / 纯文档变更 / 已有测试覆盖（必须显式声明豁免理由）。

## Subagent

所有 subagent 派发必须遵循 `subagent-dispatch` skill 的要求。
尽可能保持主 agent 上下文的信息有效性和高抽象层级，有相对独立的任务都尽可能交给 subagent 去做，原则上主 agent 只负责收集报告、形成决策、编写计划。

## Bugfix

遇到任何 bug/issue/incident 等非预期表现需要修复时，禁止直接修。
必须先写 `docs/bugs/bug-<摘要>.md`（根因分析 6 要素），然后再执行修复。

## Git Commit 规范

commit message 格式与主观约束见 `git-commit-convention` skill。
机械校验由 Pi `security-gates` Extension 执行。

## 输出语言

编写 skill 可全英文；技术文档（需要人审的文章）默认中文。

禁止：人审材料使用英文。

## 决策报告

每项 ≤5 行，模板：
- **[决策项]**：业务语言描述
- **推荐**：___，因为 ___
- **不选原因**：___
- **选错代价**：___ 时暴露，修复代价 低/中/高

禁止：技术术语未解释 / 使用“各有优劣”等模糊说法 / 细节披露过于详细。

## Playwright 浏览器操作

尽可能使用 headless 模式进行操作。
除非需要用户手动登录验证，或用户明确要求使用 headed/前台模式。

禁止：在有登录态/无需用户干预的情况下自行决定使用 headed/前台模式。

## Skill 行为 Override

### `writing-plans`

计划文档必须使用中文撰写（代码片段、命令、文件路径等技术标识除外）。

每个 Task 必须在 `**Files:**` 前声明可选的 `**Deps:**` 字段，列出依赖的上游任务（如 `**Deps:** Task 1, Task 2`）。无依赖时省略该字段。

计划完成后使用提问工具让用户选择执行方式：

1. **Subagent-Driven**：主 agent 自行编排计划执行，任务间可审查。主 agent 读取计划的 `Deps` 字段构建 DAG；无依赖任务并行派发（后台模式），有依赖的等上游完成后再派发。
2. **Inline Execution**：按 skill 原始流程在当前会话逐任务执行，适合简单计划或无需门禁的场景；忽略其引用的未纳入白名单的 sub-skill。
3. **Plan Runner Dispatch**：加载 `plan-runner-dispatch` skill，通过 `/plan-run` 将计划交给独立的 plan-runner agent 在专属 Plan Session 中执行，适合需要隔离执行环境和结构化生命周期管控的场景。
