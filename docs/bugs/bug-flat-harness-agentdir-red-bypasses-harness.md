# Flat Harness agentDir RED 绕过被测 Harness

## 1. 现象

新增的 focused real-Pi 测试在测试自身的 `spawnSync` 环境中硬编码 `PI_CODING_AGENT_DIR` 为仓库 `pi/`，随后断言不应加载其中的 `skill-whitelist.ts`。当前测试稳定失败并报告缺失 `crash-analyzer-usage/SKILL.md`。

## 2. 影响

该测试没有调用 `test/plan-flat-runtime-harness.integration.mjs` 的环境构造逻辑。即使真实 Harness 改为最小临时 coding-agent 目录，这条测试仍会继续硬编码仓库目录并失败，无法作为实现的回归门禁。

## 3. 时间线

- `c03b047` 唯一真实 A2 Harness 已观察到全局 Skill allowlist 污染。
- tests-only 子任务新增独立 real-Pi child fixture。
- 父级审查发现 fixture 自己构造了错误环境，没有经过真实 Harness 的被测边界。

## 4. 根因

测试把“当前错误输入”复制进了一个独立 fixture，却没有提供由 production/Harness 修复控制的输入边界。测试结果只能证明 Pi 在显式指定仓库 agentDir 时会加载仓库扩展，不能证明 Harness 是否完成隔离。

## 5. 触发条件

测试直接设置 `PI_CODING_AGENT_DIR=<repo>/pi`，并期望不存在该目录内扩展发出的结构化错误时必现。

## 6. 修复与预防

删除这条不可转绿的 focused oracle，不修改用户全局配置，也不伪造缺失 Skill。环境隔离继续使用已冻结的真实 A2 Harness 自动化 RED 作为 TDD 证据；GREEN 在真实 Harness 创建最小临时 coding-agent 目录，并由新冻结 HEAD 的唯一 A2 复验覆盖。
