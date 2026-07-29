# Bug：DeepSeek 拒绝 Subagent 顶层联合 Schema

## 1. 现象

在未配置过 Pi 的 Mac 上克隆本仓并执行 `init-pi.sh`，通过 Pi 内置 DeepSeek provider 发送任意消息时，请求返回 HTTP 400：`Invalid schema for function 'subagent': schema must be a JSON Schema of 'type: "object"', got 'type: null'`。

## 2. 影响

只要项目自有 `subagent` 工具处于启用状态，DeepSeek 会在生成回复前拒绝整次请求，普通对话和工具调用都不可用。其他接受顶层联合 Schema 的 provider 不受影响，因此原开发机上的常用模型无法暴露该问题。

## 3. 稳定复现

使用 Pi 0.82.1 的 `openai-completions` serializer，把 `TYPED_SUBAGENT_PARAMETERS` 注册为函数参数并发往本地捕获服务器。捕获到 `tools[0].function.parameters` 只有 `anyOf`，其 `type` 为 `null`；服务器按 DeepSeek 的顶层对象约束校验时稳定返回同类 400。

## 4. 证据

`scripts/lib/subagent-dispatch/extension.ts` 将 coding、generic 和 control 三个对象 Schema 直接组合为 `{ anyOf: [...] }`。Pi 的 OpenAI serializer 原样传递 `tool.parameters`，不补顶层类型；内置 DeepSeek provider 最终发送 `strict: false`，但这不会改变参数 Schema。对照 `pi-subagents@0.37.0`，其公开工具以单个 `Type.Object` 作为根节点，联合仅出现在属性内部。

## 5. 根因

typed Subagent facade 的测试覆盖了三个分支的执行合同，却没有覆盖 provider 对函数参数根节点的传输约束。实现把“所有候选分支都是对象”误当成“联合 Schema 自身声明了对象类型”；JSON Schema 不会从 `anyOf` 推导并写出根节点 `type`，DeepSeek 因而读取到 `null`。

## 6. 修复与验证策略

在现有联合 Schema 根节点显式声明 `type: "object"`，保留原 `anyOf` 分支，不改变输入校验语义。回归测试同时断言注册后的 `subagent` 参数根节点可被 OpenAI 兼容 provider 识别为对象，并保留三个对象分支；先确认当前实现 RED，再实施单行修复。随后运行 Subagent 定向测试、完整单元测试、Doctor 和初始化脚本语法检查。
