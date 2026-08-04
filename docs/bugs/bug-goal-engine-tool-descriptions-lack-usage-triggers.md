# Bug: Goal Engine typed tool 描述缺少使用触发条件

## 现象

用户发现七个 Goal Engine typed tool 的 description 主要说明“能做什么”，没有先说明何时使用、前置条件和不要使用的场景。

## 影响

coordinator 可能在错误的生命周期阶段调用工具，例如未读取状态就 dispatch、executor 仍运行时 settle，或仅凭对话历史接受任务，破坏恢复和门禁流程。

## 复现

1. 加载 Goal Engine extension。
2. 查看 `goal_init` 至 `goal_amend` 的七条注册 description。
3. 发现原文以能力或效果开头，未一致提供明确触发条件和禁止场景。

## 根因

注册层文案只作为功能摘要维护，没有把已稳定的 machine action、workspace 和 evidence 生命周期条件编码为模型可优先读取的调用指引。

## 修复方案

将七条 description 均改为以“当…时使用”开头，紧随前置条件和关键效果/返回值，并包含“不要”禁止场景；保持参数 schema、handler 和工具集合不变。

## 验证方式

注册层测试精确 snapshot 七条最终文案，并断言工具名恰为七个。运行 extension、runtime、audit 测试和 doctor，确认行为及审计门禁未回归。
