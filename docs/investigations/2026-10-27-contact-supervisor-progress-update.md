# contact_supervisor 的 progress_update 静默调查

一句结论：当前安装的 `pi-subagents@0.80.0` 在父 Host 的 native supervisor poll 中成功解析并确认归属后，主动删除 `progress_update` 请求，既不注入父 session/模型消息，也不发送对应的 TUI 通知；这是有源码注释和公开变更日志支持的上游静默策略，但与 child 提示要求“向主管报告重要进展”的语义存在落差，尚不能据此确认用户那一次调用的具体收件情况。

## 1. 调查边界与证据基线

- 只写本报告，未修改 production、测试、配置或依赖，未 stage/commit。
- 未启动 provider、真实模型、Host CLI 或 child 进程；未读取用户的其他会话、真实 transport 请求、凭据或会话日志。
- 实际运行的是源码检查、既有聚焦测试，以及通过真实工具注册/execute、真实 request writer/parser/poll/reply 代码的内存 transport 探针。探针只替换文件系统与父 ExtensionAPI 边界，不手工生成 request 文件或替换 reason 分流函数。
- 工作区本来有大量未提交修改，包括 enhanced 的入口与 dispatcher。本报告行号针对调查时工作区，不能将 `HEAD` 当成完整运行版本。`HEAD=633a2af2c43ae4dbbe9a2dc1d88937d39353622a`，Node `v26.8.1`。
- enhanced manifest 固定 `pi-subagents: 0.80.0`（`packages/pi-subagents-enhanced/package.json:40`），实际安装包也是 `0.80.0`；当前 Host 为 `@earendil-works/pi-coding-agent@1.4.0`。历史 1.3 调查不能替代本次安装源码。

关键源码 SHA-256：

| 文件 | SHA-256 |
|---|---|
| 上游 `src/intercom/native-supervisor-channel.js` | `484af927e2bc484d442f47b05238f3d4250c1beef182d56a204b48a9b389afbb` |
| enhanced `src/subagent-dispatch/extension.ts` | `b9349c011f67614a5cb689e18ce4cb9df907dba2cfac9e4aa269b11e2b2d42e6` |
| Host `dist/core/agent-session.js` | `436e8be3bbab2db475ce30bb5d0bb30f0046b19a3476f8cd57b8133e68891162` |

下文路径缩写：

- `U/` = `packages/pi-subagents-enhanced/node_modules/pi-subagents/`
- `E/` = `packages/pi-subagents-enhanced/`
- `H/` = `node_modules/@earendil-works/pi-coding-agent/`
- `N` = `U/src/intercom/native-supervisor-channel.js`

## 2. progress 与 decision 的完整链路对照

