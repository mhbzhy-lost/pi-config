# supervisor reply 门禁不一致疑报调查

调查日期：2026-10-27。任务：`dispatch-5af0fc87`。结论：本次没有证实 production 门禁缺陷，已证实调用方把请求 ID 的 `4f6a` 誊写为 `4a6a`，随后误读 status 总计数及 steer 错误码，形成“同一请求门禁互相矛盾”的错误归因。

主管经 `contact_supervisor` 审阅原始证据后确认参数誊写错误，撤销原 production、测试及 `docs/bugs/` 写入范围，改为只读取证，仅允许新增本调查报告。没有修复代码、放宽门禁、重放 reply、修改真实请求存储或启动 Host/provider。

## 1. 证据范围与身份

下文用以下缩写引用现场文件；行号均为物理行号，源码为调查时工作区版本，不冒充历史 Host 构建快照。

- **P**：`var/sessions/2026-10-27T06-02-12-954Z_01a17bf3-ba5a-71a2-bcb9-d3ee233671d7.jsonl`，父会话记录。
- **A**：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/`，只读运行产物根。
- **C**：`A/aec1d177-179c-49f4-8303-767123cbd590/events.jsonl`，原 child 事件。
- **D**：`var/workspaces/supervisor-control/supervisor-734214a4a4ec3872f08ffc16e9b3af037869926c07a67ea82ca5fce59bc62d08.json`，root 对应持久化控制面状态，单行 JSON。
- **E**：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`。
- **S**：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`。
- **N**：`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/intercom/native-supervisor-channel.js`，实际安装的 pi-subagents 0.80.0 原生实现。

请求的权威身份：

| 字段 | 值 |
| --- | --- |
| rootSessionId | `01a17bf3-ba5a-71a2-bcb9-d3ee233671d7` |
| runId | `aec1d177-179c-49f4-8303-767123cbd590` |
| 真实 requestId | `d9d5f5dc-5652-4f6a-810c-14869ce29548` |
| 两次 reply 和 status 所用错误 requestId | `d9d5f5dc-5652-4a6a-810c-14869ce29548` |
| ownerGeneration / requestGeneration / childIndex | `1 / 1 / 0` |
| childSessionId | `01a17dd2-1868-73ba-bbc5-e3639e3ff7b3` |
| 登记 createdAt / expiresAt | `2026-10-27T15:02:53.529Z / 15:22:53.529Z` |

取证只投影 ID、时间、状态、关联元数据及固定错误码，不输出请求/回复消息正文或凭据。既有 dirty 文件保持原样。

## 2. 真实时间线与首个偏离点

| UTC 时间 | 证据 | 事实 |
| --- | --- | --- |
| 14:46:14 | C:143、C:144；P:1080 | 同一 child 先发出 `97585912-0eaa-4a80-855e-974c878d94e5` 决策请求；控制通知含 event/async/intercom 通道。 |
| 14:46:43 | P:1081、P:1083；C:145 | 父按正确 ID reply 成功；child tool result 的 details.requestId 与之相同。 |
| 15:02:53.174 | C:613 | 第二次 `contact_supervisor(reason=need_decision)` 开始，toolCallId 为 `call_a4db43c2acc94a1991df996ede960a98\u007cfc_0b8d6339cae65a70016ae0bd0ab8f8819481ff6c82fa33eb37`（此处 `\u007c` 表示分隔字符）。 |
| 15:02:53.529 | D:1 | 控制面登记真实 `4f6a` 请求，correlation.toolCallId 与 C:613 精确一致。 |
| 15:02:53.538 | P:1085 | 父收到原生 `subagent_supervisor_request`，details.id 是 `4f6a`。 |
| 15:04:56.022 | P:1093 | 首个已观测偏离：assistant toolCall 的 replyTo 变为 `4a6a`。 |
| 15:04:56.030 | P:1094 | reply 返回 `SUPERVISOR_REQUEST_NOT_PENDING`。 |
| 15:05:01.538 | P:1096 | pending 返回真实 `4f6a`，没有 `4a6a`。 |
| 15:05:23.710 | P:1098、P:1099 | 第二次 reply 仍使用 `4a6a`，再次正确拒绝。 |
| 15:05:37.092 | P:1100、P:1101 | status 仍传 `4a6a`；原生 details.pending=1，附加 supervisorDiagnostic.requests=[]、receipts=[]、availability=available、complete=true。 |
| 15:05:58.104 | P:1103 | pending 再次明确返回 `4f6a`。 |
| 15:06:25.316 | P:1104、P:1105 | 对原 run、index=0 的 steer 返回 `SUPERVISOR_STEER_NOT_ALLOWED`。 |
| 15:06:35.365 | P:1106、P:1107 | 父 interrupt 原 run。 |
| 15:06:35.482–.489 | C:614、C:615 | 原 run paused；contact_supervisor 结束为固定取消结果，无成功 reply requestId 回执。 |
| 15:06:43.809 | P:1108、P:1109 | resume 返回新 run `b3dbecba-47ac-4c6c-928c-4aa7507d60a6`。 |
| 15:12:32.211 | 新 run 的 process-terminal.json:1 | runner 终止已观测，exitCode=0；canonicalSession lease 已释放。 |

“首个偏离”指已经落盘的调用参数，不是未经观测的 provider 原始帧。主管承认是其参数誊写错误；本调查没有采集当次模型出站或入站帧，因此不进一步判断字符在哪个生成/传输阶段改变。

原合同还把成功请求 `97585912` 归入更早其他 child；C:143–145、P:1080–1083 和 D:1 证明它实际属于同一 `aec1d177` run。因此该成功样本尤其适合排除 run、child 或通道身份差异推断。

## 3. 状态来源、键控和读取时序

### 3.1 请求生成与登记链

`contact_supervisor` → N:124 的 `sendSupervisorRequest` → N:129 生成 UUID → N:156 按 requestId 写原生请求文件 → 父 N:751 扫描请求文件、校验 owner/lifecycle → N:772 按 `request.id` 写原生 pending Map → N:779 发出含相同 ID 的 custom message。

增强层 E:2424 的观察逻辑由 E:2479 的 message_end 与 E:2488 的 before_agent_start 账本扫描调用。Host 的 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:325` 先通过 `captureSupervisorCorrelation` 取得关联，再调用 S:269 的登记函数。关联捕获见 `supervisor-consumption.ts:46`，按未闭合 child contact_supervisor 调用、reason 和请求正文匹配；本次 D 中关联与 C:613 一致。

