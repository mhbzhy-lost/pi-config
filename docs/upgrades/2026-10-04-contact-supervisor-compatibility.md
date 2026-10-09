# contact_supervisor 联合升级兼容调查与验收合同

日期：2026-10-04。任务：dispatch-adad2ff0。**只读调查；只新增本报告，不修现有 0.87.1 + 0.71.0，不改候选代码、联合计划或生产配置。目标 1.0.2 + 0.75.0 尚未通过此专项，维持 NO-GO。**

## 1. 证据、版本与分类

已阅读根 AGENTS、enhanced/AGENTS、联合计划与审计、joint-loader/release-decision、HANDOFF；核对当前 child extensions、extension/membrane、supervisor adapter/control plane、RPC 和 RootBroker 入口及对应测试。官方依据为现存候选的 npm 0.75.0 发布源码与 docs，而非从 changelog 推断实现：

- 候选：`/tmp/pi-102-subagents075.ye2_0hoh`；下文 `U/` 指 `repo/packages/pi-subagents-enhanced/node_modules/pi-subagents/`。
- 实际读取 `U/package.json` 的 version 为 `0.75.0`，exports 中有 root、intercom-bridge、control-channel、child-tool-plan 等，**没有 native-supervisor-channel 或 child-session factory 的公开 subpath**。
- 联合计划锁定 gitHead `ad56bf92fe01a2a5abd962938c619eb2a22ca47d`（subagents）与 `cd32f7725fdbddbaecdff5b1e68491563394e0ca`（core）。本次没有重新下载安装或独立核验 tarball SRI；复用既存源码作为静态证据，不冒认闭包复装验收。
- `HANDOFF.md:154`：bf27eaf2 的 child 请求**已经到达 parent pending**，reply 却被拒 `SUPERVISOR_REQUEST_NOT_PENDING`，interrupt/resume 解锁。这是正常生产链两套 pending 不一致，历史类别 1，**不是“请求根本未到父”**。
- `HANDOFF.md:191`：6ff2829 使用非受管 run 的 Host session authority 登记；7283394 增加跨 reload 持久化，记载真实探针四步全通。同文件 :192 仍保留历史死锁警告。因此不得仅凭历史段落断言当前相同缺陷未修复，也不得把旧四步证据结转为目标组合 GREEN。
- 用户这次“child 调用但 parent 未收到”没有提供 reason、requestId、child run/index、parent session、调用结果、请求文件与 parent message_end 时间线。**最新现场属于类别 3（来源未证），不是已证类别 1，也不能断言测试/环境类别 2。** 最先要区分 progress_update 与阻塞 ask；本次不读取真实 session/凭据以补证，不给猜测 fallback。
- HANDOFF 的 ambient `PI_SUBAGENT_CHILD` 假失败、版本覆盖误报是已知环境污染；它们能解释测试误判，不能直接解释这次通信故障。联合 bundled/physical namespace 精确失败是另一已证类别 1；physical 新拓扑尚未验证，不能从旧拓扑失败外推。

## 2. 三层通路，不可混称 bridge/RPC

### 2.1 官方 native supervisor：跨进程文件请求与回复

`U/docs/configuration.md:508–530` 明确：native supervisor 不依赖外部 pi-intercom 安装；`resultDelivery` 是外部 completion ACK，不是 supervisor ask。`U/docs/extension-api.md:156` 明确 pi.events 仅进程内。

真实消息生成链如下（行号均为发布的 `.js`）：

