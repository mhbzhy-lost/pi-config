# steer 参数链与 status 对照调查

日期：2026-10-27。任务：dispatch-b181fa6d。调查方式：只读源码与获准 root session 的字段白名单提取；仅本报告写入仓库。

## 1. 结论与归因边界

已证明的首个拒绝点是受控 steer 的 `canonicalSteerTarget`：当 `params.dir !== undefined` 时返回 `SUPERVISOR_STEER_TARGET_ALIAS`，早于 index、owner、correlation、live/reply gate 和上游 RPC。获准 root 历史实际有 **4 次 steer，4 次均带绝对路径 dir，4 次均被该门禁拒绝**，不只旧报告的 A/B 两例。它们已在持久 assistant 的 `toolCall.arguments` 中携带 dir，但这个位置不是原始 provider response，不能据此认定由模型主动生成、协议强填或某个扩展添加。

同时确认一个可独立处理的接口矛盾：当前 steer 的模型 schema 公开可选 `dir:string`，operation `allowedKeys` 也允许它，而启用控制面的 steer 执行分支对任何非 undefined 的 dir 都拒绝。schema/描述不一致足以说明接口易错，并不证明 dispose 与 steer 已定位为同一根因。拒绝别名的安全设计应保留，公开 schema 可以另行收窄。

**不能把“所有状态都永远拒绝 dir”当作全局事实。** `extension.ts:1655` 的受控分支只在 supervisor plane 存在且 `enabled?.() !== false` 时进入；plane 缺失或明确 disabled 时走直通 RPC。实际 Host 的 enabled 条件是 `brokerReady && !!broker`。上游具有合法的 dir 定位实现，因此静态上存在可消费 dir 的分支；本轮没有检查或改变任何运行态，也没有证明失败调用曾进入该分支。4 次 alias 错误反而与启用受控门禁一致。

新增 status 失败也是实际参数问题，但拒绝层不同：root 第 676 行把同一完整 UUID 放进 dir/id/runId，index 为 0；dir 是非路径字符串，被上游 async 根目录边界拒绝。第 680 行完整 async 路径的 status 成功，结果含 running / process terminal pending。这只能证明当时状态查询可用，不证明 steer 已恢复、消息已入队或 child 已消费。

一个需要保留的共享候选是 **实际出站 strict 字段及服务端规范化**：普通 Responses 适配器默认 `supportsStrictMode:false`，会省略 strict，而不是始终发送 strict:false；Codex 适配器则可能发送 strict:null。省略、false、null 是三种不同报文形态，不能从本地 schema 可选直接推导远端仍保持可选。当前没有实际出站 schema 或入站参数字符串，候选尚未证实。

## 2. 范围、现场与证据优先级

完整阅读了以下指定材料：

- `docs/investigations/2026-10-27-subagent-steer-target-rejection.md`：保留其 A/B 首拒绝点与安全边界；修正其第 12、50、63、169 行附近把“调用方误传 / 非 production bug”扩大为完整来源归因的结论。
- `docs/investigations/2026-10-27-workspace-dispose-strategy-schema.md`：该报告第 148–160 行已承认越界运行测试、criterion-1 未满足。7/7 fixture 结果不用于本报告生产归因。
- `.pi/subagents/artifacts/23a539a2-2700-4604-8a56-ed39505a2c77_executor_output.md`：39/39 dispose 的持久 assistant args 含 strategy，属于既有提取结果，本轮不重复展开 dispose 全链。其第 56 行“由模型每轮重新生成”超出第 59 行以后声明的持久化边界，应收窄为“不同持久 entry/toolCallId 上反复出现同一字段值”。
- `.pi/subagents/artifacts/d07990f3-10ab-4928-9677-485006085882_delegate_output.md`：核对其 hook/validation 顺序，并回到安装源码确认关键位置；不把该材料当 raw provider 证据。

首次检查时 `docs/investigations/2026-10-27-dispose-argument-pipeline-deep-dive.md` 不存在，未等待或轮询，不与其写路径交叉。

现场根仓库已有大量并行 dirty/untracked 文件，包括本报告涉及的 extension/operation-tools 源码；本轮没有改动、清理或暂存它们。以下源码行号指本轮读取的工作树快照，不能把当前 dirty 源码等同于历史 Host 已加载的每个字节。root 历史保存的声明与实际错误作为独立证据补足这一限制。

安装版本证据：`packages/pi-subagents-enhanced/package.json:39` 为 pi-subagents 0.80.0，`:43–45` 为 Pi 三个包 1.4.0；安装包各自 `package.json:3`（pi-subagents 为 `:4`）一致。package AGENTS 仍写 0.79.2，本轮未升级依赖或依赖旧版本断言执行行为。

唯一读取的业务会话为：

`var/sessions/2026-10-27T06-02-12-954Z_01a17bf3-ba5a-71a2-bcb9-d3ee233671d7.jsonl`

用临时 Python 脚本逐行 JSON 解析，只输出目标工具声明和调用的 entryId、toolCallId、timestamp、dir 存在性/路径形态、id/runId 是否完整 UUID 及相等性、index、匹配错误标识和成功状态词布尔。未输出 message 正文、prompt、thinking、action_token 或其它工具参数。未广读其它 agent session，也未搜索私人项目。用户所说“其他 agent 连续失败”仍是待关联的用户报告。

## 3. 真实 schema、factory 与 canonical gate

主要生产文件：

