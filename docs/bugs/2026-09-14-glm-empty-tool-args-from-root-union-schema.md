# Bug：GLM 系模型对顶层联合 Schema 生成空工具参数

## 1. 现象

Pi 会话使用 `zai-coding-cn/glm-5.3` 作为主模型时，调用 `subagent` 工具的参数恒为空对象 `{}`。工具校验层报 `must have required properties version, taskId, ...；Received arguments: {}`。重试、重开会话、更换 prompt 均无效。

## 2. 影响

glm-5.3 主会话完全无法派发 subagent（含 coding/generic/control 全部分支）。上一故障会话（2026-09-12 session，行 1574 起）8 次 subagent 调用 8 次空参数；本会话（2026-09-14）首次调用即空参数，证明与会话内操作、上下文污染无关。其他 provider（gpt-5.6-sol、deepseek）不受影响，导致问题长期未暴露。

## 3. 稳定复现

探针 `scripts/probes/zai-tool-stream-diagnostic.ts` 直接调用 `https://open.bigmodel.cn/api/coding/paas/v4/chat/completions`（凭据间接读取，原始 SSE 落盘 `var/diagnostics/zai-tool-stream/`）。对照矩阵：

| 实验 | parameters 根节点形态 | arguments 分片 | 结果 |
|---|---|---|---|
| A | 简单 `type:object` | 15 片 / 41 字符 | 正常流式生成 |
| B | `{type:"object", anyOf:[三分支]}` + `tool_stream:true` | 1 片 / 2 字符（字面量 `"{}"`） | 空参数 |
| C | 同 B，无 `tool_stream` | 1 片 / 2 字符 | 空参数（排除 tool_stream 因素） |
| D | 拍平单 object（字段并集，全部可选） | 140 片 / 404 字符 | 完整 dispatch-ir 参数 |
| E | 顶层 `oneOf` | 1 片 / 2 字符 | 空参数 |
| F | 顶层 `allOf:[anyOf]` | 1 片 / 2 字符 | 空参数 |
| G | 顶层 object + 字段级 `anyOf` | 63 片 / 174 字符 | 完整参数（字段级联合安全） |

## 4. 证据

- 故障会话 assistant 消息 `rawStopReason="tool_calls"`、`responseId` 正常、reasoning tokens 正常消耗——服务端确实发起 tool call 且模型确实思考，仅 arguments 为空。
- pi-ai `openai-completions.js` 中 arguments 唯一来源是 `delta.tool_calls[].function.arguments` 分片累积（新 block 初始化为 `{}`）；B/C 原始 SSE 显示服务端只发一个 `"arguments":"{}"` 分片后直接 finish。
- `TYPED_SUBAGENT_PARAMETERS`（`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`）根节点为 `{type:"object", anyOf:[CODING,GENERIC,CONTROL]}`，与 B 形态一致。
- 历史对照：`bug-deepseek-rejects-subagent-root-schema.md` 记录 DeepSeek 曾拒绝裸 `{anyOf}`（type null），当年修复保留 anyOf 仅补 `type:"object"`；本次证明 glm 对该修复后的形态仍失败。OpenAI function calling 规范本身要求 parameters 为顶层 object，拍平才是规范形态（pi-subagents@0.37.0 即"单 Type.Object 根节点、联合仅在属性内部"）。

## 5. 缺陷分类（门禁）

production 可达：数据由真实 public/typed 入口（glm-5.3 会话正常 `subagent` 工具调用）产生，身份/时间/资源事实有效（session.jsonl 8/8 + 本会话 1/1）。属第 1 类：预期 production 数据未被正确处理——`TYPED_SUBAGENT_PARAMETERS` 根节点使用了 provider 生态普遍不保证支持的顶层组合子，超出 OpenAI 兼容 API 的参数 schema 承诺。

## 6. 根因

`TYPED_SUBAGENT_PARAMETERS` 把三分支互斥校验放在根节点 `anyOf`，依赖 provider 宽松解析联合 schema。glm 服务端对顶层组合子（anyOf/oneOf/allOf）的参数受约束生成静默失败，输出字面量 `{}`。工具 schema 的传输形态超出了 OpenAI 兼容契约；分支互斥本就应由 runtime 权威裁决（`runtimeValidated` 设计哲学：schema 只引导，`compileCodingDispatchIR`/分支路由负责精确校验）。

## 7. 修复与验证策略

拍平 `TYPED_SUBAGENT_PARAMETERS` 根节点为单一 object：三分支字段并入顶层 `properties`，保留 `additionalProperties:false` 与字段级联合（实验 G 证明安全），顶层不设 required。契约变更：schema 层不再拒绝分支混用（如 coding 合同混入 `task`），由既有 runtime 路由（`action`→control、`version`→coding、其余→generic）与 compile keypath 诊断权威裁决。

验证：先 RED（根节点无顶层组合子 + 混用通过 schema 层两条断言在旧实现上失败），再 GREEN；跑全部 schema 消费方测试；扩展探针对 glm 与 deepseek 双 provider 实测真实拍平 schema 的参数生成；最后在 glm 主会话真实派发 subagent。