1. `U/src/intercom/intercom-bridge.js:109–189` 的 `diagnoseIntercomBridge / resolveIntercomBridge / applyIntercomBridgeToAgent` 决定 mode、parent target、注入指导与 declared tools 中的 `contact_supervisor`。这不是传输回执；有指导不等于工具实际注册或 parent 已收到。
2. `U/src/runs/shared/child-launch.js:132–154`：只有 orchestrator target、parentSessionId、runId 齐备才创建 channel dirs；runtime 携带 orchestratorSessionId/parentSessionId、runId、agent、childIndex 与 channelDir。
3. `U/src/runs/shared/child-runtime-config.js:9–21` 的 `childSupervisorMetadata` 要求 channelDir/runId/agent/orchestratorSessionId/index；缺失返回 undefined。
4. `U/src/runs/shared/subagent-prompt-runtime.js:478–490,551` 在 child hooks 中调用 `registerNativeSupervisorClientOnce`；最终 `U/src/intercom/native-supervisor-channel.js:179–192` 注册 model-only `contact_supervisor`，如果同名工具已存在则不覆盖。须验工具来源，不能只验名称。
5. `native-supervisor-channel.js:107–166` 的 `sendSupervisorRequest`：生成随机 UUID，写 `requests/<id>.json`，含 runId、agent、childIndex、toolCallId、orchestratorSessionId、reason、expectsReply、createdAt；阻塞 ask 另含 expiresAt。默认 ask 10 分钟，`PI_INTERCOM_ASK_TIMEOUT_MS` 可配置（:15,68–71）。
6. **progress_update** 在 :143–147 立即返回 `details.delivered:true` 与“queued”，只证明本地原子文件写入。parent `poll` 在 :686–690 删除该文件，**不注入 parent 消息、不触发 parent 模型 turn**。这是 0.75 实际语义；不能要求进度工具每次都显示父通知，也不能将 delivered:true 写成父已收到。若产品要求模型收到进度需另行产品裁决，本轮不改语义。
7. **need_decision/interview_request** 在 :148 进入 `waitForReply`（:93–105），检查 reply type/requestId/message；abort/timeout 删除 request 并报错，不产生成功 ACK。interview 解析失败放 structuredReplyParseError，不等于传输失败。
8. parent `U/src/extension/index.js:307` 创建 channel，:823 用 Host SessionManager 设置 `state.supervisorOwnerSessionId`，:1042–1043 start/activate；:917 dispose。
9. `native-supervisor-channel.js:327–330 requestMatchesOwner` 严格检查 request.orchestratorSessionId 与当前 supervisor owner session。`poll`（:666 起）解析、检查 lifecycle、去重；:692–694 **先 pending.set**，再 :698–715 `pi.sendMessage(customType:"subagent_supervisor_request", triggerTurn:true)`。发送显示失败被 catch，**native pending 仍保留**。message details 有 id/requestId/runId/agent/index/reason/body，但没有 ownerGeneration 或原 expiresAt/orchestratorSessionId。
10. parent 公开 `subagent_supervisor` 对应 `buildParentSupervisorTool`（:517 起）：每次调用 discover+refresh；pending/list 是 native map 投影。reply 在 :536–543 resolvePendingRequest → writeReply（:448–459 原子写 replies 并删 request）→ appendEntry → 删除 native pending。
11. child waiter 读取该回复文件后返回 reply 内容。native reply 文件本身**没有 ownerGeneration、parentSessionId 或 consumed 回执**；requestId+channel 是其实际相关键。不得凭空要求官方已提供本仓 authority receipt。

`requestLifecycle`（:394–405）区分 wrong-session/missing/resolved/expired/inactive；`getSupervisorRequestState`（:596 起）另以 runId/agent/index/toolCallId 维护 attention correlation。这不等于授权 pending。

### 2.2 本仓 typed facade 与 supervisor 授权控制面

以下 `P/` 指 `packages/pi-subagents-enhanced/`：

- `P/extensions/subagent-runtime.ts:306–348` 建立 supervisor control plane；owner 由 RootBroker 权威读取，未 ready/存储错误不能视为 unowned。:389 在 session_start 恢复 durable state；:483 传入 enabled facade。:512 renderer 只负责展示。
- `P/src/compat/pi-subagents-0.71.ts:10–13` 只从官方 root bootstrap；:17–33 session identity 来自 Host SessionManager，不从 cwd 猜测。
- `P/src/subagent-dispatch/extension.ts:1838` 以 headless membrane bootstrap 上游；`runtime-membrane.ts:121,232` 捕获上游 `subagent_supervisor` definition 并绑定 execute 到 adapter。`supervisor-adapter.ts:21–39,43–67` 只绑定/委托，未绑定、重复绑定、dispose 均 fail closed。
- **本仓 pending 真入口是 `extension.ts:1615–1641` 的 Host `message_end`**，过滤 customType 后取 message.details，调用 `registerSupervisorRequest`。不是 child 工具返回、不是 RPC reply、不是 native pending.set。登记失败记录 registrationFailures、诊断并发 registration_failed。
- `supervisor-control-plane.ts:143–156` 登记权威身份、digest、owner/request generation 与 pending。managed 用 owner receipt；确认 unowned 才用 Host root + 固定 generation=1（:21,124–140）。**该 1 不是真实 broker owner generation**。
- `extension.ts:1237–1278` 的 `createControlledSupervisorAdapter` 是 parent reply 真入口：先按 Host root 查本仓 request，构造 intent，经 resolveSupervisorControl 授权后调用被捕获的 native parent execute，之后 commitDelivery。
- `supervisor-control-plane.ts:158–176` 校验 root/owner/runtime generation、request generation、expiry、pending 与幂等；:178–207 commit receipt，只有 consumed:true 才 delivered/replied，普通成功仍 queued/pending。
- 因而可出现 **native pending 可见，而 message_end 尚未发生/未成功登记，typed reply 无授权 pending**。官方“sendMessage catch 后保留 native pending”与本仓“只能 message_end 登记”构成必须实测的窗口，静态源码只能证明结构风险，不能证明这次现场命中。