S:280 的持久化 Map 键是 `root:run:ownerGeneration:requestId:requestDigest`，S:285 保存。D 读取快照 revision=58，使用仓库的 `supervisorCanonicalDigest` 对 stateDigest 校验通过。D 同时包含成功请求 `97585912` 和真实请求 `4f6a`，二者 root/run/ownerGeneration/requestGeneration/childIndex、childSessionId 和 PID 相同。前者为 replied 且 receipt=delivered/consumed=true；后者存储状态 pending、无 reply receipt；错误 `4a6a` 完全不存在。

D 是调查时快照，不是每次调用时的历史快照。其 createdAt 早于两次 reply，两次 reply 也都早于 expiresAt；P 中当时的原生 pending 记录提供独立时间锚点。当前存储字段仍为 pending 不代表调查时 TTL 仍有效；此次直接只读，没有调用 loadRoot 或触发过期写回。

### 3.2 reply 的精确查找正确拒绝了不存在的请求

独立工具入口 `supervisor-operation-tools.ts:174` 注入固定 action；reply 经 controlled adapter 执行，不经 subagent run 的 executeControl。

E:1795 调用 `findRequestAsync(params.replyTo, hostRootSessionId)`；S:502–505 在 root 事务内重载后，按 requestId 和 root 精确查找。S:233 的 durable 事务在 root 锁内清除旧内存视图并重载，不能把本次解释成随意读取旧 Map 快照。

