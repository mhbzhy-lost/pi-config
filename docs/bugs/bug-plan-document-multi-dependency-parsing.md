# Bug: Plan Document 多依赖解析错误

## 现象

合法声明 `**Deps:** Task 1, Task 2` 被解析为 `task-1` 和 `task-Task 2`，随后报 `unknown dependency task-Task 2`。

## 影响

包含多个直接上游任务的 DAG 无法通过 Plan Runner preflight；Agent 只能错误删除依赖或放弃 Plan Runner。

## 根因

Parser 先捕获字符串 `1, Task 2`，再按 `, ` 分割并直接添加 `task-` 前缀；第二项仍包含 `Task ` 文本。

## 促成因素

1. 现有成功测试只覆盖单依赖。
2. 无测试断言多依赖的规范化结果。
3. 错误在依赖存在性校验阶段才暴露，表面上像计划引用未知 Task。

## 修复方向

从捕获字符串中提取所有数字，再统一映射为 `task-N`，保留声明顺序。

## 防复发

增加包含三个 Task 的成功解析测试，断言第三个 Task 的依赖精确等于 `['task-1', 'task-2']`。