### 2.3 typed event RPC 与 RootBroker：不是 contact_supervisor 的传输

- `P/src/subagent-dispatch/rpc-client.ts:3–4,195–318` 发 `subagents:rpc:v1:request` 并等待 per-request reply event；默认 5 秒，dispose 拒绝 pending。此 requestId 是 **RPC 调用 ID**，不是 supervisor UUID。
- 官方 `U/src/extension/rpc.js:17–20,690–718 registerSubagentRpcBridge` 消费同进程事件并返回 version/requestId/success/data/error；spawn :376–389 使用 script、拒旧 workflowScript。它支持 spawn/status/steer/interrupt/stop/resume 等，不承载 child contact_supervisor 文件 ask。RPC ready/ping 不是父收到 supervisor 的证据。
- `P/src/subagent-dispatch/root-broker-client.ts:108–153` 基于 grant、rootSessionId/callerRunId/callerToken 生成 `pi-root-subagent-broker-request.v1`，通过 broker socket 交换并支持 root.subscribe/acceptance.submit；`root-broker-server.ts:500–506` 的 readOwnerReceipt 查询 durable AuthorityStore，revoked/superseded 不再返回有效 owner。
- `P/child-extensions/root-session-owner.ts:43–136` 在真实 child session_start 订阅，处理 root.closing、lease.updated、EOF/lease expiry；这是 owned 生命周期与 proof/authority 层，**不写 native supervisor request/reply**。EOF 在有效 lease 未到期时不会立即杀 child；无 lease 的 EOF 或到期才终止，root.closing 触发 explicit_stop。不能把 EOF 等同成功 delivery。
- 官方 `U/src/runs/background/control-channel.js` 的 control inbox 另管 interrupt/timeout/stop/steer，公开 `U/src/api/control-channel.js:1–3` 仅导出 requestAsyncStop；`api/intercom-bridge.js:1–3` 仅导出 resolveIntercomSessionTarget。不能把这些 exports 当公开 supervisor/factory 注入接口。

## 3. 已证测试覆盖与缺口

本次只运行既有无 socket 聚焦测试，没有新增测试或伪造目标验收：

```text
env -u PI_SUBAGENT_CHILD -u PI_SUBAGENT_FANOUT_CHILD TMPDIR=/tmp node --test \
  test/subagent-supervisor-adapter.test.mjs \
  test/subagent-dispatch-rpc.test.mjs \
  test/subagent-runtime-membrane.test.mjs
112 tests / 112 pass / 0 fail / 0 skipped / 0 todo，2285ms，Node 26.8.1
日志：/tmp/contact-supervisor-readonly-validation.log
```

这是**当前仓库基线单元/facade 合同**，不是 Pi1.0.2+0.75 actual child GREEN。adapter 测试委托 fake execute；RPC 测试 event bus；membrane :1792–1839 非受管 case 手工发 message_end、fake native reply，再手工 commit consumed；:1842–1872 reload case 只重建 control plane，不是 physical parent/child 重启。supervisor-replay.test.mjs 是另一个 durable outbox 的手工事件重放，不是 native contact 请求发现。RootBroker protocol/owner 测试亦不能替代 native文件通路。

明确缺口：

