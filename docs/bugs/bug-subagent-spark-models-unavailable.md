# Spark 子代理无可用模型导致任务启动失败

## 现象

派发低风险单文件测试任务后，Spark 在创建子会话前立即失败，没有产生任务输出或文件修改。Supervisor 报告三个候选模型均无法匹配或缺少凭据。

## 影响范围

所有通过项目子代理运行时派发给 `spark` 的任务都可能无法启动；本次受影响的是狼人杀服务端 Task 4 的测试证明力补强，不影响已经完成的生产实现和现有测试结果。

## 复现步骤

向 `spark` 派发一个合法的 `dispatch-ir.v1` 单文件任务。运行时依次报告 `codex-pool/gpt-5.6-sol`、`anthropic-idealab/claude-opus-4-6`、`openai-idealab/Peach-07-17-DogFooding` 无法使用，并以 `No API key found for codex-pool` 结束。

## 根因

Spark 的候选模型配置与当前运行时实际可用模型和凭据不一致：模型模式无法匹配，首选池也没有可用认证。失败发生在模型选择阶段，因此任务正文、仓库状态和测试命令均未执行。

## 修复方案

短期将当前任务改派给已验证可用的 executor，避免阻塞业务计划。长期应更新 Spark agent 的模型候选配置，指向运行时可用且已配置凭据的模型，并增加派发前 healthcheck，避免到任务启动时才失败。

## 验证方式

修复配置后派发一个只读或单文件低风险 Spark 任务，确认成功创建子会话并返回验收报告；同时确认无 `No models match pattern` 和 `No API key found` 诊断。