| 阶段与源码 | progress_update | need_decision / interview_request |
|---|---|---|
| 运行配置生成：`U/src/runs/shared/child-launch.js:132`、`:145` | 正常 launch 创建 supervisor channel，写入 runId、agent、childIndex、父 session ID | 相同 |
| child 注册：`U/src/runs/shared/child-runtime-config.js:15`、`subagent-prompt-runtime.js:660`；`N:218` | metadata 齐备才注册 `contact_supervisor`；execute 委托 `sendSupervisorRequest` | 相同 |
| schema：`N:25`；声明：`:197` | reason 枚举合法；非空 message 必需 | decision 同样需 message；interview 可以空 message 并携带 interview 对象 |
| 构造 request：`N:124`、`:130`、`:137` | `type=subagent.supervisor.request`，UUID、时间、权威配置身份、toolCallId；`expectsReply=false`，不写 expiresAt | `expectsReply=true`，写回复期限；interview 原样附结构化问题 |
| transport 写入：`N:153`、`:156` | 序列化不超过 64 KiB，以 atomic JSON 写 `requests/<UUID>.json` | 相同；使用 native 文件通道，不要求外部 pi-intercom/MCP |
| child 工具回执：`N:157` | 立即返回 `Supervisor progress update queued.` 和 `details.delivered=true`；此时尚无父侧 ACK | `N:164` 等待 `replies/<UUID>.json`；超时/取消会报错并清理 request；interview 对回复做 JSON 解析 |
| parent 建立通道：`U/src/extension/index.js:290`、`:816`、`:1082` | session 启动绑定 owner ID、启动/激活 native channel | 相同 |
| 父 poll 解析与身份：`N:743`、`:752`、`:754` | `parseRequestFile` 明确接受三种 reason（`:236`）；匹配 `orchestratorSessionId` 或已继承 run owner（`:363`）；通过后才消费 | 相同 |
| 生命周期：`N:438` | reply、超时、run inactive 三项判断均受 `expectsReply` 限制；正常进度不会因为 run 已完成而在此判 inactive | 已回复、过期、inactive 的决策请求会清理，不再送成新 pending |
| **首个不投递父消息的分流：`N:765`** | `if (!request.expectsReply)` → 注释明确不注入 parent message、不触发模型 → `removeRequestFile`（`:768`）→ `continue`（`:769`） | 继续记录 correlation（`:771`）、`pending.set`（`:772`）、声明父工具、建立 settle 提醒、标记 attention |
| 父消息与事件：`N:779`、`:803`、`:814` | **没有** `sendMessage`，没有对应的 `subagent_supervisor_request`，没有 `pi-intercom:detach-request` | `parentWake.sendMessage` 发送 `customType=subagent_supervisor_request`，`display:true`，完整 requestBody/details 与回复提示，请求 `triggerTurn:true`；随后发 `pi-intercom:detach-request` |
| native pending/status/reply：`N:579` | public 工具的 discovery 也会调用同一 poll，因此查询本身就可能完成进度删除；pending/status 不保留进度 | pending 返回需回复请求；reply 写正式回复文件、删除 request，追加 `subagent_supervisor_reply` entry，移除 pending |
| enhanced 消息观察：`E/src/subagent-dispatch/extension.ts:2490`、`:2500` | 无消息可观察，不进入 enhanced gate 注册 | 扩展 `message_end` 与 `before_agent_start` 活跃分支扫描共同观察请求；以 request ID 去重、注册 |
| enhanced 注册/回复授权：`E/extensions/subagent-runtime.ts:401`；`E/src/subagent-dispatch/supervisor-control-plane.ts:272` | 正常生产链在更早处已经终止 | 校验 broker/root、owner/generation、canonical child 未闭合 toolCall；`extension.ts:1806` 回复前解析控制意图，native 提交后记录 queued receipt |
| child 消费与终局观察：`E/extensions/subagent-runtime.ts:399`；`E/src/subagent-dispatch/supervisor-consumption.ts:91` | 终局对账明确只核对 decision/interview 的回复消费，不重放进度 | `subagent:process-terminal` 触发对账，核对 child 的实际 toolResult、请求关联和回复摘要后才升级 consumed |
| TUI | 无对应父消息，自然没有 supervisor 消息卡 | Host 按 `display` 交给已注册 renderer；回复提交 entry 与回复内容卡各有展示 |

这里有两个不同层面的“分岔”：`N:130` 的 `expectsReply=false` 正确表达单向更新；真正使主管收不到正文的首个偏离点是 `N:765–769` 的删除分支，位于 **`subagent.supervisor.request` 文件已读、`subagent_supervisor_request` 自定义消息尚未生成** 之间。该分支不发专门的“进度已消费”事件，不能给它杜撰事件名。

## 3. 分别回答收件、模型与显示问题

### 3.1 是否到达 parent Host

对当前代码的正常、owner 匹配路径：**会到达父进程中的 native supervisor channel，并被读取后删除**。内存探针记录真实 parser 对工具生成文件的 read，以及真实 poll 的删除；running 与 complete 两种状态均复现。

但这不等于用户那次调用已被读到。child 的 `delivered:true` 在父 poll 运行之前即返回，只证明 atomic writer 成功；若父 Host 未启动、owner 不匹配、watch/poll 未推进，仍可能只停在 request 文件。不能凭 child 回执、工具调用成功或父 agent 行为下定论。

### 3.2 是否进入主 agent 可见消息/session

