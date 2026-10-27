# workspace dispose 的 strategy schema 与参数来源调查

## 调查范围与结论

本任务要求只做源码静态调查。本轮未访问 `workspace183f86ee-d4b9-482d-a5fc-1038e42d9623`，未向该工作区发送控制或处置请求，未启动 Host，未发送真实 provider 请求，未读取模型配置、认证信息或私有 endpoint，也未修改 production、测试和配置文件。但是收尾误运行了既有 workspace 工具测试，执行了测试本地 service 的处置及临时 repo/worktree 生命周期，违反了本任务“只读静态、禁止任何处置请求”的严格边界，详见末节。因此验收 criterion-1 必须标为未满足，不能声称本轮全程只读。

结论是：当前源码证据支持 `strategy` 在 `managed_workspace_dispose` 的模型接口中是可省略的；没有证据证明 Pi 1.4 或已检查的 OpenAI/Codex provider 适配会强制模型填入非 null strategy。对于本会话，只能确认合同提供的可见调用误传 `strategy: "cherry-pick"`。具体是模型主动误填还是未检查的协议/路由层改写，尚未证实；不能把它归因为已证实的 runtime schema 强填，也不能仅凭静态源码证明模型的主观生成过程。

服务端拒绝也符合当前代码的设计：模型工具的旧执行闭包在调用 `disposeOwned` 前显式检查，非 `integrate` 携带任何 `strategy` 返回 `INVALID_WORKSPACE_STRATEGY: strategy is only valid for integrate`。这是正确的 fail-closed 行为，不应通过让 discard 忽略非法字段来绕过。

## 1. workspace 工具 schema 与 runtime 校验

### 新注册工具的真实 schema

[packages/pi-subagents-enhanced/src/workspace/operation-tools.ts](../../packages/pi-subagents-enhanced/src/workspace/operation-tools.ts) 的 `OPERATIONS` 定义了四个独立的 `model-only` 工具。`managed_workspace_dispose` 的字段是：

- `workspace_id`：字符串，必填；
- `disposition`：枚举 `integrate | discard | preserve`，必填；
- `strategy`：枚举 `cherry-pick | merge`，可选；
- `action_token`：字符串，必填。

`schemaFor()` 生成的根对象是 `type: "object"`、`additionalProperties: false`。required 数组只包含 `workspace_id`、`disposition` 和 `action_token`；`strategy` 没有进入 required。该 schema 没有 `allOf`、`anyOf`、`oneOf`、`if`、`then` 或 `else`，也没有 `default`、`nullable` 或注入值。`description` 和 `promptGuidelines` 都说明 strategy 仅对 integrate 有效，非 integrate 携带时由 runtime 拒绝。

同文件的 `createWorkspaceOperationTools()` 将这四个定义注册为 `exposure: "model-only"`。它通过 `createSubagentWorkspaceTool(options)` 取得唯一的旧 `execute` 闭包，再由新工具的 `execute` 先做扁平对象、未知字段、必填字段和枚举值校验，随后把固定 action 注入内部 value 并调用该旧闭包。模型不能填 `action`、owner、kind 或 rootSessionId。

旧的 union 工具定义在 [packages/pi-subagents-enhanced/src/workspace/tool.ts](../../packages/pi-subagents-enhanced/src/workspace/tool.ts) 中仍可见。它的 `WORKSPACE_DISPOSE_SCHEMA` 曾包含顶层 `allOf` 条件：出现 `strategy` 时要求 disposition 为 integrate；但该 union 工具在 [packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts](../../packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts) 中只作为内部宿主闭包，注释明确说明旧 union 不注册。实际注册的是四个新工具。因此，不能用旧 union 的 `allOf` 推断当前模型看到的 schema。

### 错误发生顺序

`tool.ts` 的 `execute()` 在 `input.action === "dispose"` 分支先执行：

```ts
if (input.strategy !== undefined && input.disposition !== "integrate") {
  return failure("INVALID_WORKSPACE_STRATEGY", "strategy is only valid for integrate");
}
```

