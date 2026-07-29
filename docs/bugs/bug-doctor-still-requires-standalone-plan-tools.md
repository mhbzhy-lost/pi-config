# Bug: Doctor 与迁移契约仍要求 Standalone Plan Runner 工具

## 症状
Task 3已从Plan Runner frontmatter移除`subagent_wait`和`subagent_supervisor`，但`scripts/doctor.mjs`仍把两者列为required tools，`test/migration-contract.test.mjs`也断言两者存在。`npm run doctor`报两个missing control tool错误，迁移契约测试失败。

## 影响
正确的flat child adapter配置被Doctor判为无效，累计回归无法通过；更危险的是旧测试会推动重新声明upstream工具，从而让上游加载local wait/direct supervisor或fanout相关语义，违背扁平runtime红线。

## 复现
运行`npm run doctor`，输出`missing plan-runner control tool: subagent_wait`和`subagent_supervisor`并退出1。运行`node --test test/migration-contract.test.mjs`，`migration keeps the Plan profiles...`在`runnerTools.has("subagent_wait")`断言失败。

## 根因
Task 3迁移了agent frontmatter、child adapter和compat probe，但遗漏Doctor与通用迁移契约这两个消费者。它们仍编码Standalone Host阶段的工具拓扑，而非“frontmatter不声明任何subagent工具，项目adapter注册后由Task 5授权激活”的新合同。

## 修复
Doctor的Plan Runner required tools只保留Plan lifecycle tools；forbidden tools增加`subagent_wait`、`subagent_supervisor`和`plan_executor_supervisor`，继续禁止frontmatter中的`subagent/contact_supervisor`。迁移测试同步断言四个subagent名称均不在frontmatter，并保留唯一wrapper extension。更新Doctor fixture为新合同。

## 验证
先修改测试观察旧Doctor/fixture RED，再更新Doctor常量。运行`test/doctor.test.mjs`、`test/migration-contract.test.mjs`、Task 3聚焦组合、`npm run doctor`和`git diff --check`。
