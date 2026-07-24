---
name: plan-runner-dispatch
description: Use when the user explicitly chooses the Plan Runner Dispatch execution option, or explicitly requests /plan-run or the plan-runner mechanism. Do not load for general plan execution or subagent-driven workflows.
---

# Plan Runner Dispatch

## Overview

将已完成的计划交给隔离的 plan-runner agent 在专属 worktree 中执行。**唯一有效的启动方式**是 `plan_run` tool —— 它创建 worktree、生成运行时 wrapper、建立 parent lease，这些是 plan-runner 正常运行的前提条件。

## When to Use

- 用户在 writing-plans 流程末尾选择了 "Plan Runner Dispatch"
- 用户明确说 "/plan-run" 或 "用 plan-runner 执行"
- 用户明确要求隔离执行环境时（非自行判断）

## Required Plan Input

`plan_run` 只接受严格的 `pi-plan.v1` 文档。首次调用 `plan_run` 之前，必须读取计划并确认以下结构；缺少任一项时先按模板修正，禁止调用后再猜测格式。

````markdown
# 计划标题

## Execution Contract

```json
{
  "schemaVersion": "pi-plan.v1",
  "verification": [
    "实际可执行的测试命令",
    "git diff --check"
  ],
  "requiredGates": [
    "deterministic",
    "plan-audit",
    "external-review",
    "final-completeness"
  ]
}
```

### Task N: 任务标题

**Deps:** Task 1, Task 2

**Files:**
- Create: `path/to/new-file`
- Modify: `path/to/existing-file`
- Delete: `path/to/removed-file`
````

输入约束：

- 全文必须恰好一个二级标题 `## Execution Contract`，紧跟一个 `json` fenced block。
- `schemaVersion` 必须是 `pi-plan.v1`；`verification` 是非空命令数组；四个 `requiredGates` 缺一不可。
- Task 标题必须是 `### Task N: ...`，编号唯一。
- 无依赖时省略整个 `**Deps:**` 字段，禁止写 `**Deps:** 无`；有依赖时只写已声明且非自身的 `Task N`，支持逗号分隔多个依赖。
- 每个 Task 的 `**Files:**` 必须至少包含一条 `Create/Modify/Delete` 路径。纯验证步骤放入 `verification`，不要伪造“无新文件”Task。

调用前 checklist：标题、Contract、四个 Gate、非空 verification、每个 Task 的 Deps/Files 均符合上面模板。若 `plan_run` 仍返回解析错误，禁止猜测 JSON key、嵌套或位置；读取 `${PI_CODING_AGENT_DIR}/../scripts/lib/plan/plan-document.mjs` 的实际约束，报告并修正精确失败项后只重试一次。

## 流程

1. 确认计划已写好并保存（通常由 `writing-plans` 完成）
2. 调用 `plan_run` 启动：

```
plan_run({ planPath: "docs/superpowers/plans/YYYY-MM-DD-feature.md" })
```

3. 观察 Plan Session artifacts，不介入任务执行
4. 若状态为 `blocked`，询问用户决策
5. 仅当 structured status 的 `validatedHead` 匹配 current head 时报告完成

## Launch Constraint

**必须通过 `plan_run` tool 启动。** 原因：

- `plan_run` 自动创建隔离 worktree（防止污染主分支）
- `plan_run` 动态生成运行时 wrapper（plan-runner 依赖此 wrapper 获取配置）
- `plan_run` 建立 parent lease（用于生命周期管控）

以下方式**无效且禁止使用**：

| 方式 | 为什么不行 |
|------|-----------|
| `subagent({ agent: "plan-runner" })` | 缺少运行时 wrapper，plan-runner 无法获取配置 |
| `bash({ command: "..." })` | plan_run 不是 shell 命令，无法通过 bash 调用 |
| 手动创建 worktree 再调 subagent | 缺少 parent lease，生命周期管控失效 |

## Execution Rules

- Parent agent **不得**执行计划任务、判定任务验收、或从文字推断完成状态
- Parent agent 只能观察 Plan Session artifacts
- Plan commits 仅允许在专属 plan branch 中
- Merge 和 push 始终禁止

## Common Mistakes

| 错误 | 正确做法 |
|------|----------|
| 用户说 "plan_run 有 bug" 就改用 subagent | 先尝试 plan_run，报告实际错误，不绕过 |
| 用户说 "以前用 subagent 跑的" 就照做 | 告知用户约束变化，坚持用 plan_run |
| plan_run 失败后自行用其他方式启动 | 报告错误，等用户决策 |
| 执行后主动报告 "任务完成" | 仅依据 structured status 判断完成 |