这个 guard 发生在 `scopedService.disposeOwned(...)` 之前，所以该错误证明的是工具 runtime 已收到一个非 undefined 的 strategy 且 disposition 不是 integrate；它同时证明本次路径没有进入 `disposeOwned`。错误不是 schema 的必填错误，也不是 service 在持久化或 Git 处置阶段产生的错误。

若通过该 guard，旧闭包对 `disposeOwned` 使用 `strategy: input.strategy ?? "cherry-pick"`。这确实会给省略 strategy 的 discard/preserve 的 **service 内部入参**也填入 cherry-pick；它发生在非 integrate 显式字段检查之后，不能反向改写模型请求或解释先前的 `INVALID_WORKSPACE_STRATEGY`。必须区分可见 tool-call 参数、guard 前的 execute 输入与 guard 后的 service 入参，不能把内部默认值当成模型强填的来源。

service 本身在 [packages/pi-subagents-enhanced/src/workspace/service.ts](../../packages/pi-subagents-enhanced/src/workspace/service.ts) 的 `disposeForLease()` 中先做 child-owned、状态、实时 snapshot、token 和 allowed disposition 检查，再调用 `dispositionValue()`。`dispositionValue()` 对 integrate 校验 strategy，只把 strategy 写入 integrate disposition；discard 返回 `{ action: "discard" }`，preserve 返回带 runtime reason 的 disposition。模型工具层的 `INVALID_WORKSPACE_STRATEGY` guard 因而是非 integrate 显式 strategy 的第一拒绝点，且阻止其触达 service。

既有 [test/workspace-operation-tools.test.mjs](../../test/workspace-operation-tools.test.mjs) 已把这条合同写成断言：dispose schema 无 `allOf`，带 `disposition: "discard"` 和 `strategy: "merge"` 时返回 `INVALID_WORKSPACE_STRATEGY`，且 `disposeOwned` 未被调用。该测试是现场既有证据，本任务未修改或新增测试。

## 2. typed adapter、Host 注册与 model-only 路径

Host 注册路径位于 `subagent-dispatch/extension.ts`：先构造 `workspaceOperationTools`，再逐个执行 `pi.registerTool(definition)`。没有中间 adapter 重写 `parameters`，`withToolRendererHint()` 只包装 renderer，并不修改 args、schema、result 或 details。

Pi 1.4 的 [tool-definition-wrapper.js](../../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js) 将 `definition.parameters` 原样带入 AgentTool，同时只透传 `constrainedSampling`、`prepareArguments` 等可选字段。这里的 workspace operation 定义没有设置 `constrainedSampling`，也没有 `prepareArguments`。Pi 1.4 的 `registerTool()` 只检查 parameters 是对象并登记 definition；它没有为 optional property 追加 required，也没有注入默认参数。

`model-only` 的含义来自 Pi 1.4 扩展类型与 AgentSession：工具在 active tool set 中声明给模型，但不能由其他工具作为 callable nested tool 使用。该 exposure 改变可达边界，不改变参数 schema。Agent loop 在 provider 回传后先运行 `validateToolArguments()`，再执行工具；因此 provider 生成的参数会经过 Pi 校验，但校验阶段没有“缺少 optional strategy 就补 cherry-pick”的逻辑。

Pi 的 [utils/transcript.js](../../node_modules/@earendil-works/pi-ai/dist/utils/transcript.js) 通过 JSON round-trip 生成工具声明，保留 `parameters` 的实际结构；它会移除 TypeBox 内部 symbol 和 undefined 字段，但不会为可选字段增加值。当前工具的 schema 是普通 JSON 对象，round-trip 后仍保留 strategy property、保留其不在 required 中的事实。

## 3. Pi 1.4 provider schema normalization

### strict 转换的实际行为

[constrained-sampling.js](../../node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js) 的 `makeStrictJsonSchema()` 是 provider 需要 strict JSON-schema constrained sampling 时使用的转换器。它会：

