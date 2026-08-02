# Executor 默认模型不可用导致任务未启动

## 现象

两个独立 executor 派发均在约十秒内失败，没有生成执行报告，也没有进入文件读取或测试步骤。

## 影响范围

影响通过 `subagent` 派发且未显式指定模型的编码任务；狼人杀前后端 Task 1 均未开始，项目源码没有被这两次失败运行修改。

## 复现步骤

以合法 `dispatch-ir.v1`、`agent=executor` 且省略 `model` 派发任务。运行器依次报告默认模型模式无法匹配，最终显示 `No API key found for codex-pool`。

## 根因

executor 的默认候选指向 `codex-pool/*`、`anthropic-idealab/*`、`openai-idealab/*`，当前运行环境实际可用目录是已登录的 `openai-codex/*`；默认候选与当前 provider 登录状态不一致。

## 修复方案

由于结构化 executor 协议不允许逐次传入模型，把 `pi/agents/executor.md` 的单行模型从不可用的 `codex-pool/gpt-5.6-terra` 改为已登录的 `openai-codex/gpt-5.6-terra`；不修改任何凭据或业务项目源码。

## 验证方式

先用无工具单次请求验证显式模型可响应，再以相同任务边界重新派发；验收标准是子任务真正进入 RED/GREEN 测试流程，而不是仅成功创建运行记录。