正常 progress 分支**不进入父 session，也不进入主 agent 模型上下文**。原因是发送源头没有调用 `pi.sendMessage`，不是 renderer 事后隐藏。

decision 的下游链路则为：

1. `U/src/shared/parent-wake.js:36` 处理唤醒。普通路径保留 `triggerTurn:true`；held 或已有 idle wake 预约时以 `triggerTurn:false` 追加消息，避免重复启动。
2. `E/src/subagent-dispatch/runtime-membrane.ts:156` 原样透传 supervisor message/options；其 suppress/forceDisplay 仅针对 `subagent-notify`，没有 progress reason 过滤。
3. `H/dist/core/agent-session.js:1844` 的 `sendCustomMessage` 在 busy 时 steer/followUp、idle 且需唤醒时启动 custom run、不唤醒时追加或排到当前 turn 结束；`:1883` 的 `_appendCustomMessage` 写 `appendCustomMessageEntry`，刷新上下文，发 Host `message_start/message_end`。
4. `H/dist/core/messages.js:89` 将 `role=custom` 的 content 转为模型 `role=user` 内容；这里不检查 `display`。因此“UI 不显示”本身不能证明模型不可见。

Host 事件流/RPC records 与扩展 `pi.on('message_end')` 不是同一个覆盖面：无唤醒追加路径直接 `_emit` Host 事件；enhanced 当前还通过 `before_agent_start` 扫活跃分支补注册（`extension.ts:2416`、`:2500`）。本次没有用“扩展 message_end 未观察到”冒充“session 没有消息”。

内存探针的父 `sendMessage` 接口是 mock，接收到消息后写真实 `SessionManager.inMemory()` 并调用真实 `convertToLlm`；所以探针证明的是 native 发送事实和 session/model 投影，不声称已经执行真实父 agent loop 或真实 provider 请求。真实 Host 注入行为由上述当前源码补证。

### 3.3 是否只产生被 TUI 过滤的通知

**不是。** `N:765–769` 没有 `ctx.ui.notify`、`pi.sendMessage`、`appendEntry` 或 detach event。此路径没有供父 TUI 过滤的进度通知。

显示层另有独立证据：

- `E/extensions/subagent-runtime.ts:783` 注册 `subagent_supervisor_request` renderer。
- `H/dist/modes/interactive/interactive-mode.js:3123` 只按 `message.display` 决定是否创建 custom 消息组件。
- `E/src/tui/tool-renderers.ts:105` 调 `formatCompactSupervisorRequest`；`compact-rendering.ts:205` 起只生成展示文本，`:223` 去掉固定包装行，保留正文，不检查 progress reason 来丢弃整条消息。
- 既有 `test/subagent-compact-rendering.test.mjs:272`、`:284` 明确将 progress 文本渲染为 `← (executor):\nUPDATE: 已完成扫描。` 并断言 raw message 不变，本次通过。
- `test/subagent-runtime-membrane.test.mjs:679` 的实际组件渲染检查通过，确认生成 Box、箭头和正文、raw message 不变。注意该测试虽标题含 progress，fixture 正文实际是 decision，因此 progress 正文证据来自前一组测试。

上游删除分支注释说 “Progress is already visible through child activity”。这只能证明作者的设计理由；不能据此断言当前 enhanced 后台活动列表确实逐字显示了该 `message`。child 的工具调用/结果可能保存在它自己的 transcript，详情视图也可能展示工具活动，但这与父主会话收到独立更新不是同一事实。本轮未打开真实 TUI 或用户 child transcript，不声明现场 UI 已经显示或没有显示某个子视图。

### 3.4 是否在分类、payload 校验、pending-only 或完成处理处丢失