1. 检查并拒绝 `allOf`、`oneOf`、`if`、`then`、`else` 等 strict 不支持的关键字；
2. 对每个未列入 required 的 property，复制为 `anyOf: [原 schema, { type: "null" }]`；
3. 把所有 property 名称加入 required；
4. 保留 `additionalProperties: false`。

因此，如果这条转换链被启用，`strategy` 的表示会变成 required，但其值域是 `cherry-pick | merge | null`。这属于 provider strict schema 的可选字段编码，不等于运行时或模型接口要求必须产生一个非 null 字符串。

[utils/validation.js](../../node_modules/@earendil-works/pi-ai/dist/utils/validation.js) 的 `normalizeOptionalNulls()` 会在本地工具校验前删除“schema 中原本可选、但模型回传为 null”的字段。随后 `validateToolArguments()` 执行 TypeBox/JSON schema 校验和转换。静态内存 probe 对同一份 `managed_workspace_dispose` declaration 验证了三种输入：

- 省略 strategy：校验后仍只有 `workspace_id`、`disposition`、`action_token`；
- `strategy: null`：校验后同样删除 strategy；
- `strategy: "cherry-pick"`：保留该显式字符串。

所以即使某 provider 选择 strict schema，省略语义仍可由 null 表达并被本地 validator 恢复为省略；该链没有把省略强行变成 `"cherry-pick"` 的证据。

### 已检查的 OpenAI Responses/Codex 与 Completions 适配

已检查安装的 `@earendil-works/pi-ai@1.4.0`：

- OpenAI Responses 共享转换器 `convertResponsesTools()` 对已检查的实际调用点，依据 `resolveJsonSchemaStrictSampling()` 及 API 层传入的默认 strict 决定是否调用 `getJsonSchemaToolParameters(tool, true)`。该函数也允许调用方显式传 `strict: true`，不能泛称它只受工具自身配置控制；已检查的两个实际请求构造点默认分别是 null 和 false。
- Codex Responses API 的请求构造在 `openai-codex-responses.js` 中将 `toolOptions` 设为 `{ strict: null, supportsStrictMode, supportsOpenAIGrammarTools }`。对本工具没有 `constrainedSampling` 时，转换结果保留原 required 数组，生成的 function tool 的 `strict` 为 null；不会把 strategy 加入 required。
- OpenAI Responses API 的请求构造将 `supportsStrictMode` 和 grammar 能力传入，但没有为无 `constrainedSampling` 的工具强制 strict；该路径的默认 function tool strict 为 false，参数仍是原 schema。
- OpenAI Chat Completions 的 `convertTools()` 同样只在 tool 自己请求 constrained sampling 且 provider 支持时使用 strict 转换；否则使用原 schema，并将 strict 设为 false（当 provider 支持该字段时）。

现场 probe 的输出同时确认：

- 工具名为 `managed_workspace_dispose`，exposure 为 `model-only`；
- `constrainedSamplingPresent` 为 false；
- 原 schema required 为三项，不含 strategy；
- Codex Responses 转换后仍是不含 strategy 的三项 required，strategy 仍为普通 enum；
- 单独调用 `makeStrictJsonSchema()` 才会得到包含 strategy 的 required 和 `enum/null` anyOf；
- Pi validator 对省略和 null 的处理分别保持省略。

以上是本地安装的公开 API family 实现的静态结论。当前主会话显示的 provider 名称为 `codex-pool`，但本任务禁止读取本机模型配置、认证或 endpoint，也未取得真实远端请求 body。因此不能证明 `codex-pool` 私有路由是否在服务端另行改写 schema；也不能把该未知层假定为存在。

## 4. 参数序列化、multi-tool wrapper 与可见调用归因

