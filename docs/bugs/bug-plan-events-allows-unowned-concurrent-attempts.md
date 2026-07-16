# Plan Events 允许无归属和并发 Attempt

## 现象

`attempt.bound` 可引用不在计划任务清单中的 `taskId`，也可在已有 active attempt 时继续绑定第二个 attempt。

## 影响范围

损坏或越权事件可以进入 Plan Session 事实源；后续 Coordinator 投影会出现计划外任务，或在单个执行仓内同时运行两个写任务。

## 复现步骤

创建只包含 `task-1/task-2` 的 projection；绑定 unknown task，或先绑定 task-1 再绑定 task-2。当前 reducer 均接受。

## 根因

`bindAttempt()` 只校验 attempt ID 防重，没有校验 task inventory，也没有执行 v1 的单 mutating attempt 不变量。

## 修复方案

绑定前要求 task 已声明且仍为 pending，并扫描 attempts 拒绝任何已有 active attempt。失败 attempt settle 后仍允许为同一 pending task 创建新 attempt。

## 验证方式

新增 unknown task 与 concurrent active attempt 的 RED 断言；修复后运行 plan events/graph 目标测试及完整单元测试。