| 候选原因 | 当前正常路径结论 |
|---|---|
| schema 不接受 progress | 排除：三种枚举明确存在，真实 execute 成功 |
| parser 拒绝合法 payload | 排除：parser 明确接受 progress；探针读取工具自行生成的 request 并进入删除分支 |
| reason 分类 | **直接原因**：工具把 progress 标为 `expectsReply=false`，父 poll 对该分类主动删文件、不投递 |
| 仅 pending 消费导致后续遗漏 | 不是首因；progress 在 `pending.set` 之前已被删，因此 pending/status 无记录是结果 |
| enhanced gate 拦截 | 不是首因；没有原生 custom message，注册入口不可达 |
| async run 完成时丢弃 | 不是本路径首因；lifecycle 的 inactive 条件只作用于 expectsReply 请求，running 时也复现静默；终局消费器不负责重新通知进度 |
| TUI 显示过滤 | 排除为首因；源头没有父通知，renderer 本身可显示进度正文 |
| Host 注入竞态或 message_end 观测盲点 | 对 decision 需分别查；无法解释已在 native poll 提前删除的 progress |

## 4. 公开语义与缺陷来源分类

确实存在设计静默的公开依据，不是根据“不应打断主 agent”推测：

- `U/CHANGELOG.md:609` 所属 **0.68.0（2026-09-15）** 的 Fixed 条目，`:652` 原文：`Keep supervisor progress updates out of parent model turns while still waking for decisions and structured questions.`
- 当前 `N:766` 原文：`Progress is already visible through child activity; do not inject a parent message or trigger a parent model turn.` 当前实现比“不启动新回合”更强：连父消息也不注入。
- 既有集成测试 `test/joint-upgrade-contact-supervisor.integration.mjs:66` 对 progress 断言工具返回 queued、父 `subagent_supervisor_request` 数量为零。该测试本次只审阅、未运行；它会启动 CLI 与 detached child，即使使用合成 provider，也超出本次选定的内存验证路径。该断言只证明“不生成阻塞请求”的既有预期，不能独立证明所有其他消息或所有 UI 都为空。

同时有可定位的语义落差：

- `U/src/intercom/intercom-bridge.js:20–29` 注入给 child 的提示要求用 `progress_update` 上报 “Meaningful progress or unexpected discoveries that change the plan”，禁止用普通 assistant 文本给主管发送状态更新。
- `N:201` 的工具说明仍称 “Contact the parent/supervisor session ... for ... progress update”；`N:159–160` 返回 queued 与 `delivered:true`，没有说明正文不会投递父 session。
- 根 `AGENTS.md:41`、`pi/AGENTS_SHARED.md:40` 与 `E/README.md:7` 要求 raw/session 与展示投影分离，不能把当前 transport 删除解释为“仅 TUI 精简”。这些条款本身没有另外承诺每条 progress 必须启动模型。
- `pi/AGENTS_GLOBAL.md:107` 说明工具由 runtime metadata 注册；`pi/agents/delegate.md:20` 规定 need_decision 的升级路径。检查中未找到根规范明确授权“进度正文应在送达前丢弃”的条款。
- `docs/bugs/bug-supervisor-request-frame-and-progress-reply.md` 曾描述 progress 是单向通知、可以 owner push 但不能 reply。这是历史 Broker 问题记录；不能用它证明当前 upstream poll 确实发出了 push，也不能将旧代码症状移植到当前版本。

按缺陷来源门禁分类：

1. **已证明当前生产代码可达的静默路径**：由正常 metadata 注册的 public 工具 execute 生成完整 request；父以相同 session ID 验证归属；writer → parser → lifecycle → poll 顺序正常；未手写坏 payload、未倒退时间、未制造陈旧 request。内存替换不改变字段生成和分流代码。`N:765–769` 确定使正文不投递，不能归咎于异常 fixture。
2. **相对当前上游合同，这是有意静默，不是证据已确认的随机生产丢包**。若产品目标是主管获得重要进展，则此行为是生产可达的产品合同落差：只要父 poll 正常收件，正文就不进入父上下文。应针对该落差决策，不能先给 schema/gate 加 fallback。
3. **用户那一次事件仍属来源尚未证实**：未取得那次版本、session/run 身份及请求观察数据，不能断言当时父已读到、也不能断言是旧版本或测试污染。对此保持未定，不给出修复完成或现场已复现的结论。

## 5. 已执行验证及输出

### 内存 public 工具探针