- `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:37`：定位字段定义。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1401`：canonical resolver；`:1654`：解构 input 并进入受控分支。

### 3.1 公开字段逐项对照

| 字段 | steer properties 的真实值域 | 是否 required | 执行期语义 |
|---|---|---|---|
| id | string，minLength 1，maxLength 4096 | 否 | 与 runId 至少一个能解析；同时存在须逐字相等 |
| runId | 同 id | 否 | 不从路径或前缀推断受控目标 |
| dir | 同 id | 否 | 受控 resolver 中任何非 undefined 值先拒绝 |
| index | integer，minimum 0 | 是 | 受控执行另检查 safe integer，不默认 0、不猜 child、不广播 |
| message | string，minLength 1，maxLength 65536 | 是 | factory 检查非空字符串；用于投递与摘要校验 |

根对象是 `type:"object"`、`additionalProperties:false`、`required:["message","index"]`，没有条件组合子、default 或 nullable。各字段本身均不接受 null。status 的 schema 则无 required 数组，四个定位字段全可选。代码见 `operation-tools.ts:37–44,110–126`。

steer 直接 spread 共用的 `TARGET_FIELDS`，因此复用进 dir；descriptor 在 `operation-tools.ts:225–239` 保留 `allowedKeys:["id","runId","dir","index","message"]`，同时描述明确说 dir 会被 alias 门禁拒绝。这不是 TypeScript 的 `?:` 推断，而是实际 JSON schema 与实际 operation 字段白名单。

factory `operation-tools.ts:308–349`：先检查对象与未知字段，再做 requiredStrings；新建空 params，仅在 `Object.hasOwn(record,key)` 时复制原值，然后注入固定 action。它不会遍历 schema properties 给缺字段补值；不会无条件构造 `dir:undefined`、`dir:null` 或空字符串；不会从 runId 推目录。若 direct raw 调用本来有 own `dir:undefined`，factory 会原样复制，但 resolver 的 `!==undefined` 不触发；这与字段真正缺失在 own-key 上有区别，在该门禁的结果上相同。

### 3.2 dir 的各种形态与首个拒绝点

| 输入形态 | 正常 Pi validation 后 | 到达受控 canonical 时 |
|---|---|---|
| 不含 dir | 保持缺失 | 不触发 alias |
| 可选 dir:null | 按原 schema 删除 dir | 不触发 alias；raw 绕过校验的 null 则会触发 |
| dir:"" | minLength 校验失败 | raw 直达仍因非 undefined 触发 alias |
| dir:非空字符串/路径 | 原值保留 | 一律 alias；不判断它是否指向同一 run |
| own dir:undefined | JSON 协议不能表达；JS direct raw 可表达 | 若到达 resolver，不触发 alias |

这里区分原 schema 不允许 null 与 Pi 校验前恢复 optional-null 的协议行为；二者并不矛盾。`dir:null` 不会在已检查的正常链路变成非空字符串；空串也不是本次历史的真实值。

canonical 顺序（`extension.ts:1401–1458`）：先拒 dir；再拒 id/runId 空白或非字符串；再拒冲突；再拒无目标/路径/含 `..`；再拒 8–35 字符前缀。代码当前并非严格 UUID regex：描述要求完整 36 位，但 resolver 对其它非路径、非 8–35 长度字符串仍可能进入后续逻辑，不能把描述当作额外已实现的长度/UUID 校验。此点不是本次 dir 错误来源，也不在本轮修复范围。

### 3.3 gate 与 RPC 的真实顺序

```text
模型工具参数对象
→ Pi 参数准备/校验、optional-null 清理
→ tool_call handlers（仍可原地改输入）
→ operation factory：仅复制 own 白名单字段，注入 action
→ 内部 tool.execute：action 分支
→ executeControl：{action,...params}
→ 若 steer 且 supervisor plane 启用：
    canonical(dir → id/runId → conflict/path/prefix)
    → index
    → identityForRun / owner 三态
    → 受管或有请求的 run：resolveSupervisorControl
    → rpc.steer(params) → commitDelivery
    → 明确 unowned 且无请求：落到公共 RPC 分支