本轮在 `packages/**`、`src/**`、`pi/extensions/**`、Pi coding-agent 的 `dist/core/**`、pi-agent-core/pi-ai/pi-codemode 的 dist 范围中搜索 `multi_tool_use`，未找到其实现。当前可见 wrapper 声明只要求 `tool_uses[]` 中的 `recipient_name` 与任意键值的 `parameters`，没有 strategy 字段、枚举或 default；这说明声明层没有要求 strategy。wrapper 的实际实现不在已核对的本地源码范围内，不能仅凭搜索无命中证明它绝不改写参数，也不能推断远端采样是否另行约束嵌套 parameters。Pi 文档说明一个 assistant response 可以启动多个 tool call，已检查的本地并行执行链没有 strategy default 注入；这与外部 wrapper 的实际行为是不同证据层。

生成链可以按以下顺序区分：

1. workspace operation factory 生成扁平 schema，strategy 可选；
2. Host 通过 `registerTool()` 登记，wrapper 原样透传 parameters；
3. transcript declaration 做 JSON round-trip，不补值；
4. provider API family 按工具自身是否请求 constrained sampling 决定是否做 strict 转换；本工具未请求；
5. provider 返回 tool-call arguments；Pi 只解析 JSON，再做 schema 校验/optional-null 清理；
6. 通过校验后才进入 `tool.ts` execute；非 integrate + 非 undefined strategy 在这里得到 `INVALID_WORKSPACE_STRATEGY`；
7. 只有合法路径才调用 `disposeOwned`，其内部对 integrate 使用 strategy，对 discard 不保存 strategy。

因此，已知证据能证明的第一偏离点是：可见 tool-call 参数已经包含 `strategy: "cherry-pick"`。从当前源码不能把该字段追溯到 schema 必填、Pi adapter default、strict normalization 或 runtime service default。若要继续证明 provider 远端是否改写，只能取得不含秘密的实际请求 schema/请求体或同等公开 provider 记录；本任务授权和安全边界不允许做真实 provider 请求，故在此停止该方向。

## 5. 合法 discard 的可表达性与安全恢复下一步

当前 typed 接口可以表达合法最小 discard 请求：

```json
{
  "workspace_id": "<status 返回的 workspace_id>",
  "disposition": "discard",
  "action_token": "<同一次实时 status 返回的一次性 action_token>"
}
```

该对象完全省略 `strategy`。恢复时必须重新调用当前 typed `managed_workspace_status` 获取实时 `allowed_dispositions` 和一次性 token，然后仅在实时允许 discard、token 未过期且 terminal proof/其他 service 条件满足时，发送上面的最小对象。discard 不应携带 `strategy`，不应走 integrate，不应使用过期 token，也不应通过 raw Git worktree、stash、reset、rm、另起 Host、伪造 root 身份或直接访问 ledger/service 绕过 owner 和 CAS 门禁。

现场提供的 status 事实显示该工作区的 `allowed_dispositions` 包含 discard、preserve，且 owner/workspace 内容已保全；这只说明安全下一步是重新取得实时 token 后表达最小 discard，并不构成本报告对真实处置的授权。本任务没有发起该请求。

如果某个真实 provider 路由确实把可选 strategy 变成“必须是非 null 的字符串”，则当前四工具 schema 与该路由协议之间存在表达性阻塞：最小 discard 无法由模型通过该路由表达。最小接口修正应归属于 provider schema adapter 或模型路由的可选字段编码，使其保留 optional/null 语义；修正应同时保持 runtime 对非 integrate 携带 strategy 的拒绝。不能用 discard 忽略 strategy 的 fallback 掩盖这个问题。

当前静态证据不足以证明存在该阻塞。因此可确认：合法最小 discard 在当前公开 typed schema 和已检查的本地 provider 转换链中可表达。**未证实 runtime 强填，只能确认可见调用误传**；本会话参数为什么出现 cherry-pick，不能从现有证据进一步判定是模型主动误填还是未观察层改写。也未证明实时远端协议实际接受或保留该 schema。

## 证据与限制