错误 `4a6a` 查不到，E:1804 返回 `SUPERVISOR_REQUEST_NOT_PENDING`，不会进入 E:1818 的 `resolveSupervisorControl` 或原生投递。即使继续到 S:287，findPending 也要求 pending 状态及 root/run/owner/requestId/requestGeneration 全匹配，不接受 UUID 近似值。

因此这不是 reply 查错 child、owner generation 或 channel，也不是注册时序漏项。实际是调用方传入了另一个不存在的身份。不能自动把 `4a6a` 猜成 `4f6a`，也不能因通道里“恰有一个 pending”而绕过精确身份门禁。

### 3.3 pending 与 status 两层投影的作用域不同

原生 N:581–583 先 discover 并 refresh；N:588–590 的 pending 列出原生 Map 条目，按请求 ID 展示。P:1096、P:1103 均返回正确 `4f6a`。

原生 N:585–586 的 status **直接返回 `pending.size`，不读取 `replyTo`**。所以 `Pending replies: 1` 只证明通道当时有一个 pending，不能证明被查询的 `4a6a` 存在。

增强层 E:1786–1788 保留原生 status 结果，在 details 中附加 supervisorDiagnostic；E:1777 把 replyTo 转成 requestId 过滤器，S:447–450 对当前 Host root 的 requests 和 receipts 精确过滤。P:1101 的原生总数=1 与过滤后 requests=[] 正好对应“真实 `4f6a` 待决，错误 `4a6a` 不存在”，两者没有矛盾。

因此原生 pending Map 与 durable Map 确实是不同状态源，但本例两者对真实身份一致，不能仅因存在两套投影就认定数据不同步。此次也不修改 status 合同或 raw payload。

### 3.4 steer 没有提供“pending 门禁阻止”的证据

`subagent_run_steer` → E:1576 的 executeControl → E:1698 的 `resolveSupervisorControl`。S:290 读取 runtime，S:291–295 验证 owner，S:299–302 **先**检查 childIndex、running、steerable、liveRunEpoch；运行态不满足返回 `SUPERVISOR_STEER_NOT_ALLOWED`。

只有越过该前置门禁，才会走 S:315–321 的 pending/replying 扫描、`classifyRequest` 以及 `gateBlocksChildSteer`。该路径对目标 child 确有待回复义务时返回的是 **`SUPERVISOR_REPLY_REQUIRED`**。策略函数见 `supervisor-gate-policy.ts:483`。

P:1105 是前一错误码，因此不能当成后一分支的证据。Host runtime 来源为 `extensions/subagent-runtime.ts:279–289` 的 rpc.status/owner 读取与 `runtime-state.ts:13–25` 的转换。现场未保存该次门禁的内部 runtime 快照，不能仅凭之后 paused 的状态倒推出当时究竟是 running、steerable、epoch 还是读取失败；本报告只定位到有证据的前置分支，不另立 runtime 缺陷结论。

## 4. 候选解释核对与分类

| 原候选 | 证据裁定 |
| --- | --- |
| intercom/native 登记到了不同注册表，reply 看不到真实请求 | D 有真实 ID 及完整 correlation，P pending 同 ID；失败调用使用另一个 ID。本次不支持此假设。 |
| workflow parent、typed 包装或 owner/child 键差异 | 同 run 的成功样本与失败请求登记字段相同；reply 在错误 ID 查找阶段已返回，不到 owner 判定。 |
| 注册与读取竞态、旧快照或 TTL 到期 | D.createdAt 早于两次调用，expiresAt 晚于两次调用；不存在的 ID 才是直接原因。 |
| pending 阻止 steer、reply 却不能回答同一 pending | reply 使用错误 ID；steer 返回运行态前置门禁码；原命题的两个前提均不成立。 |