通过 `registerNativeSupervisorClient` 取得真实工具定义，参数 reason 来自真实 schema 枚举；经 `childSupervisorMetadata` 构造有效配置，父 owner ID 来自 `SessionManager.inMemory().getSessionId()`。只在进程内替换 `fs` 的同步 transport 函数为 Map，所有路径限制在虚拟前缀，`syncBuiltinESMExports` 使真实 upstream writer/parser 使用同一 mock。调用 native 父 `pending` 工具触发正式 discovery/poll，再由正式 `reply` 工具回复 decision/interview。未注册 provider、未起 child、未落地探针脚本。

命令形式：`node --input-type=module <<'NODE' … NODE`；输入是本次工具调用记录中的内存探针，入口、替换边界与输出如下，避免把 mock 的 session 投影声称为真实 Host 回合。

| reason / run 状态 | 父读 request | 父删 request | 父 sendMessage | mock 父 session / 模型投影消息数 | 回复前 pending | detach event | ui.notify |
|---|---:|---:|---:|---:|---:|---:|---:|
| progress / running | 是 | 是 | 0 | 0 / 0 | 0 | 0 | 0 |
| progress / complete | 是 | 是 | 0 | 0 / 0 | 0 | 0 | 0 |
| decision / running | 是 | 是，reply 时 | 1 | 1 / 1 | 1 | 1 | 0 |
| interview / running | 是 | 是，reply 时 | 1 | 1 / 1 | 1 | 1 | 0 |

两例 progress 的 child 回执均为 `Supervisor progress update queued.`，`delivered:true`。decision 收到 `**Reply from supervisor:**\n已核对`；interview 收到相同前缀与 JSON，`structuredReply={"answer":"已核对"}`。探针末行：`内存探针通过；真实文件写入=0；provider调用=0；child进程=0。`

这项验证的权威边界是：工具生成的 request 和真实 native 分流已经执行；没有真实 child 进程身份、持久 session 或用户那次 run 的证据。无需真实模型就能确认该明确分支；不能把内存 identity 当成用户会话 identity。

### 既有聚焦测试

```text
node --test --test-name-pattern='supervisor' test/subagent-supervisor-adapter.test.mjs test/subagent-compact-rendering.test.mjs
结果：tests 9，pass 9，fail 0。

node --test --test-name-pattern='^supervisor request renderer compacts inbound progress without mutating the message$' test/subagent-runtime-membrane.test.mjs
结果：tests 1，pass 1，fail 0。
```

未新增或修改测试；未运行全仓测试、真实 provider、真实业务验收或上述 detached 集成测试。早期部分 `rg` 候选路径不存在，返回 exit 2，随后定位到 enhanced 包内实际安装路径；未将缺失候选路径当作功能缺失证据。

## 6. 最小修复选项（仅建议，未实施）

1. **保持当前上游静默行为，先消除错误预期。** 对齐 child bridge 提示、工具说明和回执：明确 progress 不投递父 session，`delivered:true` 不能代表主管收到。若“改变计划的重要发现”需要主管行动，现有 need_decision/interview_request 已能升级，但不能把所有普通进度都改为阻塞决策。此选项只修语义，不满足“主会话应收到进展”的产品目标。
2. **保留正文、追加父 session，但不主动启动新回合。** 在现有 native 非回复分支复用 supervisor custom message 与 renderer，使用现有 Host `sendMessage(..., {triggerTurn:false})`，保持 raw content/details，不新增状态机。父 idle 时追加 session/TUI，后续自然回合可见；busy 时 Host 排到 turn 结束。注意只改上游发送不够：当前 enhanced `observeSupervisorRequest` 没有 `expectsReply` 分流，注册会要求“未闭合 child toolCall”，而 progress 工具通常已返回；控制面还会一律创建 pending（`supervisor-control-plane.ts:283`）。应在既有观察入口区分非回复通知，避免错误注册、假 pending 或 registration_failed；这属于同一个投递修复范围，不能跳过。
3. **若产品明确要求重要进度立即被主 agent 处理**，可在上述同一通知链请求已有 parentWake/Host 唤醒能力，仍不创建回复义务；这是改变 0.68.0 静默策略的产品选择，需单独确认目标。不要通过伪造 `need_decision`、强塞 pending、终局补造回复或新建平行 mailbox 状态机实现。