1. 没有这次请求的 reason/provenance；progress_update 无通知是目标上游设计，阻塞 ask 的丢失才需端到端定位。
2. native pending→sendMessage→Host message_end→authorized pending 的实际 1.0.2 事件顺序、成功可见性及失败窗口未验。
3. `replying` 仅在类型/解析允许状态中出现，当前没有状态赋值路径；不得声称已有 pending→replying→replied 原子状态机。
4. 当前 production 调用 commitDelivery 不传 consumed:true；全 src 搜索只找到 `markDeliveryConsumed` 的定义，没有 child waiter consumption 的实际调用者。现有测试通过手工 consumed 推进。真实 native回复成功可能只留下 queued/pending receipt，必须由目标测试显示事实，不把手工 ACK 当 production proof。
5. 本仓 expiry 自登记起 20 分钟（control-plane :154），native waiter 默认自发送起 10 分钟；message details 未透传 expiresAt。超时后的两平面清理/late reply/queued receipt 未全链覆盖。
6. reply 的 `to`/省略 replyTo 是官方合法 schema 选择方式（native :482–502），本仓授权查找目前用 params.replyTo；需要目标公开工具验证支持或稳定拒绝，不悄悄绕过授权。
7. duplicate/queued receipt 的索引、跨 root 与 ownerGeneration 防串线须以实际多 Host/重启验证；同版本文件存在、status/ping、child本地成功都不证明正确父收到。

以上不授权修当前基线，也不授权为目标加宽 fallback。若目标 public 路径精确失败，主 agent 按来源分类后另立最小 TDD 任务。

## 4. 最小可行 1.0.2 + 0.75 验收合同（后续必跑，本次未跑）

### 环境与入口

- 每 case fresh process，Node22.19.0 与 current26.8.1 两遍；显式锁定 core1.0.2/subagents0.75.0 与两个真实路径/hash。使用隔离 HOME/agent/XDG/TMP，白名单 env，parent与Node detached child统一已验证 physical Host root；不能 hot reload 冒充 fresh Host。
- 用官方 root extension + 本仓公开 typed dispatch 工具实际 async/script→runs.run leaf 入口，worktree:false 和 managed worktree:true 各至少一条；真实官方 detached runner PID/processBirth、actual child SDK session、required扩展 ack、实际注册 tool 与 model-only 可达性均观测。不得深 import factory/setChildSessionFactory、手工写请求/回复、直接 append message/proof、fake native execute 造端到端 GREEN。
- **零付费模型优先**：以官方公开 Host provider registration 配置受控合成 provider，让 actual child 的真实模型 pipeline 输出 contact_supervisor toolCall，并在 receipt 后输出终态。必须是真 detached child 中注册的真实工具，而非 scripted factory 模拟 child。provider能力仅属于合成 lane；不得以此声称真实模型 canary。
- 本次禁止 socket/模型/真实 session，故未启动该 lane；后续需要允许隔离 synthetic session、受控 provider/RootBroker 本地 socket、临时 Git workspace与测试进程组。若公开 provider 无法传到 detached runner、physical launcher/工具执行无公开路径，标 **environment-blocked + NO-GO**，列出具体首阻点；如必须真实模型，再单独申请指定模型/费用/次数，不私有注入或改预期。
- 只通过 Host 合法消息/extension 事件、公开工具结果和 runner资源观测关联身份。接收证据至少同时包含：child tool_execution_start 的 toolCallId；实际生成 supervisor UUID；parent Host message_end（带 requestBody nonce）；parent公开 pending 同 UUID；authorized registration诊断/状态证据；public reply；child tool_execution_end 结果中的同 UUID 与回文 nonce。**父 pending/status 文本与 child delivered:true 不能单独作 pass。**

### 必跑矩阵

