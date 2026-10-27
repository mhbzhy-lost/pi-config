# managed_workspace_dispose 参数链深入只读调查

调查日期：2026-10-27。任务：dispatch-d42b9107。唯一写入文件为本报告；本轮没有实现修复或采集扩展。

## 结论与证据强度

**已找到前次调查遗漏的具体协议风险：Pi 1.4.0 的普通 OpenAI Responses adapter 在 `compat.supportsStrictMode` 缺失或为 false 时，会省略 function tool 的 `strict` 字段，同时原样发送可选且不可为 null 的 strategy schema。它不是无条件发送 `strict:false`。** 若接收端在省略 strict 时按 Responses 默认规则把属性全部归为 required，这条路径可能让 discard/preserve 的省略语义在远端丢失。现在不能把这个候选判为本事故已证根因：本轮没有读取实际模型配置，也没有当次最终出站 body 或远端 normalized schema，因而不知道现场能力值和服务端行为。

另一方面，当前已检查的 parser、validator、新旧工具执行器，没有“将省略的 strategy 在 guard 前自动变成 cherry-pick”的实现。纯函数计算与静态控制流均支持：普通 JSON 对象省略 strategy 能到达 guard 且不触发该错误；`strategy:null` 在正常模型调用的 Pi validator 中变为省略；显式字符串保持原值。**不能以此进一步断言一定由模型主动填写。** provider/网关、请求 schema 转换、可变流事件、message_end hooks 等更早层尚无同次快照。

对唯一授权 root session 的本轮流式取证确认：最早持久声明确实是三字段 required；截至 6,010,224 bytes 的读取快照，已有 **41 次** dispose assistant 持久记录，全部含 `strategy:"cherry-pick"`，41 个关联结果均为 `INVALID_WORKSPACE_STRATEGY`。前序 39 次之后的最后两次也已包含其中。能定位的首个实际偏离点仍是 **message_end 处理后保存的 assistant.arguments**，不能将其冒充 provider 原始参数字符串。执行入口 guard 在 token 验证之前，最后两次不能归因为票据过期或处置服务故障。

本事故的数据来源分类保持“来源尚未证实”：真实持久调用错误已证；导致错误字段出现的生成来源未证。保留非法组合拒绝，不增加兼容吞参或处置绕行。

## 授权边界、材料与版本

完整读取了根 `AGENTS.md`、`pi/AGENTS_SHARED.md`、package `AGENTS.md`，以及合同要求的三份材料：

- `docs/investigations/2026-10-27-workspace-dispose-strategy-schema.md`；
- `.pi/subagents/artifacts/23a539a2-2700-4604-8a56-ed39505a2c77_executor_output.md`；
- `.pi/subagents/artifacts/d07990f3-10ab-4928-9677-485006085882_delegate_output.md`。

遵守 child 不另行加载父/main 专用 GLOBAL 的根规则；使用当前注入的角色及执行边界。没有调用 retired roster、改模型、创建 Host/session、运行测试 runner、执行 tools execute/service、请求 provider/fetch、联网安装或修改 node_modules。未进入目标 workspace，未访问其 diff、ledger、私有 authority/grant、模型配置、认证文件、凭据或全量环境。session 只由辅助程序间接读取并输出目标白名单，未读取/输出 action_token 值；本轮没有比较或哈希票据。

只读读取 package 元数据确认 pi-ai、pi-agent-core、pi-coding-agent、pi-tui 均为 1.4.0，`node_modules/typescript/package.json:3` 为 7.0.2，package 内 `pi-subagents/package.json` 为 0.80.0。package AGENTS 中的 0.79.2 是旧说明；本任务明确的 0.80.0 与现场 package/兼容入口一致，未修改版本。当前主仓有既有 dirty 文件；本轮按现场代码调查，不将其视作已提交或历史 Host 的逐字构建证明。

SDK 文档均完整读取：coding-agent README、extensions/sdk/custom-provider/models/codemode/session-format/message-types/rpc，以及 pi-ai README。相关文档仅作接口说明，归因依据以下实际安装源码和白名单输出。既有 workspace-operation-tools 测试只静态阅读：其 service/worktree fixture 位于 `test/workspace-operation-tools.test.mjs:194` 以后，**本轮没有执行**；前报告误跑 7/7 不作为本轮验证或真实工作区证据。

## 1. 历史中实际保存的声明与调用

唯一读取的 session 是：

`var/sessions/2026-10-27T06-02-12-954Z_01a17bf3-ba5a-71a2-bcb9-d3ee233671d7.jsonl`

读取 header 白名单确认 version=3、id=`01a17bf3-ba5a-71a2-bcb9-d3ee233671d7`、cwd 为本仓。辅助程序按初始文件大小截定快照，逐行解析，只投影 system 的目标 toolsAdded/toolsRemoved、compaction.systemMessage 中的目标声明，以及目标 assistant/toolResult；不输出完整 system/prompt、用户正文、thinking 或其他工具声明。这里的次数是该 root 文件物理持久记录计数，不额外宣称每条都属于当前活动分支。

实际目标声明只出现于 **line 8，entryId 1a856e8a，message.toolsAdded**，没有找到目标的 toolsRemoved、再次 toolsAdded 或 compaction checkpoint 声明。白名单内容如下（action_token 这里只是字段 schema）：

```json
{
  "name": "managed_workspace_dispose",
  "parameters": {
    "type": "object",
    "additionalProperties": false,
    "required": ["workspace_id", "disposition", "action_token"],
    "properties": {
      "workspace_id": {"type":"string","minLength":1,"maxLength":4096},
      "disposition": {"enum":["integrate","discard","preserve"]},
      "strategy": {"enum":["cherry-pick","merge"]},
      "action_token": {"type":"string","minLength":1,"maxLength":4096}
    }
  }
}
```

该 declaration 不含 `constrainedSampling` 或 `strict`；strategy 不含 default/null/nullable。description 明确包含“strategy 为可选参数（cherry-pick|merge，缺省 cherry-pick），仅对 integrate 有效”和非 integrate 拒绝条款。这证明**历史本地注册声明**与当前源 schema 相符，不等于远端收到的最终 schema，更不等于远端归一化后的约束。description 的默认值说明是文字，不是 JSON Schema default；它也可能影响生成选择，但没有证明模型实际据此填值。

