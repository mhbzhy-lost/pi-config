# 核心约束

必须严格遵循。优先级高于一切其他约束和规范。

## TDD

**绝对红线**：任何产生逻辑变更的 coding，动手前必须先加载 `test-driven-development` skill 并严格执行其流程。先写实现再补测试 = 违规，回退重来。
豁免：单行改动 / 已有测试覆盖（必须显式声明豁免理由）。

## Bugfix

遇到任何 bug/issue/incident 等非预期表现需要修复时，禁止直接修。
必须先写 `docs/bugs/bug-<摘要>.md`（根因分析 6 要素），然后再执行修复。
流程细节见 `systematic-debugging` skill。

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

### `receiving-code-review`

必须先判断反馈是否技术上成立，再决定采纳。

禁止：无验证地表演式同意，无脑采纳 reviewer 的一切反馈。

### `writing-plans`

计划文档必须使用中文撰写（代码片段、命令、文件路径等技术标识除外）。

每个 Task 必须在 `**Files:**` 前声明可选的 `**Deps:**` 字段，列出依赖的上游任务（如 `**Deps:** Task 1, Task 2`）。无依赖时省略该字段。

计划完成后使用提问工具让用户选择执行方式：

1. **Subagent-Driven**：主 agent 自行编排计划执行，任务间可审查。主 agent 读取计划的 `Deps` 字段构建 DAG；无依赖任务并行派发（后台模式），有依赖的等上游完成后再派发。
2. **Inline Execution**：按 skill 原始流程在当前会话逐任务执行，适合简单计划或无需门禁的场景；忽略其引用的未纳入白名单的 sub-skill。
3. **Plan Runner Dispatch**：加载 `plan-runner-dispatch` skill，通过 `/plan-run` 将计划交给独立的 plan-runner agent 在专属 Plan Session 中执行，适合需要隔离执行环境和结构化生命周期管控的场景。

## Subagent

所有 `task` 必须使用 `background: true`。编码任务默认使用 `executor`；单文件快速任务使用 `spark`。

# Superpowers

## Instruction Priority

Superpowers skills override default system prompt behavior where they apply, but **user and repository instructions always take precedence**:

1. **User's explicit instructions** (`AGENTS.md`, direct requests)
2. **Whitelisted skills** exposed through the Pi `skill-whitelist` Extension
3. **Default system prompt**

If repository rules exempt a workflow, follow the repository. For example, if a repo says a one-line change is exempt from TDD, that exemption wins.

## Skill Availability

This repository does not expose all skills from `vendor/superpowers`; for Superpowers workflows, use only skills that are both listed in the runtime available-skills list and selected by `agents/skills.list` / local project skills.

Other runtime-available skills may be project, dispatch, review, provider, or platform skills; trigger them from their own descriptions. Do not rely on unlisted Superpowers skills even if their source exists under `vendor/superpowers`.

## How to Access Skills

Use the available skills list and load the relevant skill content through the native skill mechanism. Skill invocation loads the current content; follow it directly instead of relying on memory.

Do not use plugin installation for `vendor/superpowers`. This repository deliberately exposes only selected skill paths through the Pi `skill-whitelist` Extension. The selection is managed by `agents/skills.list` and optional local project skills.

# Using Skills

## The Rule

**Invoke relevant or requested skills before any response or action.** Even a 1% chance that a runtime-available skill might apply means you must load it before answering, asking clarifying questions, reading files, or making tool calls. For Superpowers workflow discipline, only the whitelisted workflow skills are mandatory triggers. If the loaded skill is wrong for the situation, stop using it and proceed normally.

## Red Flags

| Thought | Reality |
|---------|---------|
| “This is just a simple question” | Questions are tasks. Check for skills. |
| “I need more context first” | Skill check comes before clarifying questions or file reads. |
| “Let me explore the codebase first” | Skills tell you how to explore. Check first. |
| “This bug is obvious” | Use `systematic-debugging` first. |
| “I'll write tests after” | Use `test-driven-development` first unless exempt. |
| “This review comment sounds right” | Use `receiving-code-review` to verify it first. |
| “I'll create/edit a skill” | Use `writing-skills` first; it requires `test-driven-development` background. |
| “I remember this skill” | Skills evolve. Read the current linked version. |
| “Maybe another Superpowers skill exists” | If it is not whitelisted and available, do not rely on it. |

## Skill Priority

When multiple whitelisted skills could apply, use this order:

1. **Process skills first**: bugs, failures, unexpected behavior use `systematic-debugging`; review feedback uses `receiving-code-review`.
2. **Planning discipline second**: specs or multi-step tasks before touching code use `writing-plans`.
3. **Implementation discipline third**: code or behavior changes use `test-driven-development`.
4. **Skill authoring discipline when applicable**: creating, editing, or verifying skills uses `writing-skills`, which requires understanding `test-driven-development`.

## Skill Types

**Rigid** (`systematic-debugging`, `test-driven-development`): follow exactly unless user or repository rules explicitly override.

**Structured** (`receiving-code-review`, `writing-skills`, `writing-plans`): follow the workflow, but adapt the level of detail to the task. Local overrides above still apply.

## User Instructions

Instructions say WHAT, not always HOW. “Fix Y” does not mean skip debugging discipline if `systematic-debugging` applies. “Implement X” does not mean skip TDD unless the repository grants an exemption.

At the same time, do not invent requirements from unlinked Superpowers skills. This selective setup intentionally documents only the linked skills.