不建议只加 `ctx.ui.notify`：它只解决人可见，不解决 agent/session 投递。也不建议简单改用 `subagent-notify`：当前 membrane 对该类型有 completion 专属 suppress/display 行为，可能再被完成通知策略处理。复用现有 supervisor 通知时应保留完整 payload，仅在 renderer 做精简。

## 7. 最终确认用户那次观察需要的最小现场证据

仅需针对那一次调用和对应父子身份收集，不扫描其他会话：

1. **版本与实例**：当时 Host、enhanced、pi-subagents 版本及实际加载路径/哈希，是否 reload/恢复，是否本地 native 或 remote Herdr 路径。本报告证明本地 native 当前行为，不代表每个历史或 remote 实例。
2. **child 原始调用与回执**：toolCallId、reason、完整 message、requestId、时间、结果及错误标志；queued 回执只作 writer 证据。还需要 launch metadata 中 runId、agent、childIndex、orchestratorSessionId 与父当前 session ID 的关联。
3. **父 transport 读取证据**：该 request 文件被哪个父实例读取、owner/lifecycle 判断、删除分支。请求文件不存在本身不够，可能是回复、超时或其他 cleanup；需要关联 UUID 的时间/分支观察或受控复现。不能仅靠 `delivered:true` 推导。
4. **父 raw 消息面**：该时间窗的 Host/RPC `message_start/message_end`、当前活跃 branch 的 `custom_message` 和消息 details；扩展事件记录可补充，但单独缺失不具否定力。若需证明模型确已收到，还要对应请求上下文投影或经授权的 provider 输入观察，不能只从 agent 后续文字猜测。
5. **TUI 面**：同一时间窗的 `display`、renderer 注册、终端输出或经授权的 `PI_TUI_WRITE_LOG`；区分主 transcript、后台活动行和 child 详情。若 raw 已到而主 UI 不显示，再查 renderer/display；若 raw 无发送，查 native 分支。
6. **决策对照**：同一父实例的一条 need_decision/interview 请求，核对 native pending → custom message → enhanced 注册 → reply 文件 → child toolResult；无需把终局完成通知当成进度收到证明。

本轮结论已足以定位当前实现的首个偏离点，并排除“只是 TUI 隐藏”的解释；用户具体那次调用是否经过同一路径，保留为未验证事项。

## 8. 追加：按上游当前设计，child 应怎样汇报重要进度

追加核对仍以实际安装的 `pi-subagents@0.80.0` 为准。**“重要”不决定 reason；是否需要主管作答才决定。** 上游 `U/docs/workflows.md:511–515` 和 child prompt（`U/src/intercom/intercom-bridge.js:23–27`）仍推荐通过 `progress_update` 报告改变计划的发现，但 0.68.0 CHANGELOG 与当前 `N:765–769` 明确不将进度注入父消息。应同时承认这两项事实，不能替上游补上“重要进度一定会送达主 agent”的承诺。

| 实际需要 | 当前代码下的推荐路径 | 能证明的可见性与限制 |
|---|---|---|
| 普通 FYI，无需主管行动 | 正常继续任务，依靠既有 child activity；不必把每个步骤都发成 supervisor 请求 | 上游活动视图展示当前工具、近期输出等；它是观察面，不自动形成父模型输入 |
| 重要发现，但仍在既定授权内、无需主管作答 | 按现有 child 提示可用 `progress_update` 记录简短进展，并在最终结果保留关键结论 | 该调用不会推送正文给主 agent；不能依赖它让主管及时知情 |
| 阻塞、选择、授权、产品/API/scope 歧义，或计划变更确实需要主管裁决 | `need_decision`，明确问题、可选方案和需要的授权；等待回复后再推进依赖该决定的工作 | 正式待决请求，父侧有消息、pending/reply 链；“需要改计划”若只是 FYI，不因此自动升级 |
| 需要一组结构化输入，而不是自由文本回答 | `interview_request`，用 `interview` 描述问题/所需结构；同样等待回复 | `N:491` 提示父侧回复 JSON；`:166–171` 解析为 `structuredReply`，解析失败另记错误，不等于按任意 interview schema 强校验 |
| 无需决策，但必须让主 agent 在任务中途收到正文 | **默认原生 supervisor 工具存在能力空档**；不能将 progress 视为满足此要求 | 父可以主动读取该 child 的 transcript/已授权产物，或事先配置有明确投递合同的外部通道；二者都不是 child 的原生非阻塞 push 保证 |
| 正常阶段/任务完成 | 返回完整结果，由已有工具结果或 runtime 完成通知交付；不另发例行 supervisor handoff | 是正常结果通路，但通知可能只含预览/文件引用，且受父 session 生命周期等条件影响，不保证全文立即进入模型 |