| 白名单指标 | 本轮结果 |
| --- | --- |
| assistant dispose / 对应结果 | 41 / 41，关联无缺失 |
| strategy | 41 个字符串 cherry-pick；缺失 0，null 0 |
| disposition | preserve 23，discard 18，integrate 0 |
| 参数键 | action_token、disposition、strategy、workspace_id |
| API | 41 个 openai-responses |
| provider/model | 目标样本为 codex-pool / gpt-6.1-sol |
| 错误 | 41 个关联结果匹配 INVALID_WORKSPACE_STRATEGY 文本 |
| 原参数临时字符串 | 目标调用 partialJson 0，argumentsError 0 |
| 已知采集记录 | 未发现 provider_stream_event 顶层记录及 debug-provider-events（官方示例实际 ENTRY_TYPE）、debug-provider/provider-stream-events/provider-payload customType；仅检查记录元数据，未广读 custom data |

关键锚点：

| assistant 行 / entryId | disposition、strategy | 结果行 |
| --- | --- | --- |
| 187 / 950e9315 | preserve、cherry-pick | 188 |
| 595 / 0019052e | discard、cherry-pick | 596 |
| 656 / bc51c9c6 | discard、cherry-pick | 657 |
| 658 / 58fd09b3 | discard、cherry-pick | 659 |

最后两次时间分别为 11:46:40.725Z、11:48:40.538Z；结果均 `isError:true`，且 **details.code 实际为 INVALID_WORKSPACE_STRATEGY**。这修正前 artifact 的“结果只有纯文本无 code”说法；该 artifact 自己展示的较早文本错误仍然有效。41 个独立 ID/时间只证明独立持久记录，不能证明“每轮由模型主动重新生成”，也不能证明有自动填参器。

合同提供的“重启后仍出现、纯文本三字段两次正确、要求原样调用后仍带 strategy、最后两次用此前同一票据”等事实，本轮没有广读用户历史或 token 来复核。纯文本输出与工具生成可能走不同约束，所以该对比提高了 schema/协议层的调查优先级，仍不能单独区分模型偏好与 schema 约束。

## 2. 从 factory 到实际 provider tool schema

完整声明链为：

```text
operation-tools.ts OPERATIONS / schemaFor
→ subagent-dispatch extension 的 renderer wrapper / registerTool
→ ExtensionLoader / ExtensionRunner registered tools
→ AgentSession registry / wrapRegisteredTool / wrapToolDefinition
→ prepareLoadout / agent.state.tools
→ agent-loop declareToolChanges / transcript toToolDeclaration
→ 请求时 context / context_with_system / hidden/forced prompt projection
→ ModelRuntime / provider 实现
→ Responses resolveTranscriptTools / convertResponsesTools
→ samplingParams 覆盖 / onPayload 可替换
→ OpenAI SDK responses.create / JSON 序列化
→ 未观测的接收端 schema 处理与生成
```

各层真实处理如下：