| 编号 | 实际行为 | 强断言与失败归属 |
|---|---|---|
| C1 | need_decision 真实 detached往返 | nonce与requestId在child、父message_end、native pending、授权请求、reply与waiter完全一致；parentSessionId=实际Host id=orchestratorSessionId，run/index/agent正确；不需interrupt/resume。合法事实下丢失/拒reply为类别1。 |
| C2 | interview_request | child真实请求结构、parent看到原始内容、reply JSON解析成功；非法JSON只报structuredReplyParseError，不偷换transport成功。 |
| C3 | progress_update | 明确验证queued本地成功与parent无custom消息的0.75语义；不将其当阻塞ask丢失。若产品要求父模型收到，记录scope决策而非加fallback。 |
| C4 | 启动/无UI/消息发送失败窗口 | 真实Host公共入口能产生的时序下，比较native已登记与message_end/授权登记；pending可查但reply无授权须保留精确首偏离点。私有fake sendMessage故障只能作单元边界，不能证明production可达。 |
| C5 | unknown/no pending/多ask/to选择 | 合法公开工具查询与reply unknown稳定拒绝；并发两个ask不误路由；to/省略replyTo要么受控支持要么明确拒绝，不能授权另一个child。 |
| C6 | reply与重复delivery | 顺序与并发同UUID同payload不会双投递；不同payload不能改写已消费结果；queued≠delivered，receiptId/idempotencyKey/generation/digest保持，waiter实际消费后才验replied。 |
| C7 | 状态及timeout | 观察pending→reply执行窗口（当前replying未实现须诚实标缺口）→queued或replied；真实等待到短的合法ask deadline，native expired/missing与授权expired/failed保持可解释，不接受20min幽灵pending或late reply假成功；不伪造倒退时钟。 |
| C8 | parent reload/重启 | 不把hot reload加入支持拓扑；作为负向生命周期测试，原父关闭/新fresh同逻辑session恢复或稳定拒绝均有明确合同。same identity pending恢复、different session拒绝、replying/queued crash gap、native目录发现与durable plane一致，旧订阅/通知不可重复。 |
| C9 | EOF/stop/lease expiry | worktree:true真实root.subscribe建立；公开stop/root关闭、订阅EOF、合法lease到期分别验真实SIGTERM/terminal proof与ask waiter取消；有效lease的EOF行为按实现区别记录，不能声称立即stop。pending/receipt不被误写delivered。 |
| C10 | owner迁移/双Host隔离 | 真实authority产生ownerGeneration/processBirth/revision，旧generation reply被拒，另parent session相同run标签不串线；non-workspace仅权威unknown_run+当前Hostroot可授权，store unavailable/revoked不降级。 |
| C11 | 工具/加载身份 | actualchild有contact_supervisor、来源为native、requiredack有效；parent实际subagent_supervisor绑定native execute。每process内部SessionManager/Agent/Container/streamSimple正确namespace；跨process仅比较artifact/root/protocol，不要求JS对象同一。 |

不必为了验收给生产补“万能reply入口”或“owner读取失败视为unowned”。实现缺口若在目标合法链精确 RED，先中文bug证据再最小GREEN；测试自造非法身份/缺字段/私有factory为类别2，只修harness；无法证明来源或缺权限为类别3/environment-blocked，fail closed。

### 证据记录与放行条件

每 lane 保存非敏感 Node/version/artifact/root/命令/count、parent/child进程来源、时间顺序与第一偏离点；UUID、Host sessionId、child run/index、ownerGeneration/requestGeneration、digest、delivery receipt在同一关联表。callerToken、凭据、真实session正文不落报告。

`GO` 只在双Node C1–C11有效支持范围通过、actual parent确收证据成立且queued/consumed处理合同已验证时成立；不支持路径明确拒绝。纯ABI或mock测试PASS不得替代。缺真实无模型公开链、physical身份、receipt消费证据或生命周期清理任一项即NO-GO。

## 5. 本次验证与权限记录

- TDD豁免：**纯文档调查**，已先读 test-driven-development Skill；未生产实现，不声明RED→GREEN。既有112项仅用于验证基线覆盖，不是故障复现或新组合验收。
- 本次唯一写入路径为本报告；主仓既有dirty源码/tests/docs保留，候选未修改。没有安装、真实模型/MCP调用、socket服务、真实session操作、凭据读取、commit或staging。
- 文档验证：交付时运行 `git diff --check -- docs/upgrades/2026-10-04-contact-supervisor-compatibility.md`，并检查暂存区；结果见任务 acceptance report。
- 已知限制：最新故障没有provenance trace，不能保证目标不复现；本次完成的是精确入口调查与可执行验收合同，不是联合升级通信GREEN。后续执行与计划修改只由主 agent inline负责。