按仓库缺陷数据来源门禁，此例不属于“预期 production 数据未被正确处理”，也不是测试制造的 fixture。实际入口是合法工具，但参数指向不存在的身份；工具 fail closed 符合合同。

按照主管的结案裁决，归入“来源尚未证实”家族中的**操作侧调用参数誊写样本**：已经证明持久化调用参数不一致，尚未证明错误字符的更早生成来源；不构成 production 缺陷，不添加兼容、防御或 fallback。主管将其与此前 41 次 strategy、13 次 dir 调用参数问题并列。41 次 strategy 的持久化计数和生成来源限制可参见 `docs/investigations/2026-10-27-dispose-argument-pipeline-deep-dive.md:11`、`:61`；dir 的调用语义问题见 `docs/investigations/2026-10-27-subagent-steer-target-rejection.md:156`。13 次 dir 是主管给定的历史口径，本轮未独立确认该计数，不能把这些案例的上游根因视为已经相同。

最小处置是撤销本次错误的生产缺陷归因，保留精确 ID、owner、TTL、runtime 和 child 门禁。真实请求在有效期内应使用 pending 返回的完整原始 ID；本轮没有补发、恢复或复活已被取消的旧请求。

## 5. 后果与恢复证据

本次误判导致原 T8 run 被不必要 interrupt，真实 `4f6a` 请求没有收到 reply；C:615 是取消结果，不是消费证明。D 未出现该请求的 reply receipt，与此吻合。

P:1109 的新 run 为 `b3dbecba-47ac-4c6c-928c-4aa7507d60a6`。旧、新 run 的 `status.json:1` 及 `recovery-descriptor.json:1` 均指向同一个原 child session 文件：

`var/sessions/2026-10-27T06-02-12-954Z_01a17bf3-ba5a-71a2-bcb9-d3ee233671d7/aec1d177-179c-49f4-8303-767123cbd590/run-0/session.jsonl`

旧 run 状态 paused，新 run 状态 complete。新 run 的 `process-terminal.json:1` 独立记录 runner exitCode=0、state=observed、canonicalSessionLeaseReleased=true。恢复因此有“同一会话继续执行并正常退出”的证据，不只是完成文案。

在会话恢复范围内没有发现数据丢失；原 session 未被替换成空白会话。没有对任务业务产物执行逐项审计，因此不把这一结论扩展为所有业务数据均无损的证明。旧请求的取消不会被新 run 的正常退出改写成“原 reply 已消费”。

## 6. 验证、变更与未覆盖边界

已执行只读 Node 断言核对：

- P:1085、P:1096、P:1103 的真实 ID 与 P:1093、P:1098、P:1100 的错误 ID 精确比较。
- P:1101 的总 pending=1 与 request 过滤后空数组同时成立。
- D 的 stateDigest 与仓库 canonical digest 一致；真实请求存在，错误请求不存在，真实请求没有 reply receipt；两次调用均处于该登记的有效期。
- 恢复前后 sessionFile 相同，旧 paused、新 complete。

输出：

```text
PASS: actual/requested IDs differ; pending/status projections match their scopes; durable digest valid; real request registered before replies and unexpired at both attempts; resumed run reused session and completed.
Stored revision: 58 request created: 2026-10-27T15:02:53.529Z expires: 2026-10-27T15:22:53.529Z
```

本次仅新增本报告。生产和测试零改动，因此原修复合同的测试更新、聚焦回归及 `npm run typecheck` 在主管调整为只读调查后不适用，均未运行；上述断言是对已有证据的只读核对，不是新增仓库测试，也不是模拟生产修复成功。文档引用及空白检查通过，`git diff --cached --name-only` 为空，未 stage/commit。

未覆盖边界：没有执行真实多进程投递 smoke、没有向 provider 发请求、没有拿正确 ID 重放历史操作、没有历史 runtime 内部快照或 provider 原始参数帧、没有业务数据全面审计。报告不声称消除了其他控制面潜在问题，也不据此批准放宽任何门禁。