| 层 | 现场源码与行为 | 对可选性的判断 |
| --- | --- | --- |
| factory | `packages/pi-subagents-enhanced/src/workspace/operation-tools.ts:45`、`:91`、`:106`、`:169`；fieldSchema 生成 enum；schemaFor 只把 required=true 的字段纳入 required | 无默认/nullable；Object.fromEntries 构造的是 **schema properties**，不是调用参数 |
| 注册 | `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2223`、`:2237`、`:2251`、`:2272`；旧 union 不注册；withToolRendererHint 只改 renderer context | parameters 原样透传，不能用旧 union 的 allOf 代表当前模型定义 |
| loader/runner | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:234` 检查 parameters 是对象并存 definition；`extensions/wrapper.js:12` 接到 tool-definition-wrapper | 未重新编译 schema 或补 required |
| wrapper/registry | `.../core/tools/tool-definition-wrapper.js:2` 直接传 parameters、constrainedSampling、prepareArguments；`.../core/agent-session.js:2871` 重建 registry | workspace definition 未配置 prepareArguments / constrainedSampling |
| loadout | `.../core/agent-session.js:1175`、`:1214`；prepareLoadout 接口返回 descriptions / hiddenDeclarations | 内建路径只替换 description/隐藏声明；传给 hook 的对象可变，无法仅靠类型排除任意外部扩展改 schema |
| compact/codemode | `pi/extensions/compact-tools.ts:12` 只注册 renderer；SDK `dist/extensions/codemode/tool.js:209` 只处理 callable 声明；`agent-session.js:1163` 排除 model-only 的 nested callable | 当前 workspace model-only 不经 codemode typed declaration 执行。`pi-codemode/dist/declarations.js:279` 以 required 判定 `?`，default 只渲染注释，未见补值 |
| transcript | `pi-ai/dist/utils/transcript.js:106` JSON round-trip；`:126` 工具差异；agent-core `dist/agent-loop.js:224` 声明变化 | 删除 symbol/undefined，但不增加 required/enum/null/default；tools 按 name 重放替换，不做根 schema 属性合并 |
| checkpoint | `transcript.js:58` current system replay；coding-agent session format 的完整 system checkpoint | checkpoint 保存声明，不是远端 strict schema；本 root 未找到目标 checkpoint |
| 请求 hooks | `coding-agent/dist/core/extensions/runner.js:1004`、`:1066`；`core/sdk.js:224` 将 onPayload 接到 before_provider_request | context_with_system 可改完整 transcript；before_provider_request 可串行替换 payload；历史声明不能证明这些之后的 body |
| provider 分发 | `coding-agent/dist/core/model-runtime.js:488`、`:497`、`:521` 调 provider.stream/streamSimple | 自定义 provider 可以覆盖实现；assistant.api 是线索，不能代替运行时实现身份/配置快照 |
| Responses 声明位置 | `pi-ai/dist/api/openai-responses-shared.js:73`、`:124`、`:337`；transcript `:208` | 工具可能在顶层 tools、input additional_tools 或 tool_search_output；三者调用同一 converter，不因移动而合并 strategy schema |
| 最后请求 | `openai-responses.js:312` samplingParams 可覆盖命名字段；`:140` onPayload 后才 responses.create | 需要最终 body；不能将早期 hook 快照说成所有修改后的线缆证据 |

SDK `node_modules/openai/resources/responses/responses.js:21` 的 create 直接 post body，未调用 parse/stream helper 的 schema 转换。`node_modules/openai/internal/request-options.js:25` 使用 JSON.stringify；普通序列化保留 strict:null、strict:false，省略 undefined。该 SDK 的可选 JSON observer 仅查到 ChatCompletionStream 注册调用，pi-ai Responses 路径未查到其注册；本轮未通过它采集。不能泛称 SDK 自动 strict 化，也不能把 SDK 的 `responses.parse()` 和 Pi 实际 `responses.create()` 混同。

### strict 缺省是本轮最重要的新增发现

`pi-ai/dist/api/openai-responses.js:65` 的 getCompat 实际写：

```js
supportsStrictMode: model.compat?.supportsStrictMode ?? false
```

普通 Responses 的 buildParams 在 `:282` 传该能力值。shared converter 在 `openai-responses-shared.js:338` 先计算内部 defaultStrict=false，但在 `:365` **只有 supportsStrictMode 为 true 才把 strict 写进请求工具**。这两个默认值属于不同层。前报告只 probe 了 converter 默认支持 true，遗漏真实 adapter 默认支持 false 的分支。

本轮用 root line8 declaration 调用真实纯函数 converter，并将结果 JSON round-trip，输出如下。这里是内存计算，不是 provider 请求：

| 调用条件 | 实际 JSON strict | required | strategy schema |
| --- | --- | --- | --- |
| 普通 Responses，supportsStrictMode=true，无 constrainedSampling | false | 原三字段 | 原 enum |
| 普通 Responses，supportsStrictMode=false（也代表 getCompat 未配置能力的分支） | **字段缺失** | 原三字段 | 原 enum，无 null |
| 直接调用 converter，无 options | false | 原三字段 | 原 enum |
| 显式 options.strict=null，支持能力=true | null | 原三字段 | 原 enum，无 null |
| 显式 options.strict=false，支持能力=true | false | 原三字段 | 原 enum |
| 显式 options.strict=true，支持能力=true | true | 四字段含 strategy | anyOf(enum, null) |

Codex adapter 的 `openai-codex-responses.js:377` 能力默认 true，`:392`、`:415` 显式 strict:null；它也保留原 enum，不调用 strict nullable converter。普通 Responses 与 Codex 是不同 API。历史 **api=openai-responses**，不能因为 provider 名叫 codex-pool，就将 strict:null 的 Codex 分支当成现场请求事实。Chat Completions 的 `openai-completions.js:1158`、`:1166` 也区分支持能力；不支持时省略 strict，且其服务端默认不能与 Responses 混用。

`constrained-sampling.js:107` 克隆后将 optional property 转为 anyOf(original,null)，把全部 property 加入 required；`:118` 仅 strict===true 执行它；`:175` 未配置 constrainedSampling 时返回 undefined。原 declaration 未被修改。strict true 的“required + nullable”可用 null 表达省略，并非自动要求 cherry-pick。

**公开协议问题与现场证据要分开：** OpenAI function-calling 的 strict-mode 文档是下一步应核对的权威契约：<https://developers.openai.com/api/docs/guides/function-calling#strict-mode>。该问题所关注的规则是 Responses 省略 strict 时可能归一化为 strict（例如将属性全列 required），显式 false 用于非 strict；如果接收端这样处理本工具的原 enum，策略将变成必填且不允许 null。此处没有假定其会自动补 null。显式 null 在 JSON 层也绝不等于 false；本地 OpenAI 类型 `resources/responses/responses.d.ts:600` 允许 boolean|null，但类型本身没有说明远端 null 的默认语义。

本轮未联网读取该网页，仓内也没有接收端实现或公开文档快照来独立证明该路由当前遵循哪条规则。因此“省略 strict→远端 strict-normalize→strategy 必填”是**具有具体生产源码前提的高优先候选**，不是已完成的远端实测；null 是否被当默认/缺失、是否报错、是否另行归一化亦未证。不能读 endpoint 名称来猜后端，也不能从 41 次 cherry-pick 推出 enum 首值强填机制。

## 3. 参数生成、解析、mapping 与可变 hooks

现场普通 Responses 返回链：

```text
SDK 已解析的 Responses event
→ provider_stream_event（通知型，数据仍可被原地改写）
→ output_index slot / item.call_id + item.id
→ function_call_arguments.delta / done
→ output_item.done 的最终 arguments 字符串
→ parseToolCallArguments
→ toolcall_end / message_update
→ message_end handlers（可替换 message）
→ public listeners / SessionManager.appendMessage / JSONL
→ tool_execution_start.args
→ prepareArguments（若有）
→ validateToolArguments（clone→optional-null→Convert→Compile/Check）
→ tool_call.input（可变，之后不再校验）
→ definition.execute → 新 factory → 旧闭包 guard
```

源码细节：

- `openai-responses-shared.js:429` 用 `${item.call_id}|${item.id}` 构造调用 ID、name 直接来自 item、arguments 初始为空、partialJson 来自 item.arguments；按 output_index 建 Map。`:543` observer 在规范化前被 await。observer 虽为只读合同，但 runner `extensions/runner.js:813` 没有冻结数据，不能排除不守合同的 handler 改原事件。
- `openai-responses-shared.js:608` 累积 delta；`:618` 用 arguments.done 的完整字符串替换累积 buffer；`:672` 用 **item.arguments || partialJson** 做最终解析并 Object.assign 到 slot.block。最终字符串可与 delta 不同，所以只拼 delta 不能证明最终参数。`:677` 删除 partialJson 后发 toolcall_end；`:727` 拒绝未完成调用。没有 schema enum/default 参与解析。
- `pi-ai/dist/utils/json-parse.js:73` JSON.parse 优先；repair 只修字符串控制字符/反斜线；`:91` 最终调用解析失败返回 arguments={} 与 argumentsError，不按 schema 补值；`:117` streaming partial-json 只用于预览、失败退回 {}。没有把缺失键推成 enum 第一项的代码。
- `pi-ai/dist/api/transform-messages.js:64` 重放时规范化 ID、thinking/图片与缺结果配对；`:117` toolCall 保留 arguments。`openai-responses-shared.js:297` 把历史 arguments JSON.stringify 重放；这会使错误调用继续存在于上下文，但不是 parser 新造 strategy 的证据。
- agent-core `dist/agent-loop.js:294` 将 provider partial 推给 message_update，浅拷贝 message 不等于深快照；`message_update.assistantMessageEvent` 仍可包含共享引用。`:325` message_end 先于工具执行。coding-agent `core/extensions/runner.js:864` 串行接受相同 role 的替换 message；`core/agent-session.js:883` 原地替换以保持 agent state 与事件一致；`:750` 先 extensions/public listener 后 `appendMessage`。所以持久对象不能代表任何更早不可变快照，SDK listener 也存在持久化前的可变窗口。
- `core/session-manager.js:794`、`:825` 保存 JSON.stringify 的 entry，不保存网络帧。这个会话已含对话，message_end 的追加发生在 prepare/validator/execute 之前；validator 又 clone 参数。**因此 validator、service 默认值不能是已落盘 strategy 的首个来源。**
- agent-core `agent-loop.js:385`、`:421` 的顺序/并行分支都先 emit tool_execution_start，再 prepareToolCall。`:474` 只有工具配置 prepareArguments 时才处理；目标没有。`:498` 无条件进入 validateToolArguments；`:499` beforeToolCall 得到校验后的 args；`:580` 才 execute。并行只调度已有 toolCalls，没有根据 schema 遍历 property 补参。
- coding-agent `core/agent-session.js:326` 将 args 作为 tool_call.input；runner `:957` 把同一 event 交给各 handler。input 原地改动会进入 execute；没有第二次 validate。普通通知事件 tool_execution_start 也传引用而非冻结快照。这些是可变边界，未发现本事故已加载 handler 的当次修改证据。

本仓搜索 `packages/**`、`src/**`、`pi/extensions/**` 的生产 ts/js/mjs，再追踪相关 SDK/upstream 引用，发现的具体 hooks：

| 实现 | 实际作用 | 对本错误的证据 |
| --- | --- | --- |
| `pi/extensions/rtk.ts:116` | 只对 bash 改 event.input.command | managed_workspace_dispose 在工具名 gate 处退出 |
| `src/security-gates/extension.ts:7` | sensitive path/shell/cwd 判定，返回 block | 未写 strategy/input，不能充当默认注入器 |
| `src/mcp-policy/index.ts:57` | 对 MCP 名单及资源查询返回 block | 目标不匹配；未改参数。本轮没有接入/调用 MCP |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2349` | 仅观察 customType=subagent_supervisor_request | assistant dispose 不匹配，不返回替换 message |
| `packages/pi-subagents-enhanced/src/tui/completion-notices.ts:18` | custom completion 的 UI 投影 | 不改 raw message/args |
| `pi/extensions/compact-tools.ts:12` | renderer 注册 | 显示层不参与 provider schema 或 execute 参数 |
| `pi/extensions/openai-codex-proxy.ts:91` | 注册 openai-codex，委托 adapter，注入代理 fetch/transport | 没有 strategy 逻辑；没有读取其配置，不视作 codex-pool 的证据 |
| `src/provider-fallback/extension.ts:18` | session_start 的模型可达性/切换逻辑 | 不改参数；只读源码，未加载它或执行其中 probe/config 读取 |

upstream 0.80.0 也查到并核对了容易遗漏的变更点（均位于 `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/`）：`runs/shared/subagent-prompt-runtime.js:515` permission gate、`:568` 工具预算只返回 block；`:408` fork cache rewrite 只替换 prompt_cache_key；`fast-mode-extension.js:1` 只替换 service_tier；`extension/herdr-pi-bridge.js:170` 只转发结束事件；`shared/pruned-fork.js:186` 确实会把**被裁剪的 fork 历史** arguments 替换成 `{prunedForkSummary,recoveryRef}`，其形态和时机均不能解释本 root 新调用的 cherry-pick。不能说整个 SDK/upstream 从不修改 arguments，只能排除这些具体实现作为当前字段的已知注入源。

额外 forwarding 边界：agent-core `dist/proxy.js:40` 的可选 streamProxy 用 JSON.stringify 发 context，`:237` 起重建 toolcall，`:265` 在 toolcall_end 用服务器 toolCall 覆盖；本仓 streamProxy 使用搜索未命中，默认 SDK `core/sdk.js:260` 走 modelRuntime.streamSimple。不能据此证明未知私有 integration 未自定义 stream。coding-agent `dist/modes/json-event.js:16` 的 RPC 投影只去掉 partial、补 start ID/name；`dist/modes/rpc/rpc-mode.js:265` 向 stdout 发事件，prompt 命令送文本，不是 tool args 默认化器。

### multi_tool_use.parallel 的边界

本轮在本仓 production 目录、四个相关 Pi 包 dist（含单独 bundle 字符串查询）及 upstream src 中搜索 `multi_tool_use` / `recipient_name`，没有找到该 wrapper 实现。Pi 自带并行工具链是 agent-loop 的 Promise.all 调度；codemode 是另一条 nested executeTool 接口，且目标是 model-only。这些都不是已找到的 multi_tool_use.parallel 实现。

因此不能编造 wrapper 如何编码、是否合并 schema 或改嵌套 parameters，也不能用“仓内没搜到”证明宿主外部 wrapper 无问题。root 持久目标调用的 name 是 managed_workspace_dispose；这不提供外部 wrapper 的原请求/返回。若现场另有 wrapper，需要其 owner 提供源码或同次白名单上下游快照。

## 4. validator 与新旧执行器的精确缺省顺序

Pi validator `pi-ai/dist/utils/validation.js:280` 的实际顺序：argumentsError 早拒 → structuredClone(arguments) → normalizeOptionalNulls → Value.Convert → Compile 缓存/普通 JSON schema coercion → Check。normalizeOptionalNulls 在 `:204` 对 properties 存在且原 schema **未 required、不接受 null** 的键删除 null。普通对象 coercion `:114` 跳过不存在的 key；TypeBox `build/value/convert/from_object.mjs:9` 也是遍历实际 keys，`from_enum.mjs:4` 走类型转换、`from_union.mjs:6` 查合法候选，没有 Value.Default 或按 enum 首值补字段。

本轮用真实持久 declaration、真实 parseToolCallArguments 和 validateToolArguments 做纯内存计算（演示值均为 memory-only，未调用 execute），得到：

| 输入 strategy | Pi validator 输出 | 新 factory 行为 | 旧 dispose guard |
| --- | --- | --- | --- |
| 缺失 | 缺失，三字段 | `raw===undefined`，optional 直接 continue | `undefined!==undefined` 为 false，通过 |
| null | 删除 strategy，三字段；原输入不变 | 正常模型链同上 | 通过 |
| cherry-pick | 保留字符串 | 合法 enum 原值复制 | discard/preserve 返回 INVALID_WORKSPACE_STRATEGY |
| merge | 源码同样保留合法 enum（未额外运行计算） | 原值复制 | discard/preserve 同样拒绝 |

新 factory `operation-tools.ts:135` 做未知字段、必填与 enum 校验；`:149` 新建 `{action: operation.action}`；`:150` 遍历字段，缺失 optional 在 `:156` 直接 continue；`:165` 仅复制实际提供值；`:204` 委托旧 execute。没有构造所有属性值的 Object.fromEntries，没有先补 strategy:undefined，更没有补字符串。

旧闭包 `workspace/tool.ts:73` 先解析 live root session、构造固定 owner，再取 scopedService；`:91` 判 `input.strategy !== undefined && input.disposition !== "integrate"`；**只有通过后 `:93` 才构造**：

```text
{ workspaceId, ownerScope, disposition,
  strategy: input.strategy ?? "cherry-pick",
  reason: preserve ? 固定 runtime reason : undefined,
  actionToken }
```

因此确有内部默认值，但在 guard 之后，并且构造新对象不会反向修改 input。即使某处构造 `strategy:undefined`，这个 guard 也不会拒绝 undefined。错误文案和条件对应同一 input 层，不是先以 service 参数补缺省再回头检查。错误码来自 `tool.ts:36` 的 failure.details.code；不能把它解释成 Pi JSON Schema required 失败或 token 检验失败。service accessor 的解析早于 guard；精确说法是该 guard 阻断 **disposeOwned 调用及其后续处置**，不是绝对没有做过任何 service 查找。

null normalization 的入口边界：正常模型调用（顺序/并行）都无条件进入 Pi validator；SDK nested runToolCall 也进入同一 prepare/validate，但目标 model-only 本就不可 nested 调用。**直接调用 definition.execute 不会自动 normalization**：新 factory 收到 null strategy 会返回 INVALID_WORKSPACE_TOOL_INPUT，旧 union 原始 execute 收到非 integrate + null 会触发 INVALID_WORKSPACE_STRATEGY。旧 union 若被直接单独交给 validator，其根 anyOf 也不是当前扁平 properties 入口，不能把新工具的 null 行为泛化过去。旧 union 未注册，以上差异不能作为本 root 走旧 schema 的证据。

既有测试 `test/workspace-operation-tools.test.mjs:97` 明确比较省略策略的新旧闭包委托结果，`:123` 断言 preserve 的内部 service strategy 默认值，`:162` 断言非法策略不调用 disposeOwned。本轮只读这些断言，不声称重新执行通过。

### scopedService 不总是直接本地 service

前报告将生产 discard/preserve 简写成 disposeOwned→disposeForLease，不够完整。实际 Host 候选代码 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:384` 创建 local service，`:393` 在 coordinator client 存在时包 facade，并 `:400` 绑定 root session；`subagent-dispatch/extension.ts:939` 查绑定，不改参数。

- 直接 service：`workspace/service.ts:609` 解构 disposeOwned 入参，调用 loadOwned 验 owner kind/root，再构造新对象传 disposeForLease。`:564` 解构默认 strategy=cherry-pick；`:573`–`:585` 依次校验 snapshot/head/token/allowed 后调用 dispositionValue。`:128` 只有 integrate 校验并保存 strategy，discard 生成 `{action:"discard"}`，preserve 生成 action/reason。`:593` pendingAction 的非 integrate strategy=null。这些内部形态不会回写 assistant 或 guard 前输入。
- coordinator facade：`workspace/disposition-facade.ts:6` withProof 在 `{...input}` 上只附可信 terminalProof；`:16` 调 client.disposeOwned。`coordinator-client.ts:76` 将 input 放 params.input，`:54` JSON.stringify 发送，undefined 会丢失、已定义策略保持；没有默认 strategy。
- coordinator server：`coordinator-server.ts:374` 用 `{...input,ownerScope}` 覆盖可信 owner；`:413` integrate 走 service.disposeOwned，其余走 settleOwnedDisposition。`:135` 构造 `{...input,operation}` 交 service.prepareOwnedDisposition，再 settlement。
- prepare/settlement：`service.ts:668` 重新 loadOwned，核 snapshot/proof/token/queue binding，在同一 CAS 写准备记录（`:734`）；PreparedWorkspaceDisposition 结构不含 strategy（`disposition-contract.ts:7`），settlement `disposition-settlement.ts:13` 重读 durable 准备并比较身份，不用策略默认化。ledger 的 lease CAS 在 `ledger.ts:496`。这是安全门禁后的权威处置链，不是模型参数回填器。

由于错误在上述分支之前返回，不能以历史错误推断任何 coordinator、token 消费或 Git 处置已经发生；本轮也没有尝试验证目标资源实时状态。

## 5. 候选因果表与可否证条件

| 候选 | 生产源码/历史支持 | 已能否证什么 | 缺失的同次证据 |
| --- | --- | --- | --- |
| factory/schema 自动加 strategy/default | 原声明、当前 schema 一致；description 有文字缺省 | 否证“本地 properties/required/default 强制字符串”及 factory 缺失补值 | 历史运行构建身份；任意外部 schema hook 的快照 |
| 普通 Responses 能力 flag 导致省略 strict，远端默认严格化 | getCompat 默认 false、converter 条件赋 strict，纯函数确认缺失且 enum 无 null；现象只在工具调用出现与其相容 | 不能仅因 converter 内部 defaultStrict=false 排除此候选 | 实际 capability 布尔、最终 schema strict 存在性、接收端规则/normalized schema |
| Codex strict:null 与后端默认语义不一致 | Codex 确实发 null、不做 nullable 转换 | 不能把 null 等同 false；历史 api 不支持直接套用 Codex 分支 | 实际 provider 实现身份及 null 远端语义；本轮未证明走该 API |
| parser/repair 将省略变 cherry-pick | JSON/delta/done 路径确实会多次替换解析对象 | checked parser 无 schema/default/enum 首值补参；纯函数省略保持省略 | provider delta/done/output_item.done 白名单与 toolcall_end 同次对照 |
| message_end / 流事件 / SDK listener 改参 | 框架明确可变且可替换；保存发生其后 | 本仓已检查 handler 未找到此改写；不能否证任意外部 handler | 同次早期/末尾快照、运行时 handler 名单与注册顺序（不读秘密配置） |
| validator 可选性/enum 转换 bug | 真 validator 可删除 optional null，clone 后转换 | 真实 declaration 的省略/null 不补值；且它晚于 assistant 保存，不能首次解释已存字符串 | 若当次 execute 输入不同，需各 stage 快照；现无此证据 |
| 新旧 execute 默认值顺序错、正确请求误拒 | tool.ts 确有 ??cherry-pick，但在 guard 后 | 静态否证“正常省略在 guard 前被内部默认”及 strategy:undefined 导致该条件为真 | 任意外部 prepare/hook 改写输入的当次证据 |
| service/token/过期票据导致该错误 | 相关服务有 owner/CAS/token 门禁 | 对匹配 INVALID_WORKSPACE_STRATEGY 路径可排除为错误产生源；guard 在其前 | 不能由此判断目标当前可处置性，本轮不取证该问题 |
| 模型主动输出错误策略 | assistant 持久对象 41 次有字符串，description 提到缺省 | 不能证明主动生成，也不能因纯文本正确而否证采样差异 | 原 provider 参数字符串与实际生成 schema；若私有网关存在，还需上下游对应 |
| multi_tool_use.parallel 或未知网关映射 | 本地实现未找到，存在宿主外部可观测边界 | 不能依据未命中宣称它正确或有罪 | wrapper owner 源码/同次输入输出、网关关联记录 |

旧资料的边界必须一并修正：39 次 artifact 的“由模型每轮重新生成”超过其证据；旧 schema 报告“普通 Responses 默认发 false”漏了 supportsStrictMode gate；`docs/plans/records/2026-10-17-runtime-convergence/workspace-schema-provenance.md:20` 将 required+nullable 直接认作不能省略，也没有同次原 wire，不能当本事故既定首偏层。该历史记录可提示风险，不能替代当前源码与取证。原报告测试越界依旧是事实，本轮没有重跑来补结论。

## 6. 最小归属与下一步授权方案（未实施）

目前没有足够证据授权一个 production 行为修复。**最有价值的下一步是确认实际出站 strict 的三态与同次返回的 strategy 来源，而不是再试处置。**

若取证证实“最终请求省略/传 null strict，接收端因此把原 enum strategy 变必填且不能 null”，最小修复归属为 **provider schema adapter / 该 provider 的能力元数据 owner**：

1. 如果接收端支持明确 non-strict，选择发送严格意义的 `strict:false` 以保留原 optional；不能以 supportsStrictMode=false 就假定省略等于 opt-out。是否可通过精确模型能力元数据启用已有 false 分支，须由 owner 在授权配置范围确认；本轮不读/改 models。
2. 如果协议必须 strict，则必须成对使用 `strict:true` 与现有 makeStrictJsonSchema 的 required+nullable 编码，并保留原本地 schema 供 normalizeOptionalNulls 使用。单改 required、单发 true 或将 null 当 false 都不完整。
3. 上游准确实现归属为 Pi 源仓 `packages/ai/src/api/openai-responses.ts`、必要时 `packages/ai/src/api/openai-responses-shared.ts` 或该 provider 的 public 能力映射；在本仓不得直接编辑 node_modules。若采用仓库现有依赖 patch 流程，后续可申请写入一个明确 patch artifact（建议路径 `docs/patches/pi-1.4.0-responses-optional-tool-schema.patch`）并由正常受审构建流程消费；本轮没有生成该 patch，未假定现有脚本会自动应用它。

若同次 provider 原参数省略而末尾本地快照出现 strategy，则最小修复应落到**首个改动的具体 hook/parser/wrapper owner 文件**，现阶段不能预先列一个虚假的已定位实现。若原参数已经含字符串且请求实际允许省略/null，只能缩小到 provider/网关/生成选择；仍需上游边界，不能直接定模型责任。

无论哪一种修复，都保留 `workspace/tool.ts:91` 的非 integrate+defined strategy 拒绝、未知字段拒绝、live root/exact owner、terminal proof、token/snapshot 与 lease/revision CAS；不能吞掉 strategy、改成 integrate、直接 service/ledger 或 raw Git 回收。也不因本次未定位就拆新工具/加防御兼容。

后续采集可分两档申请，当前均未授权、未实现：

| 档位与具体授权 | 采集点/字段白名单 | 可回答的问题和限制 |
| --- | --- | --- |
| A：授权只读 observer 实现与在 fresh Host 启用；建议 WritePaths 为 `src/dispose-argument-observation/index.ts`、`pi/extensions/dispose-argument-observation.ts`，输出仅 `var/diagnostics/dispose-argument-observation/<request-id>.jsonl` | before_provider_request 中仅目标声明：位置、name、schema required/properties/enum/anyOf/type/additionalProperties/default、strict 的缺失/null/boolean、有效 supportsStrictMode 布尔（若公开可见）；provider_stream_event 仅目标 call 的白名单；toolcall_end、message_end、tool_execution_start、tool_call.input 的独立投影 | 能比较不同已解析层；普通 extension 的采样注册位置不是全 handlers 后保证，不可宣称最终 execute 或最终出站 proof。可以先仅观察用户后续正常请求的目标声明，无需发 dispose |
| B：另授权在真实最后出站/最后 hook 边界做观测，及一次明确批准的 provider 参数取证；必要时由 SDK owner 提供 source patch artifact/受审构建，不改当前 node_modules | adapter 完成所有 payload hooks 后的实际序列化 body 中，仅目标工具声明；SDK/adapter 收到的目标原 arguments 字符串仅在内存缓冲解析后落白名单；最终 validator 后、全部 tool_call handlers 后、execute 入口前投影 | 可排除本地最后一段改写。若生成目标处置参数，应在任何 execute 前固定阻断，关闭自动重试/继续，不能因参数合法而真正处置；请求本身与 Host/构建启用均需单独授权 |

每条记录使用本地 sessionId + request/attempt 序号 + responseId + output_index + 原 call_id/item.id 到 Pi toolCallId 的映射 + stage + 单调序号；最终 entryId 可在持久化完成后补关联。公共 hook 没有统一 requestId，必须每请求闭包绑定重试和并发，不能用全局“最近请求”或仅时间匹配。before_provider_request 的目标可能在顶层 tools 或 input 的 additional_tools/tool_search_output，均须识别，但不落其他工具定义。

arguments 的持久白名单仅 workspace_id、disposition、strategy 的“缺失/null/值/类型”、action_token 的存在布尔、字段名列表、argumentsError 是否存在。不得记录 action_token 原值/片段、headers/授权、endpoint、完整 body/prompt/history、text/thinking。delta 先按 call 在内存缓冲，最终完整解析后提取，禁止逐片 regex 脱敏；解析失败只记错误类别与事件关联，不落原字符串。先复制后筛选，不修改 event/payload，不返回替换消息。新内存快照只证明该 stage，不冒充网络帧或原始字节。

真正需要最后出站 HTTP body 时，应在受支持的 SDK fetch 边界旁路提取目标 schema；`pi-ai/dist/types.d.ts:53` 明确 custom fetch 不覆盖 WebSocket。不得为方便观察强制改传输后声称原路径已证。当前记录 api=openai-responses 仍不能替代“实际使用哪个 transport/custom implementation”的取证。

若 Pi 侧最早 provider 事件已含 strategy，则要区分网关改写与上游生成，必须由有权限的网关 owner 提供同一 request 的四份白名单：网关接收 schema、转发 schema、上游目标 arguments、下发 Pi 目标 arguments（外加对应关联 ID）。本轮不访问私有日志/authority，也不申请工单。若授权不覆盖这些层，结论就停在本报告边界；无需重复调用处置来制造更多相同错误。

## 7. 本轮执行与验证记录

实际执行类别如下，均通过只读工具或受限内存脚本完成：

- read：规范、三份必读材料、SDK 完整相关 Markdown、上述实际源码与既有测试片段；没有加载执行这些生产扩展或测试。
- rg/rg --files/wc：限定 production/SDK/upstream 目录进行 schema/default/arguments/hooks/wrapper 搜索；少数初始路径不存在（如根 node_modules/pi-subagents、旧 API registry 路径、错误 json-events 文件名），随后定位真实 package 内路径与 json-event.js。无命中与路径错误均不当成否证。
- Python 临时目录辅助程序：只流式读取授权 root 的白名单，截定 6,010,224 bytes；JSON 解析错误 0，dispose 41、匹配错误 41、目标 declaration 1。自建 TemporaryDirectory 随退出清理，未写入仓库/会话。
- `node --input-type=module` 纯函数程序：只读取 root 初始目标 declaration，导入 convertResponsesTools、getJsonSchemaToolParameters、parseToolCallArguments、validateToolArguments、toToolDeclaration；计算上述 strict 分支和可选参数投影。没有导入 workspace factory/service 或调用 execute/stream/provider。输出尾部为 `temporaryDirectoryRemoved:true, toolsExecuted:0, servicesInvoked:0, requestsSent:0`；目录由 mkdtemp 自建、finally rm 仅删除该目录。
- Python 只读读取明确 package.json 的 name/version；未读取模型/认证配置。
- `git diff --cached --name-only` 初始为空；`git status --short` 观察既有 dirty；最终对报告执行 diff/格式与秘密标记检查，并再次核对 index。没有 stage/commit/reset/stash/worktree mutation。

纯函数关键验证输出为：`supportsStrictMode:false → strictPresent:false`；`strict:true → strategy.anyOf=[enum,null]、required 四字段`；`MISSING/null → strategyPresent:false`；`cherry-pick → strategyPresent:true`；strict 转换后原 declaration.required 仍只有三字段。它们是本地计算证据，不是请求 wire、模型生成或真实处置证明。

残余限制：没有原 wire、当次有效 compat/samplingParams/全部动态 handler 名单、最终出站 schema、私有网关上下游；没有重新验证目标 workspace 实时状态。已完成当前授权能支持的源码与历史归因；生产修复和进一步采集均未实施。

收尾验证输出：`git diff --cached --name-only` 为空；报告路径 `git status --short` 为 `??`（未暂存）。由于新文件未被跟踪，`git diff --check -- <报告路径>` 本身不构成全文空白检查；另用只读 Python 逐行核对，输出 `trailingWhitespaceLines:[]`、`finalNewline:true`、代码围栏 10 个且成对；秘密值模式扫描 `secretValuePatternFound:false`。所有被提到而尚不存在的具体路径均属于明确标注的后续授权建议或上游源仓归属，没有在本仓创建它们。补充核对官方 debug-provider 示例的实际 customType=debug-provider-events 后，在同一 6,010,224 bytes 快照范围仅查该记录元数据，结果为空，未读取任何此类 data。

## 8. 闭环结论与复发观测

本节追加于 2026-10-27 修复与重启之后，只记录新证据、对 §5 候选表的影响评估与复发观测口径；不改动前七节正文、表格与归因边界。下列新证据由主会话在本轮直接观测，本节按转达记录，**本轮没有重放采集、没有读取重启后的新 session、没有读取任何出站 body 或模型配置**。

### 8.1 新增证据（主会话验证，2026-10-27）

| # | 观测内容 | 时间与来源 | 与前述章节的关系 |
| --- | --- | --- | --- |
| E1 | 重启后一次 `managed_workspace_dispose`（disposition=discard）**成功省略了 strategy**：参数校验通过并进入执行 | 2026-10-27 约 12:05 重启之后；主会话在正常请求路径直接观测到该次调用 | §1 的历史样本是 41 次持久记录全部含 `strategy:"cherry-pick"`（末两次 11:46:40.725Z、11:48:40.538Z）；E1 是重启后首次出现的省略形态成功样本 |
| E2 | steer 模型 schema 已收窄：`STEER_TARGET_FIELDS` 只含 id/runId/index，steer 不再声明 dir；status/interrupt/resume/stop 共享的 `TARGET_FIELDS` 未改；runtime alias 拒绝与 `allowedKeys` 兼容面保留；重启后注册生效 | 同上；实施与验证记录见 `docs/investigations/2026-10-27-steer-argument-pipeline-deep-dive.md` §10 | 与本报告 §4 无关；用于 §8.3 结构防线与 §8.4 复发分类 |
| E3 | discard 对 dirty worktree 的死锁已修：`releaseManagedGitWorkspace` 改为分级 force（tracked 未提交修改 force 删除；非 runtime 元数据的未跟踪用户文件仍 fail closed） | 同上；源码 `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:495-517`，bug 记录 `docs/bugs/2026-10-27-discard-dirty-worktree-deadlock.md` | 该事故的错误不是 `INVALID_WORKSPACE_STRATEGY`，而是 guard 通过后 `disposeForLease`→`releaseManagedGitWorkspace` 的 Git 拒绝；因此不改变 §4 的“guard 早于 disposeOwned”结论，也不能用它解释 41 次参数错误 |
| E4 | 现场受管工作区 `183f86ee-d4b9-482d-a5fc-1038e42d9623` 已 released：重启后 settlement replay 自动完成，worktree 目录清空、managed 分支删除，终态无剩余动作 | 同上（主会话观测） | 说明 E1 之前的 discard 死锁已闭环；本报告 §6 未实施任何处置，也未访问该工作区 |

E1 的意义要精确表述：它证明**当前请求路径可以表达可选省略**。若接收端在该请求上把可选 strategy 强制成 required 且不接受 null，这次省略不可能通过参数校验并进入执行。它**不**证明该请求的出站 `strict` 是三态中的哪一种，也不提供当次 schema 或参数原文；§2 的 strict 缺省分支仍未被同次观测。

### 8.2 对两个候选假设的影响

| 候选 | 新证据下的状态 | 依据与仍然缺失的部分 |
| --- | --- | --- |
| (a) 远端 strict 收紧强制填参（§2 新增发现 / §5 第二行） | **被削弱**，不排除会话/配置差异 | 若远端把 strategy 变成必填且不 nullable，E1 这类省略调用不可能成功。削弱的是「必然强制填参」的强版本；未排除的差异包括重启前后的 provider 配置/compat 值、`samplingParams`/`onPayload` 覆盖、网关路由与 loadout 不同——本轮均未观测，也没有 E1 当次出站 body 或接收端 normalized schema。因此该候选降级为「与最近一次成功样本不相容，除非存在会话/配置差异」，**不作为已否证处理** |
| (b) 历史失败样本自我强化 | **与全部证据相容**，未被削弱 | 41 次同形错误回显持续进入上下文（§3 `openai-responses-shared.js:297` 把历史 arguments 重放、`transcript.js:126` 工具差异不删该字段），叠加 description 中「strategy 为可选参数（cherry-pick\|merge，缺省 cherry-pick）」的文字诱导（§1 声明原文），足以形成「看到旧样本 → 继续填同一值」的自强化循环。E1 不能排除该候选：一次省略成功与「多数轮次仍复制旧值」并不矛盾，且本轮未观测 E1 所在历史是否仍包含旧样本 |
| 生成层首次偏离点（§1 结论） | 未变 | **归因状态仍是「来源尚未证实」**：41 次样本的生成来源（模型偏好 / 上下文自强化 / 远端 schema 转换 / 未知 handler 改写）本轮没有新增同次证据可区分；E1 只是成功反例，不定位历史失败的首个成因 |

按缺陷数据来源三分类：E1/E3/E4 属预期 production 数据被正确处理的正例；41 次历史错误仍属「真实工具记录已证、生成来源未证」。不得因 E1 把历史样本改写为「模型偶发错误」，也不得因历史样本把 E1 当作「配置侥幸」。

### 8.3 已落地的结构防线（各自位置）

| 防线 | 位置 | 作用面 |
| --- | --- | --- |
| steer 定位字段收窄：模型 schema 不再声明 dir | `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:126`（`STEER_TARGET_FIELDS`）、`:141`（`SUBAGENT_RUN_STEER_PARAMETERS.properties`）；实施记录见 steer 报告 §10 | 参数层：模型带 dir 由 `additionalProperties:false` 拒绝，结构性消除「模型可见可选字段但执行期必然被拒」的陷阱；status/interrupt/resume/stop 的 `TARGET_FIELDS` 未改 |
| discard 分级 force | `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:495-517`（`releaseManagedGitWorkspace`）：移除 worktree 带 `--force`，非 runtime 元数据的未跟踪用户文件仍 fail closed 为 cleanup-debt；断言 `test/managed-workspace-service.integration.mjs:337` 起的该 case 与 `:355` 的合同文案原样保留（按上述 bug 记录该 case 未改动并通过） | 结算层：把「授权销毁范围内的 tracked 修改」与「未跟踪用户文件保护」分离，解除 discard 死锁而不放宽数据保护 |
| 保留的既有门禁 | `workspace/tool.ts:91` 的非 integrate+defined strategy 拒绝、未知字段拒绝、live root/exact owner、terminal proof、token/snapshot 与 lease/revision CAS（§4、§6） | 全部未改；本轮闭环没有用「加兼容」换通过率 |

需要区分层次：上述防线都不属于本报告 §6 建议的 **provider schema adapter / 能力元数据** 修复，后者仍未实施（未生成 patch、未改 node_modules、未读 models）。E1 也不构成免做该取证的理由；它只是降低了「必须先改 adapter 才能让 dispose 可用」的紧迫性。

### 8.4 复发观测指标与最小采样方案引用

若未来再出现「模型可见可选字段被必填」形态（新工具、其它 agent、同一工具在别的会话/模型上），按以下顺序核对，**先看报文，再看生成**：

1. **当时出站 schema**：目标工具声明在 API converter 后、全部 `onPayload`/before_provider_request 处理链之后的 `strict` 存在性与精确三态（缺失 / false / null）、`required`、`properties`、`enum`/`anyOf`、`additionalProperties`。注意 `openai-responses.js:65` 的 `supportsStrictMode ?? false` 与 Codex 的 `strict:null` 是不同分支（§2），不能互推。
2. **当时会话历史形态**：该会话是否已累积同形错误回显、description 是否含「缺省 X」类文字、是否跨重启/跨模型/跨网关；历史 arguments 会被重放（§3），因此错误样本数量本身是可疑变量而不是根因证据。
3. **分类判定**：出站 schema 里该字段位于 `required` → 归 provider adapter / 能力元数据 owner（§6 第 1、2、3 条）；出站可选但历史已含同形回显 → 上下文自强化 + 生成层，不加生产兼容；出站可选且历史无回显 → 生成层或网关，需要网关 owner 的同请求四份白名单（§6 末段）。

采样一律沿用本报告 §6 已备好的方案与授权边界，不在此重复展开：A 档（只读 observer 扩展，WritePaths `src/dispose-argument-observation/index.ts`、`pi/extensions/dispose-argument-observation.ts`，输出仅 `var/diagnostics/dispose-argument-observation/<request-id>.jsonl`）与 B 档（最后出站/最后 hook 边界及一次明确批准的 provider 参数取证），连同字段白名单、禁止记录项（action_token 原值、headers、endpoint、完整 body/prompt/history、text/thinking）、`sessionId + request/attempt + responseId + output_index + call_id/item.id → toolCallId` 关联规则，均以 §6 表为准。两档当前仍未授权、未实现，本节不新开采集点、不放宽白名单。

### 8.5 结论：不再为已修复接口追加 production fallback

明确结论：**对已修复的接口（steer 定位字段、dispose 的 discard 结算）无需再追加 production fallback 或兼容分支。**

- steer 的模型侧矛盾已在 schema 层消解，执行期 alias/conflict/path/prefix/index 拒绝与 owner/correlation/live epoch/reply/幂等/投递补偿保持原样（steer 报告 §7、§10）；不需要「忽略 dir 后重发」「猜目标」「自动重试」类分支。
- discard 的失败模式是分级回收缺失，而不是参数兼容缺失；修复落在 `releaseManagedGitWorkspace`，未跟踪用户文件的 fail closed 合同保持，因此不需要在工具入口吞掉 strategy、改判 integrate 或绕过 service/ledger/CAS。
- 对 41 次历史样本这类**生成层外观问题**，正确响应是 §8.4 的报文核对与最小采样，而不是再叠一层宽容解析：已有 §4 证据表明 validator、factory、guard 都不补值，追加 fallback 只会在无证据的情况下改变安全语义。

若后续授权实施 §6 的 adapter/能力元数据修复，那条改动属于上游 owner 与受审构建流程，不构成本仓的 fallback 分支。