→ status 或未启用受控 steer：公共 rpc[action](params)
→ typed RPC client 原样发送 params
→ upstream normalizeTargetParams / steerParams
→ upstream executeChecked / executor / async location
```

注册映射见 `extension.ts:2182–2183,2237–2250,2271`；受控顺序见 `:1655–1725`。`identityForRun` 在 `:1676`，resolve 在 `:1694`，受管 RPC 在 `:1705`，公共 RPC 在 `:1724`。owner、generation、live epoch、child scope、reply、幂等/重复正文校验见 `supervisor-control-plane.ts:288–332`。明确 unowned 不等于 owner 不可读；后者 fail closed。

`rpc-client.ts:199,276–283,296–303` 只是把 params 放进事件 envelope，无目录推导。upstream `pi-subagents/src/extension/rpc.js:260–283` 的 normalize 只复制 `!==undefined` 字段，不补 null/空串、不拼目录；`:408–423` 的 steerParams 只额外注入 action、trim message、steeringRecovery:false。该 normalize 在本仓 gate **之后**，不能解释在 gate 前已触发的 alias。

上游确会从 id 推出内部 asyncDir：`pi-subagents/src/runs/background/async-resume.js:160–181` 在没有 dir 时用 `path.join(asyncRoot,requestedId)` 生成 location；executor 的 no-dir steer 分支在 `subagent-executor.js:6779` 附近消费 resolved.location，随后 `async-steering-action.js:77` 可构造内部 `{dir:asyncDir,index}` 调用恢复目标解析。这些均在 RPC 和本仓 gate 后，产生的是上游 location/下游内部参数，不能回写此前 assistant args 或反向触发本次 alias。不是所有出现 `dir:` 的源码都属于模型参数生成。

## 4. Pi optional-null、strict 与 Responses 分支

### 4.1 本地 strict 正向转换与回程

`node_modules/@earendil-works/pi-ai/dist/api/constrained-sampling.js:87–119`：转换先 structuredClone，原来不在 required 的 property 若尚不接受 null，包成 `anyOf:[原定义,{type:"null"}]`；再把所有 property 名加入 required，设 additionalProperties:false。

因此对 steer 真正启用本地 strict 转换时，id/runId/dir 都会变成“required 且 string|null”；index/message 保持原非 null 必填。合法受控目标仍可表示为一个完整 runId，id/dir 取 null。status 的 id/runId/dir/index 全部会变成 required nullable。这个转换不选择 UUID 或目录字符串，也不产生参数值。

回程 `node_modules/@earendil-works/pi-ai/dist/utils/validation.js:204–235,280–310`：clone arguments → normalizeOptionalNulls → Convert/coercion → schema Check。使用的是工具原 schema。原本可选、schema 不接受 null、非 $ref 的 null property 被 delete；非空 dir 保留。没有“删除 optional non-null 值”或“把缺失值补成目录”的代码。

工具未声明 constrainedSampling/prepareArguments，见 `operation-tools.ts:298–349`。`resolveJsonSchemaStrictSampling`（`constrained-sampling.js:174–194`）在没有 json_schema 配置时返回 undefined；只有支持 strict 且工具要求/偏好该模式时返回 true，或严格要求不可支持时抛错。`wrapToolDefinition` 原样透传 parameters 与这两个配置，见 `pi-coding-agent/dist/core/tools/tool-definition-wrapper.js:2–12`；registerTool 只验证 parameters 为对象并登记，见 `core/extensions/loader.js:234–244`；transcript declaration JSON round-trip 不添加 required/default，见 `pi-ai/dist/utils/transcript.js:106–113`。

### 4.2 不能合并的请求分支

`pi-ai/dist/api/openai-responses-shared.js:337–369` 的精确逻辑：defaultStrict 在 options.strict 为 undefined 时为 false，否则保留 null/false/true；`strict = constrainedStrict ?? defaultStrict`；仅 strict===true 调用本地 strict 转换；仅 supportsStrictMode 为真才写 functionTool.strict。

| API / 条件（本工具无 constrainedSampling） | 出站 strict 字段 | 出站 properties/required | 后续边界 |
|---|---|---|---|
| 普通 Responses，compat 未显式支持 strict | **省略** | 原 schema，dir optional 且不 nullable | 服务端默认语义未由本地显式 false 固定 |
| 普通 Responses，compat.supportsStrictMode=true | false | 原 schema | 显式请求非 strict |
| Codex Responses，默认 supportsStrictMode=true | null | 原 schema | null 的服务端解释不能自动等同 false |
| Codex Responses，supportsStrictMode=false | 省略 | 原 schema | 同样需服务端协议证据 |
| 明确配置 json_schema 且转换成功，或 converter 被调用为 strict:true | true | 全 required，原 optional nullable | 回程 null 可由原 schema 删除 |

普通 Responses 的默认 `supportsStrictMode:false` 在 `openai-responses.js:65–77`，实际 converter 调用在 `:281–286`，没有传 strict override。Codex 的默认 true 与 strict:null 调用在 `openai-codex-responses.js:377–392,414–420`。Completions 的对应分支在 `openai-completions.js:1158–1167`：支持 strict 时发送 strict??false，否则省略；不能用 Completions 的默认语义推断 Responses。

**省略 strict、strict:false、strict:null 在 JSON 上不一致，也没有本地证据证明远端将三者同义处理。** SDK 类型明确允许 boolean|null（`node_modules/openai/resources/responses/responses.d.ts:614`），但类型声明不是服务端默认行为的证明。若实际 Responses 服务对省略 strict 自动收紧、把全部 properties 变成 required，却没有为原 optional 增加 null，则 dir/id/runId 只剩非空 string 值域，steer 会出现无法表达“无 dir”的问题；dispose 同理可能被迫给 strategy 一个 enum 字符串。这个条件分支与三类样本的外观相容，属于优先核查候选。它不同于 Pi 本地 makeStrictJsonSchema 的 nullable 编码，不能把二者混为一谈。

本轮未读取本机模型/认证配置，因此不知道该历史请求的 compat 值，也没有实际请求体、服务端规范化 schema 或远端协议版本；不能宣布当前路由必然省略 strict、必然自动强填、必然把 null 当 true/false，或已经证明共享根因。strict:false 也只控制采样约束，不保证模型不自愿填写可选字段。

历史声明上未出现 strict，不等于实际 HTTP payload 没有 strict：transcript declaration 本来只保留 name、description、parameters、可选 constrainedSampling。必须在 API 转换后取证。

## 5. hook、adapter 与 UI 的边界

### 5.1 实际执行顺序与可变位置

- `pi-ai/dist/api/openai-responses-shared.js:543–544` 在逐个协议事件处理前调用 onProviderStreamEvent；`:609–625` 拼接 delta 或采用 done.arguments；`:672–681` 对 output_item.done 参数解析并删除 partialJson。`utils/json-parse.js:72–108` 做 JSON parse/转义修复、验证根为 object；没有定位字段知识，不会从 runId 创建 dir。
- `pi-agent-core/dist/agent-loop.js:380–389,416–425,474–501`：sequential 与 parallel 都先发 tool_execution_start.args，再 prepareArguments、validateToolArguments、beforeToolCall。parallel 不等于省略校验，也没有统一填充所有可选字段。
- `pi-coding-agent/dist/core/agent-session.js:325–339` 把 validated args 作为 tool_call.input；`core/extensions/runner.js:957–973` 按注册顺序运行 handlers，可共享原地修改输入；agent-loop 后续直接执行 prepared.args，没有再次 schema 校验（`:574` 附近）。
- message_end 的扩展替换发生于持久化之前：`core/extensions/runner.js:864–901`、`core/agent-session.js:883–899,935–953,751–769`。因此 session JSONL 的 assistant args 已晚于 adapter 与 message_end，不是 immutable raw provider 快照。正常完成已删原参数字符串，旧记录无法补出原始 delta、转义或重复键。

### 5.2 已搜索处理器与剩余覆盖缺口

限定搜索 `pi/extensions`、根 `src`、本 package 主/child 入口和实现的 tool_call/message_end/prepareArguments/目标字段命中，回读了以下处理器：

| 处理器 | 现场代码 | 与 dir 添加的关系 |
|---|---|---|
| RTK tool_call | `pi/extensions/rtk.ts:116–132` | 只对 bash 重写 command，不处理 steer/status |
| security gate tool_call | `src/security-gates/extension.ts:7–29` | 读输入并拦截敏感路径/shell，不改目标字段 |
| MCP policy tool_call | `src/mcp-policy/index.ts:57–70` | 按工具名/资源许可拦截，不加 dir；本轮仅读源码，未接入或调用 MCP |
| subagent message_end | `subagent-dispatch/extension.ts:2349–2355` | 仅 custom supervisor request 的观察/注册，不替换 assistant tool args |
| completion notices | `src/tui/completion-notices.ts:18–40`（本 package 下） | 仅 custom notify 生成 TUI 通知，不返回替换 message |
| 上游 bridge message_end | `pi-subagents/src/extension/herdr-pi-bridge.js:170–175` | 只保存 finalAssistant 引用并发送观察事件，不改 args |
| Pi builtin MCP tool_call | `pi-coding-agent/dist/extensions/mcp/index.js:1049–1071` | 读取 reachesTools、等待 readiness，无 dir 写入 |

`src/async-progress/index.ts:21–66` 的 message_end 只是从进度文件解析 usage 的条件，不是扩展改写 handler。其它动态注册或未提供加载清单的第三方 handler、私有 provider/router、远端 wrapper 不在本轮可证明的全覆盖范围；“搜索无相关写入”不能升级成“运行时绝无改写”。本地已检查 adapter 与 factory 没有 dir 注入，但不能据此直接排除未知扩展/外部 multi-tool wrapper。

### 5.3 UI 路径与 agent 实收字段

`extension.ts:2237–2242` 的 withToolRendererHint 只增加 renderer context.tool，传给执行的 args/result/details 不变；`src/tui/tool-renderers.ts:69–103` 读取 id/runId/index/dir 形成 Text；`src/tui/compact-rendering.ts:96–112` 从通知已有 asyncDir 字串提取 run id，`:194–200` 将已有 dir 格式化显示。这些操作不生成模型调用的目录参数。

另一方面，start 的公开结果确实可含 asyncDir：`extension.ts:1384` 附近的 details 展开 binding，`rpc-client.ts:42–64` 校验上游 spawn identity 字段；这是 agent 能看到目录信息的正常来源，与 TUI 内部生成显示文本不同。当前证据证明“目录信息可能可见”，不能证明是哪一次信息被复制进 steer 参数；本轮未输出该类结果正文，也未追读额外业务工具参数。

## 6. 获准 root 历史：声明、调用和错误关联

临时脚本位于本代理目录 `/tmp/steer-static-MQjvkH/extract.py`；不 import/execute 项目、工具或 service。流式解析的 invalidJsonLines 为空。输出统计为 `callCount=13`，steer=4、status=9，4 个声明对象。

### 6.1 声明证据

| JSONL 物理行 | entryId | timestamp | 类型 | steer required / properties | status |
|---|---|---|---|---|---|
| 8 | 1a856e8a | 2026-10-27T06:03:20.683Z | message 内声明 | message,index；id/runId/dir/index/message | id/runId/dir/index；均非 required |
| 670 | 189562b1 | 2026-10-27T11:58:49.702Z | compaction 内结构化声明 | 同上 | 同上 |

四份声明的目标字段类型与第 3 节一致，自身不接受 null；strict 字段未出现。第 670 行是 compaction 的结构化状态，不是第二份网络请求抓包。没有输出其摘要或其它正文。

### 6.2 调用投影

下表均为同一 root 文件。除 S1 外 id/runId 均为同一个完整 UUID；所有 13 次调用均携带 dir/id/runId/index，index 均为 0。dir 无缺失、null 或空串。S1 的 id 不是完整 UUID且与 runId 不一致，但 alias 首拒绝先于冲突检查。表中“成功”仅表示相配 toolResult.isError=false。

| 编号 | 工具 | 调用行 → 结果行 | assistant entryId | UTC timestamp | dir 形态 | id/runId | 匹配结果 |
|---|---|---|---|---|---|---|---|
| Q1 | status | 18 → 19 | eb22e978 | 06:05:38.299 | 绝对路径 | 相等完整 UUID | 成功；含 running、terminal pending |
| Q2 | status | 18 → 20 | eb22e978 | 06:05:38.299 | 绝对路径 | 相等完整 UUID | 成功；含 running、terminal pending |
| S1 / A | steer | 54 → 55 | a6fe42d4 | 06:30:31.329 | 绝对路径 | 不一致 | SUPERVISOR_STEER_TARGET_ALIAS |
| Q3 | status | 113 → 114 | 9ab39823 | 07:19:15.797 | 绝对路径 | 相等完整 UUID | 成功；含 running、terminal pending |
| S2 / B | steer | 115 → 116 | 00d832aa | 07:19:45.516 | 绝对路径 | 相等完整 UUID | SUPERVISOR_STEER_TARGET_ALIAS |
| Q4 | status | 166 → 167 | 9c2f1923 | 07:49:47.241 | 绝对路径 | 相等完整 UUID | 成功；含 running、terminal pending |
| Q5 | status | 184 → 185 | 8e04e7ac | 08:13:20.983 | 绝对路径 | 相等完整 UUID | 成功 |
| S3 | steer | 275 → 277 | 48602e84 | 08:50:22.628 | 绝对路径 | 相等完整 UUID | SUPERVISOR_STEER_TARGET_ALIAS |
| Q6 | status | 346 → 347 | 2d48be0c | 09:22:30.608 | 绝对路径 | 相等完整 UUID | 成功；含 running、terminal pending |
| S4 | steer | 429 → 430 | 65995a50 | 09:53:39.867 | 绝对路径 | 相等完整 UUID | SUPERVISOR_STEER_TARGET_ALIAS |
| Q7 | status | 482 → 483 | 016af65a | 10:14:37.770 | 绝对路径 | 相等完整 UUID | 成功 |
| Q8 / 新样本 | status | 676 → 677 | 1922173e | 12:01:04.690 | 非路径字符串，等于 runId | 相等完整 UUID | async 根目录边界错误；无本次提取白名单中的结构化 code |
| Q9 | status | 680 → 681 | f466fd14 | 12:02:03.335 | 绝对路径 | 相等完整 UUID | 成功；含 running、terminal pending |

日期均为 2026-10-27。为避免误把其它正文中的状态当权威结构化状态，“含 running/terminal pending”表示目标工具结果文本白名单匹配；它与用户提供的 Q9 状态事实相符，不构成独立 terminal proof。

工具调用关联 ID（保留完整 toolCallId；与上述行/entryId 联合定位）：

```text
Q1 call_3d48a369dbb24cf18bef530b03bfbc71|fc_0dd5b34257d9548e016ae03f2ad8bc81918d407289c61e6305
Q2 call_353635ba6dec47348840888b054462b7|fc_0dd5b34257d9548e016ae03f31bf1481918ad29e1a86072c37
S1 call_dac5e9222e214a0c9100bd69c3553d4c|fc_0dd5b34257d9548e016ae044fd54d08191bec0f339fb1f449d
Q3 call_0f70dfb95ba448f3a262cce570d36ed1|fc_0dd5b34257d9548e016ae05070f4e48191b43f4239be63cdb3
S2 call_eb790272dc19489e8952e7171c7c6468|fc_0dd5b34257d9548e016ae050862d188191a8e3c9448efbbfbe
Q4 call_3c3dccd449c7402da8dbd0b906f6073d|fc_0dd5b34257d9548e016ae0579885208191b5fb36aa97211b10
Q5 call_5887bc0156f44f34a4f9428fa6f951db|fc_0dd5b34257d9548e016ae05d1e93188191b2e9db4cba1e135c
S3 call_28615548510b4838b97b10319cb34270|fc_0dd5b34257d9548e016ae065cd381481918f08f3a39c6db76a
Q6 call_9876fca0c2244fe0acb83c5be2b19fa9|fc_0dd5b34257d9548e016ae06d552f3c819182ea6b7dac43bf9e
S4 call_744b3f952f144179b557d231ce0aee62|fc_0dd5b34257d9548e016ae0749e54088191867db6d32e44d21c
Q7 call_b8133d166ace4e009dac2ca936c82618|fc_0dd5b34257d9548e016ae07988cfd081918b7b44b07d85faab
Q8 call_3b35d7a5c1f94b1293603983bac32473|fc_0dd5b34257d9548e016ae0927f26e8819194578ae25fa80efa
Q9 call_9e586c669c1542979601b62288cf3ecb|fc_0dd5b34257d9548e016ae092bad18881918442d27172803532
```

Q8 结果 entryId 为 fbebb744，时间 12:01:04.695Z；错误文本为 `Async run directory must be inside /var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs.`。脚本将它标为 `ASYNC_DIRECTORY_OUTSIDE_BASE(text)`，**这是本报告分类标签，非声称生产返回了该 code**。Q9 结果 entryId 为 6f931686，时间 12:02:03.340Z。

### 6.3 status 的首拒绝路径

status 不经过 canonicalSteerTarget。`extension.ts:1724` → typed rpc.status → upstream `rpc.js:603–623` normalizeStatusParams / executeChecked → `subagent-executor.js:6656–6705` inspectSubagentStatus → `runs/background/run-status.js:416–476`。dir 非空时跳过 no-dir id resolver，直接 resolveAsyncRunLocation；`async-resume.js:164–166` 对 dir 调用 path.resolve 和 assertInsideRoot，`:114–120` 抛目录边界错误。

UUID 虽是合法 id，却不是本合同中合法的 async 目录路径；path.resolve(该字符串) 会依 cwd 形成非 asyncRoot 内路径。id/runId 完全相同也不会使 dir 被忽略。合法完整路径的 Q9 可通过该定位层，与 Q8 的错误相符。路径由上游在执行时解析并验证，不意味着它替调用者把 runId 自动填进 dir；该字符串在 assistant 持久 args 已存在。

## 7. 接口最小修正的评估（仅建议，未实施）

对**启用控制面的 steer**，没有任何一个非 undefined 的 dir 值能合法通过 resolver；即使目录真实、basename 与 id 相同也不会通过。对未接入/未启用控制面的直通 steer，上游 `subagent-executor.js:6730–6768` 可以消费合法 dir。因此建议的产品范围必须明确：模型 steer 统一收窄为受控 canonical 定位，不能声称移除 schema 字段在所有未受控集成中都没有兼容影响。

最小方案是从 `SUBAGENT_RUN_STEER_PARAMETERS.properties` 去掉 dir，保留 status/interrupt/resume/stop 的共享 TARGET_FIELDS；steer 单独列 id/runId/index/message。runtime `canonicalSteerTarget` 的 alias/conflict/path/prefix/index 拒绝、owner 三态、correlation、live epoch、reply gate、幂等、投递补偿全部保留。不把非法值删除后重发，不放行 alias，不把 owner unavailable 当 unowned。

可以先保留 steer factory 的 dir allowedKeys，作为历史/direct raw 输入通往既有 alias 拒绝码的执行兼容面：正常模型调用会被新 schema 的 additionalProperties:false 拒绝，direct raw 仍进入 canonical 拒绝。这样 allowedKeys 是内部可处理字段集合，不再意味着模型公开可用字段。若同时从 allowedKeys 删除 dir，则 raw 入口会先返回 INVALID_DISPATCH，既有 alias case 的 code/keypath 预期需调整；不能一边删该白名单一边声称现有 case 无影响。不得为了保留旧码而让模型非法字段越过 Pi schema 校验。

建议后续最小 WritePaths：

- 必要生产路径：`packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`（schema 收窄、字段复用注释及描述对齐）；不需要改 canonical resolver、RPC、service 或 provider。
- 如另行授权验证/调整既有 case：`test/subagent-operation-tools.test.mjs`、`test/subagent-runtime-membrane.test.mjs`；若有外部冻结合同，再单独声明其文档写路径。本轮没有申请或实施这些写入，没有新增 case/fixture。

已静态回读 case 影响：`subagent-operation-tools.test.mjs:62–119` 的 steer 合法样本没有 dir，当前也接受只有 message/index 的 schema 最小形状；本建议不顺带改至少一个 id/runId 的根结构表达。`subagent-runtime-membrane.test.mjs:2524–2533` 直接调用 execute 的 alias 断言可以在保留 allowedKeys 和 resolver 时继续表达原安全合同；同文件 `:2511`、`:2535` 之后的 conflict/prefix/owner/unowned/managed case 是后续保护面，不能删减。以上只是源码预期，不是本轮执行结果。

仅从 schema 删除 dir 可减少无意义的可选定位字段，不能修复未知远端把 id/runId 都强制非 null、optional-null 被错误处理或 dispose strategy 出现的问题。尤其不能凭这个局部建议宣称已定位 dispose 同根。

## 8. 共享候选、数据来源分类与后续最小取证

| 层次 | 已证事实 | 尚未证实 / 下一证据 |
|---|---|---|
| 模型公开接口 | steer 公开 dir，受控路径拒绝；dispose strategy 可选但仅 integrate 有效（workspace/operation-tools.ts:91–110；tool.ts:91） | schema 是否在实际请求或网关被收紧 |
| 可见调用外观 | root steer/status 13/13 同时携带全部定位字段；dispose 既有提取 39/39 含同一非 null strategy | 相同外观可能来自模型偏好、错误示例/上下文延续、远端 schema 转换或消息改写；不能仅按次数定因 |
| 本地 strict | 正确路径把 optional 编码 nullable，并在回程恢复缺失 | 实际远端是否走了该转换；省略/null strict 如何解释 |
| 本地工具适配 | factory 不补 dir；canonical 先于 RPC normalize；dispose 默认 strategy 在 guard 后（tool.ts:91–93） | 无证据支持“内部默认回写 provider 参数” |
| 可变 hooks / wrapper | message_end 能替换、tool_call 能改输入；已读 handlers 未见目标字段注入 | 未记录实际加载顺序，未见早期快照；私有 wrapper/router 未核实 |
| 结果/状态 | steer 在 gate 前拒绝；Q8 在上游路径拒绝；Q9 查询成功 | 没有合法 steer 投递/消费证明，也没有其它 agent 的具体记录 |

按缺陷数据来源三分类：真实工具记录证明这些错误形状通过生产模型入口到达相应拒绝层，不能归为测试制造数据；但不符合受控 steer 的有效参数语义，也未证明合法意图为何被编码为非法字段。首个偏离的**生成环节**仍属于“来源尚未证实”。公开 schema 与受控执行合同的矛盾可以独立确认；远端强填/共享根因尚不具备分类为已证生产缺陷的 provenance。不得为此添加忽略 strategy/dir、猜目标、自动重试等 production fallback。

继续归因所需最小、只读采样方案如下；本轮均未实现、未开启、未采集、未请求 provider：

1. **最终出站工具声明**：在 API converter 后、`onPayload`/before_provider_request 全处理链结束后，提取仅 steer/status/dispose 的 schema properties、required、additionalProperties、nullable/anyOf/default、constrainedSampling 及 strict 的存在性和精确 null/false/true。`core/sdk.js:224–249,273–275` 与 `core/extensions/runner.js:1066–1092` 表明 before_provider_request 本身可被后续 handler 替换；单个中间 observer 不是最终出站证明。普通 Responses `openai-responses.js:139–143` 与 Codex `openai-codex-responses.js:175` 附近的 onPayload 返回之后是具体观察位置。需要后续授权在实际路由启用有限采样；不读取模型配置、headers 或凭据。
2. **最早入站参数**：`provider_stream_event` 观察 Responses 的 output_item.added、function_call_arguments.delta/done、output_item.done，仅按同一 call_id/item.id 在内存缓冲目标 arguments，再提取 dir/id/runId/index 或 dispose strategy/disposition 的白名单。最终 item.arguments 可能替换增量，应同时核对，不能只拼 delta。该 hook 是 SDK 已解析协议事件，不是网络原始字节；若这里已含非空 dir，就排除其后 Pi validation/operation factory 首次加入，但仍区分不了上游模型与私有网关。
3. **跨层快照**：对同一调用复制 toolcall_end、message_end 处理链前/后、tool_execution_start.args、normalizeOptionalNulls 前/后、tool_call 全 handlers 后和 execute 入口的白名单投影。禁止原地改数据。用 sessionId + request/attempt 序号 + responseId + toolCallId 关联，随后补 entryId。单个 tool_call observer 的注册位置不足以代表最终输入。
4. **若最早 Pi 入站已含字段**：需协议/网关 owner 在另行授权下提供同一请求的收到 schema、转发上游 schema、上游返回目标参数、下发 Pi 目标参数与关联 ID，并明确 omitted/false/null strict 的规范化规则；不要采集完整 prompt、thinking、action_token 或 headers。HTTP fetch 旁路需要单独授权，且不覆盖 WebSocket，不能通过切换 transport 冒充原路径证据。
5. **其它 agent 关联**：先取得用户授权的具体 session 路径和失败 toolCallId，再采用相同白名单提取；不能借“其他 agent 也失败”广搜私人目录或把本 root 样本泛化到所有 agent。

如果没有新增采样授权，现有 session 只能把 dir 的首次可证出现定位到持久 assistant args：S1 第 54 行，而不能补回此前 raw response。当前到这里结束，不重发 status/steer，不处置 workspace。

## 9. 本轮操作与验证记录

本轮使用 read/rg 做静态读取；git status、git diff --cached --name-only 仅检查现场。只在本代理 `/tmp/steer-static-MQjvkH/` 写辅助脚本，逐行只读上述唯一 root JSONL，不 import/execute 项目代码、不调用工具/service、不启动 Host/session/provider/fetch、不运行任何 test runner。

临时解析器首次执行因扫描声明时某对象的 name 是 dict 而触发 TypeError，在临时脚本加 string 类型检查后成功；该失败没有输出业务正文。另有若干 rg 包含推测但不存在的源码路径，返回 exit 2；后续使用真实路径静态读取（如 run-status.js、core/sdk.js）。这些失败属于只读路径/解析辅助，不是生产复现或验证结果。没有把它们隐藏为全部命令通过。

有效提取结果：13 个调用（4 steer / 9 status）、4 个声明对象、0 个 JSON 解析错误、全部调用匹配到结果；steer alias 4 次，status 目录边界失败 1 次、成功 8 次。没有新增或运行测试；旧报告的 7/7 不计入本轮验收。

仓库唯一新增写入是 `docs/investigations/2026-10-27-steer-argument-pipeline-deep-dive.md`。未修改 production/配置/测试/node_modules，未暂存/commit，未访问 models/auth/凭据/私有 authority/token/grant/全量环境，未进入目标 managed workspace，未控制任何 run。最终文档检查输出：275 行、13 个记录 ID 与获准 root 的目标调用集合完全一致、重复 ID 为 0、尾随空白为 0、代码围栏成对；`git diff --no-index --check /dev/null docs/investigations/2026-10-27-steer-argument-pipeline-deep-dive.md` 无输出并通过。`git diff --cached --name-only` 为空；指定路径 `git status --short` 仅显示本报告为新增 untracked。结论不扩大为真实 provider 采样或行为恢复证明。

## 10. 实施记录（2026-10-27，按 §7 最小方案收窄）

用户已就本报告 §7 的最小方案给出实施授权。本轮只做 schema/描述收窄，不改任何运行期门禁。

**生产改动（`packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts`）**：

- 新增 `STEER_TARGET_FIELDS`：取值 `TARGET_FIELDS` 的 `id`/`runId`/`index` 三个字段形状（对象引用复用，不复制值域），**不含 `dir`**。
- `SUBAGENT_RUN_STEER_PARAMETERS.properties` 改为 `{ ...STEER_TARGET_FIELDS, message }`；根形状不变（`type:"object"`、`additionalProperties:false`、`required:["message","index"]`）。模型带 `dir` 的调用现在由 `additionalProperties:false` 在参数层拒绝（参数错误，不再进入执行期）。
- `TARGET_FIELDS` 本体未改：status/interrupt/resume/stop 仍共享含 `dir` 的同一份字段形状。
- steer descriptor 的 `allowedKeys` **保留 `dir`**（§7 的执行兼容面）：direct raw 输入仍穿过 factory 到达 `canonicalSteerTarget` 的既有 `SUPERVISOR_STEER_TARGET_ALIAS` 拒绝码；删除该键会让 raw 入口先返回 `INVALID_DISPATCH`，改变既有 alias case 的 code/keypath，本轮不做。
- `canonicalSteerTarget`、`executeControl` 的 gate 顺序、owner 三态/correlation/live epoch/reply/幂等/投递补偿全部未改。

**测试适配（只改既有断言，不新增文件/case 块）**：`test/subagent-operation-tools.test.mjs` 既有非法输入集合新增一行 `{ message, index, dir }`，锁定「steer schema 拒绝 dir」；steer 合法样本本就无 `dir`，未动。`test/subagent-runtime-membrane.test.mjs:2524` 的 direct raw alias 断言（保留 `allowedKeys` 与 resolver）继续通过，未改。`test/operation-guidance-contract.test.mjs` 对 steer 描述只断言 `/supervisor gate/`，无需同步。

**验证（本轮实际执行）**：`npm run typecheck`（root + `pi-subagents-enhanced`）0 错误；`node --test test/subagent-operation-tools.test.mjs test/operation-guidance-contract.test.mjs` → tests 25 / pass 25 / fail 0；`node --test test/subagent-runtime-membrane.test.mjs` → tests 112 / pass 112 / fail 0（含 `steer 拒绝 dir 别名目标，避免绕过 owner 判定`）；`node --test test/subagent-dispatch-extension.test.ts test/supervisor-gate-wire.test.mjs test/joint-upgrade-model-only.test.mjs test/subagent-compact-rendering.test.mjs` → tests 71 / pass 71 / fail 0。

**过期陈述登记（超出本轮 writePaths，未改）**：`docs/plans/records/2026-10-16-operation-tools/contract.md:45` 仍把 `dir` 列在 `subagent_run_steer` 的 optional 清单。该 S0 冻结表是收紧前字段盘点，已先后被 `docs/plans/records/2026-10-17-runtime-convergence/steer-locator-contract.md`（index 必填）与本记录取代（同一文件的 `:55` 早已记录受控 resolver 拒绝 `dir`）；源头更正经父层裁决。

**边界**：本轮不声称解决生成层「携带全部定位字段」的外观问题（§6/§8），也不覆盖控制面未启用时上游直通 steer 的 `dir` 消费能力（§7），未新增任何 fallback、推断或自动重试。

## 11. 闭环结论与复发观测

本节追加于 2026-10-27 重启之后，只记录新证据、对 §8 候选表的影响评估与复发观测口径；不改动 §1–§10 正文、表格与归因边界。下列新证据由主会话在本轮直接观测，本节按转达记录，**本轮没有重放采集、没有读取重启后的新 session、没有读取任何出站 body 或模型配置，也没有发起 steer/status 调用**。

### 11.1 新增证据（主会话验证，2026-10-27）

| # | 观测内容 | 时间与来源 | 与前述章节的关系 |
| --- | --- | --- | --- |
| E1 | 重启后一次 `managed_workspace_dispose`（disposition=discard）**成功省略了 strategy**：参数校验通过并进入执行 | 2026-10-27 约 12:05 重启之后；主会话在正常请求路径直接观测 | 同一 provider/model 家族的“可选字段真能被省略”正例；本报告 §6 的 4 次 steer 样本全部携带 dir/index/id/runId（末次 S4 09:53:39.867Z） |
| E2 | steer 模型 schema 已收窄：`STEER_TARGET_FIELDS` 只含 id/runId/index，steer 不再声明 dir；status/interrupt/resume/stop 共享的 `TARGET_FIELDS` 未改；runtime alias 拒绝与 `allowedKeys` 兼容面保留；重启后注册生效 | 同上；实施与验证见 §10 | 直接针对 §3.1、§7 的接口矛盾；不影响 §6 的历史样本事实 |
| E3 | discard 对 dirty worktree 的死锁已修：`releaseManagedGitWorkspace` 改为分级 force（tracked 修改 force 删除；非 runtime 元数据的未跟踪用户文件仍 fail closed） | 同上；源码 `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:495-517`，bug 记录 `docs/bugs/2026-10-27-discard-dirty-worktree-deadlock.md` | 与 steer 参数链无关；仅说明同一轮现场修了另一个结算链缺陷，不构成 steer 归因证据 |
| E4 | 现场受管工作区 `183f86ee-d4b9-482d-a5fc-1038e42d9623` 已 released：重启后 settlement replay 自动完成，worktree 目录清空、managed 分支删除，终态无剩余动作 | 同上（主会话观测） | 与本报告 §6/§8 的“没有合法 steer 投递/消费证明”不矛盾（那是 steer 的事）；本轮仍未控制或观察任何 run |

E2 的精确含义：**结构性陷阱已在参数层消除**。重启后模型若再传 `dir`，会在 Pi 参数层被 `additionalProperties:false` 拒绝（成为参数错误），不再进入执行期 `canonicalSteerTarget` 并返回 `SUPERVISOR_STEER_TARGET_ALIAS`。这不等于“生成层不会再带 dir”：direct raw 输入仍会触发既有 alias 拒绝码，后续任何重新引入 dir 的 schema 变更都会使同一外观复发。

### 11.2 对两个候选假设的影响

| 候选 | 新证据下的状态 | 依据与仍然缺失的部分 |
| --- | --- | --- |
| (a) 远端 strict 收紧强制填参（§4.2 / §8 共享候选） | **被削弱**，不排除会话/配置差异；对 steer 的转移仍是弱证据 | E1 证明当前请求路径可以表达可选省略；若远端把 optional property 一律归入 `required` 且不补 null，这次省略不可能成功。但：E1 属于 dispose 调用，**重启后没有 steer 省略样本**，也没有当次出站 `strict` 三态；历史 4 次 steer 样本与 E1 是否共享同一 provider 配置/compat/路由/`onPayload` 链未观测。因此只削弱“必然强制填参”的普适版本，不宣称 steer 侧已否证 |
| (b) 历史失败样本自我强化（§8 第二行“可见调用外观”） | **与全部证据相容** | 13/13 次 steer/status 均携带 dir/id/runId/index、index 均为 0，且 dir 无缺失/null/空串（除 Q8 的 dir 等于 runId 的非路径字符串外均为绝对路径，§6.2）；历史 toolCall 参数会被重放（§5.1），同形错误结果又提供了“已有示例”的上下文；叠加旧 schema 声明 dir 且描述说它会被 gate 拒绝的诱导。E1 不能排除该候选：一次省略成功与“多数轮次继续复制旧外观”不矛盾 |
| 生成层首次偏离点（§1/§8） | 未变 | **归因状态仍是「来源尚未证实」**：S1–S4 的 dir 是谁先写出的（模型偏好 / 上下文自强化 / 远端 schema 转换 / 未知 handler 或 wrapper）本轮没有新增同次证据；Q8 的 index=0 与 dir=UUID 同属未定位的生成侧形态 |

按数据来源三分类：E2 属已落的接口矛盾修复（§7 建议）；E1/E3/E4 属预期 production 数据被正确处理的正例；§6 的 4 次 alias 与 1 次目录边界失败仍是「真实工具记录已证、生成来源未证」。不得因 E2 把历史样本改写为“已解决”，也不得因 E1 把 steer 的历史外观归因为模型偏好。

### 11.3 已落地的结构防线（各自位置）

| 防线 | 位置 | 作用面 |
| --- | --- | --- |
| steer 定位字段收窄（§7 最小方案已实施） | `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:126`（`STEER_TARGET_FIELDS`）、`:141`（`SUBAGENT_RUN_STEER_PARAMETERS.properties`）；实施记录与验证结果见 §10 | 模型侧：dir 不再出现在 steer 声明中，传入即参数错误；id/runId/index/message 值域与 `required:["message","index"]` 未改；status/interrupt/resume/stop 的 `TARGET_FIELDS` 一字未改 |
| 执行侧门禁全部保留 | `subagent-dispatch/extension.ts:1401`（`canonicalSteerTarget`）、`:1654` 起的受控分支；descriptor 的 `allowedKeys` 仍含 dir | direct raw 输入仍到达 `SUPERVISOR_STEER_TARGET_ALIAS`；owner 三态/correlation/live epoch/reply/幂等/投递补偿未变（§7） |
| discard 分级 force（同期落地，与本工具无直接关系） | `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:495-517`；`test/managed-workspace-service.integration.mjs:355` 附近的「dirty workspace must never be silently destroyed by discard」断言原样保留 | 结算层：分离 tracked 修改与未跟踪用户文件保护；不涉及 steer 参数生成或 gate 顺序 |

层次区分：这些防线都不属于 §8 第 1–3 条要求的“最终出站声明取证”；后者仍未实施（未启用采样、未生成 patch、未改 node_modules、未读 models/auth）。E1 也不取消该取证的优先级，只是降低“必须先改 adapter 才能让 steer 可用”的紧迫性。

### 11.4 复发观测指标与最小采样方案引用

若未来再出现「模型可见可选字段被必填」形态（新工具、其它 agent、同一工具在别的会话/模型上，或 steer 再次出现携带 dir 的调用），按以下顺序核对，**先核报文，再核历史形态**：

1. **当时出站 schema**：目标工具声明在 API converter 后、全部 `onPayload`/before_provider_request 处理链之后的 `strict` 存在性与精确三态（缺失 / false / null）、`required`、`properties`、`anyOf`/nullable、`additionalProperties`，以及该会话 steer 声明是否仍为 §3.1 的收窄形状。Codex 的 `strict:null` 与普通 Responses 的省略不是同一分支（§4.2），不能互推。
2. **当时会话历史形态**：是否已累积同形失败回显（§6.2 的 13/13 全字段外观）、description 是否仍含“dir 会被 gate 拒绝”类诱导文字、是否跨重启/跨模型/跨网关。历史 arguments 会被重放（§5.1），样本数量本身不是根因证据。
3. **分类判定**：出站 schema 里定位字段进入 `required` → 归 provider adapter / 能力元数据 owner（dispose 报告 §6 第 1–3 条）；出站可选但历史已含同形外观 → 上下文自强化 + 生成层，不加生产兼容；出站可选且历史无回显 → 生成层或网关，需要网关 owner 的同请求四份白名单（§8 第 4 条）。

采样一律沿用 §8 已备好的 1–5 条方案及其白名单，**不在此重复展开**：最终出站工具声明、最早入站参数（`provider_stream_event` 的 `output_item.added` / `function_call_arguments.delta|done` / `output_item.done`）、跨层快照（toolcall_end / message_end 处理前与处理后 / tool_execution_start.args / normalizeOptionalNulls 前与后 / tool_call 全 handlers 后 / execute 入口）、必要时网关四份白名单，以及 `sessionId + request/attempt + responseId + toolCallId → entryId` 的关联规则与禁止记录项（完整 prompt、thinking、action_token、headers、endpoint）。dispose 报告 §6 的 A/B 两档授权范围可作为同一采样的并行参考。目前均未授权、未实现、未采集。

### 11.5 结论：不再为已修复接口追加 production fallback

明确结论：**对已修复的接口（steer 定位字段、dispose 的 discard 结算）无需再追加 production fallback 或兼容分支。**

- steer 的模型侧矛盾已在 schema 层消解（§10、§11.3），执行期 alias/conflict/path/prefix/index 拒绝与 owner/correlation/live epoch/reply/幂等/投递补偿保持原样；因此不需要“忽略 dir 后重发”“猜目标”“auto-fill index”“自动重试”类分支，也不需要把 owner unavailable 当 unowned。
- `allowedKeys` 保留 dir 是既有 direct raw 输入的**执行兼容面**，不是新增宽容解析，也不得被用作让模型非法字段越过 Pi schema 校验的通道（§7）。
- 对 §6 这类**生成层外观问题**，正确响应是 §11.4 的报文核对与最小采样，而不是再叠一层 tolerant 解析：§3、§5 已证 factory、validator、adapter 均不补 dir，继续加兼容分支只会在无证据的前提下改变安全语义。

若后续授权实施 adapter/能力元数据修复，那条改动属于上游 owner 与受审构建流程，不构成本仓的 fallback 分支。