**“通过 activity 看”是设计意图，但“progress_update 仅在那里完整可见”并非已经证实的合同。** `U/docs/observability.md:11`、`:17`、`:54` 分别说明后台 session 事件镜像、紧凑活动信息和 transcript 检查；`U/docs/tool-reference.md:348` 起的 status 文档提供 `view:"transcript"` 主动读取。`U/src/tui/fleet-transcript.js:230` 起读取工具参数记录，`:400`、`:439` 在展开工具时显示参数，但有显示清洗、截断及记录存在性条件。native progress 删除分支自身没有把正文另行写进 activity store。因此可建议人查看活动/详情、父按需读取 transcript，不能保证默认活动行逐字显示进度正文，也不能把“人看过详情”算成“主 agent 已收到”。这些是上游接口说明，本仓 fresh Host 使用拆分工具；不应把上游 `subagent(...)` 示例直接当成本仓可调用工具名。

**其他机制不是可直接替换的原生 FYI 通道。** `U/docs/workflows.md:499`、`U/docs/configuration.md:605` 明确允许显式加载外部 provider 提供通用 `intercom`；这是受支持的可选集成方向，但本次没有验证其实际安装、权限、地址或收件语义，不能指导当前 child 调用不存在的工具，也不自动安装。配置 `intercomBridge.resultDelivery=true` 只给外部 listener 发送并确认 grouped completion，文档明确“不改变 supervisor asks 或 progress updates”（`configuration.md:603`）。Host `pi.sendMessage`/`pi.events` 是扩展能力，不是现有 child 模型工具；`observability.md:343` 还明确进程内事件总线不能直接跨 child 进程。workflow 的 `emit(...)`/工具更新可用于流式展示，但 `workflows.md:434` 明确活动更新不转发参数和 transcript，不能据此承诺主模型中途读到 FYI。

也不能反过来说“只有完成后才能知道任何进度”：父主动读取 transcript/产物的工具结果可以在任务中途带回可读内容。准确的空档是 **child 主动、无需回复、默认原生通道、中途向主 agent 推送正文**。正常结果通路有 `U/src/runs/background/notify.js:460–487` 的 `subagent-notify`/`sendMessage`；`U/docs/extension-api.md:603–615` 区分 content、details、忙碌/中止与 session 关闭，`:615` 明确 session 关闭后 detached child 可能完成而无人接收通知。`U/docs/workflows.md:436` 也说明 async completion 可能只含短预览和结果路径。因此最终返回是推荐的结果交付方式，不是“最终正文必定自动、完整、即时进入 parent”的无条件保证。

避免四类误用：不要把 FYI 伪装成 `need_decision` 来强制唤醒；不要把 `delivered:true` 当父收件/理解证明；不要用普通 assistant 进度文字替代 supervisor 通信（child prompt `intercom-bridge.js:20` 明确禁止，最终任务结果另按返回通路交付）；不要通过 `resultDelivery`、伪造事件或假 pending 绕过静默分支。若确有主管决定要做，用真实问题升级；若只是要求可靠中途 FYI，应明确报告当前能力空档，由主会话决定是否调整集成。

本次追加只做公开文档/源码交叉核对和报告追加校验；没有重跑上一轮测试，没有新增测试或启动 provider/child，也没有修改 production。上一轮测试结果仍只对应第5节所述范围。
