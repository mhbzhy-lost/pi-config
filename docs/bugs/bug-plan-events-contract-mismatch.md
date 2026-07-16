# Plan Events 跨 Task 状态机契约不一致

## 现象

Plan 事件 reducer 使用了与计划不一致的 Gate 名称和字段，且创建计划后未建立完整任务状态，导致验证可能在空任务集合上通过。

## 影响范围

Plan Coordinator、Gate 执行和 Task 5 的可运行任务选择会读取不兼容的状态形态，可能错误完成验证或无法调度任务。

## 复现步骤

1. 使用 `build/test/lint/security` 记录 Gate，或在 `plan.created` 中不提供任务清单。
2. 对空 `tasks` Map 追加四个旧 Gate 后执行 `plan.validated`。
3. Task 5 对对象状态值与字符串状态值作比较，无法识别待执行任务。

## 根因

Task 6 实现时未完整对照后续 Task 10 的 GateAttempt 契约，也未将 Task 5 的 Map 值协议作为跨模块不变量；因此 reducer 将临时状态当作正式领域契约。

## 修复方案

`plan.created` 接收非空且唯一的任务 ID 并初始化 pending 对象状态；统一 GateAttempt 为 `type/status/inputHead`，补齐 created/running/verifying 生命周期，并让 Task 5 读取 `.status`。

## 验证方式

先新增跨模块失败测试，运行 `node --test test/plan-events.test.mjs test/plan-graph.test.mjs` 确认 RED；实现后重复运行并执行 `npm test`。
