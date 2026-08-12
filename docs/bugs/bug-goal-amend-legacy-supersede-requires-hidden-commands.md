# 缺陷：legacy Goal 的 supersede replacement 缺少隐藏 commands

## 真实复现

当前 `planned-goal` 属于 legacy/bootstrap generation，active blocked task 的
`acceptance` 仍保存 `commands`。控制面已经迁移到 typed `goal_amend`：其
`add_tasks` 只公开 criteria-only acceptance，且严格拒绝 `commands`。

在人类明确批准 `resolve_blocked` 的 `supersede` 后，调用 criteria-only
replacement 会先产生 replacement 定义；reducer 校验该 legacy task contract 时
报：`acceptance.commands must be an array`。操作以
`INVALID_GOAL_CONTRACT` 失败并且 `stateChanged=false`，因此无法创建替代任务。

## 根因与约束

public schema 不能重新暴露 commands；新 Planned Goal 必须继续 criteria-only。
唯一安全桥接是 legacy generation 的 `resolve_blocked` + `supersede` replacement：
从 projection 中被替代的 blocked task 精确复制既有 `acceptance.commands` 到内部
amendment event taskDef，调用者的新 criteria 保持不变。来源没有 commands 或其
不是数组时必须 fail closed；不得从 params、其他 task、默认值或 shell 生成命令，且
amend 不执行继承的命令。