- 生产 schema/runtime：`packages/pi-subagents-enhanced/src/workspace/operation-tools.ts`、`packages/pi-subagents-enhanced/src/workspace/tool.ts`、`packages/pi-subagents-enhanced/src/workspace/service.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`。
- Pi 1.4 adapter/validator/provider normalization：`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/tool-definition-wrapper.js`、`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js`、`node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`、`node_modules/@earendil-works/pi-ai/dist/utils/transcript.js`、`node_modules/@earendil-works/pi-ai/dist/utils/validation.js`、`node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js`、`node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js`、`node_modules/@earendil-works/pi-ai/dist/api/openai-codex-responses.js`、`node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js`、`node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`。
- 既有合同测试：`test/workspace-operation-tools.test.mjs`、`test/subagent-workspace-tool.test.mjs`；本任务未修改、新增测试，但误运行了前者，详见下一节。
- 未检查本会话完整 session 内容、`models.json`、auth、provider endpoint 或远端实际请求体；因此不对本会话私有路由作超出源码证据的判断。

## 6. 运行记录、边界偏差与验收

本轮读取了根 `AGENTS.md`、`pi/AGENTS_SHARED.md`、package AGENTS，以及 Pi 1.4 的 README、SDK、Extensions、Codemode、Custom Providers、Models 文档；所用 Markdown 文件完整读取。相关 SDK/扩展示例用于核对定义和注册方式，未执行示例、未创建 AgentSession。

正常诊断阶段使用 read 与限定路径的 rg 搜索，并运行了一次 `node --input-type=module` 的内存 schema 诊断。诊断导入真实 factory、`wrapToolDefinition()`、`toToolDeclaration()`、`convertResponsesTools()`、`makeStrictJsonSchema()` 和 `validateToolArguments()`；factory 使用空 service 对象，没有调用 `execute`、service 方法或 provider stream。诊断只打印 schema 和校验后字段名，不打印任何真实 token。该输出证明本地转换/校验行为，不能证明远端模型请求形态。

**越界命令（非授权测试）：**

```sh
node --test test/workspace-operation-tools.test.mjs
```

实际工具输出：`tests 7`、`pass 7`、`fail 0`，总耗时约 15.7 秒。其中前五项检查 schema、spy service 委托、非法字段拒绝、strategy guard 和 renderer；后两项创建测试本地真实 managed-workspace service、临时 repo/worktree，执行 status/token、dispose、release 等 fixture 流程。测试源码使用 `mkdtemp()` 创建隔离目录，并通过 `t.after(() => rm(root, { recursive: true, force: true }))` 注册清理。测试 runner 报告 7/7 成功、未报告清理失败；本轮没有独立检查临时目录是否已删除，不能把 runner 回执扩大为独立 cleanup proof，也没有另行发起清理操作。

这次执行违反当前“只读静态、禁止任何处置请求”的合同，即使处置发生于测试临时 fixture，也不能把它算作本任务授权。测试未引用或访问目标 workspace；未启动 Host，未访问真实 provider，未修改 production/测试/配置。发现后已向主管明确报告并停止进一步 probe、test、处置和控制。主管仅允许修正文档与交付现有证据，并明确这不是追认测试授权。

这 7/7 只能作为该测试 fixture 的运行结果；它既不是原工作区已回收的证明，也不是当前模型/远端 schema 已实测的证明。生产归因仍以上文实际 schema、adapter、provider normalization 源码及纯内存转换输出为依据。

本轮还在根仓库只读执行了 `git diff --cached --name-only`，结果为空；以及 `git status --short`、指定报告路径的 `git diff`，看到根仓库存在并行任务的既有 dirty/untracked 文件。未对它们做修改、暂存、清理或重置。没有执行 stage、commit 或 push。本任务唯一落盘文件是本报告。

验收结论：criterion-1 **未满足**（误运行具有 fixture 处置及临时 workspace 副作用的测试，严格静态边界被破坏）；criterion-2 **满足**（明确区分正确 runtime guard、schema 可选字段、strict nullable 编码、内部默认值及不可见参数来源）；criterion-3 **满足**（给出完全省略 strategy 的最小 typed discard 与实时 token 恢复步骤，明确未证实强填，不引入忽略 strategy 的 fallback）。
