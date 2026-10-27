# `Supervisor control request blocked`：steer 目标别名拒绝与忙态排队调查

- 调查日期：2026-10-27
- 调查范围：当前生产源码、本仓已安装 `pi-subagents@0.80.0`、Pi 宿主文档 `@earendil-works/pi-coding-agent@1.4.0` 相关片段与 git 历史。
- 调查方式：只读静态追踪；未发送 steer/stop/interrupt/resume，未触碰活跃 child，未做真实 steer 实验，未访问凭据、models、auth 或外部系统。
- 生产版本证据：根 `package.json` 固定 `@earendil-works/pi-coding-agent:1.4.0`；`packages/pi-subagents-enhanced/package.json:39` 固定 `pi-subagents:0.80.0`。

## 结论

A、B 的首个拒绝都是当前本仓 `canonicalSteerTarget` 对 `dir` 的 `SUPERVISOR_STEER_TARGET_ALIAS` fail-closed 门禁。两次都没有到达 owner/correlation 校验、live/busy 校验、supervisor gate、上游 RPC 或 steer 队列，因此不能把这两次拒绝解释为 child 忙碌、process terminal pending 或队列消费延迟。

这属于 **by design 的安全门禁 + 调用方误传定位字段**，不是当前证据支持的生产 bug：`dir` 是上游通用 status/resume/stop/interrupt 定位字段，但在本仓受控 steer 上有意禁止作为别名。历史提交 `4499941` 的提交说明和 bug 记录明确写明，允许 `dir` 会使授权目标与上游真实投递目标不一致，构成授权绕过；因此本仓选择出现 `dir` 就拒绝，且不改道重试。

“忙时以前会进入消息队列”的记忆对应上游正常路径，事实成立，但它发生在目标和控制面门禁通过之后：上游 `steerAsyncRun` 只要求 run 状态为 `running` 或 `queued`，随后把 steer 请求写入 `control/steer-requests`；runner 消费文件后调用 child session 的 `steer` 或 `followUp`，Pi 再决定在安全点处理。忙碌影响的是消费时机和最终 `delivered/queued` 事实，不会使本次 A/B 的 `TARGET_ALIAS` 变成排队。

## 1. 注册、schema、参数映射与 A/B 首个拒绝点

### 注册与映射

主 Host 在 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2009-2015` 创建七个独立 operation tools；`extension.ts:2032` 逐个调用 `pi.registerTool`。`subagent_run_steer` 的 descriptor 位于 `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:245-258`，固定注入 `action:"steer"`（`:253-255`），只允许 `id`、`runId`、`dir`、`index`、`message`。

factory 将调用映射到既有 typed dispatcher：`extension.ts:2012-2015` 的 `executeControl` 回调最终进入 `extension.ts:1947-1950` 的 `Object.hasOwn(input,"action")` 控制分支，再进入 `executeControl`（`:1447`）。这说明 A/B 不是绕过 typed tool 的另一个入口；它们经过同一个生产 resolver。

当前独立 steer schema 的 `required` 是 `message` 与 `index`，见 `operation-tools.ts:120-131`；descriptor 也明写 `dir` 在 steer 上会被 `SUPERVISOR_STEER_TARGET_ALIAS` 拒绝，见 `operation-tools.ts:247-250`。`dir` 仍存在于共享 `TARGET_FIELDS`（`:38-43`）、steer `properties`（`:128-131`）和 `allowedKeys`（`:255`），这是因为 status/interrupt/resume/stop 仍共享该字段形状，且 factory 复用字段白名单；它不构成 steer 的运行时放行承诺。描述和执行期门禁共同表明：schema 接受该可选字段是兼容性/共享结构残留，明确语义是传入后由 steer resolver 拒绝，不是兼容降级或 fallback。

### canonical resolver 的顺序

`extension.ts:1396-1412` 的顺序是：

1. `:1397-1398`：只要 `params.dir !== undefined`，立即返回 `SUPERVISOR_STEER_TARGET_ALIAS`。
2. `:1399-1402`：检查 `id`/`runId` 是否为非空字符串。
3. `:1404-1406`：二者同时存在且不相等，返回 `SUPERVISOR_STEER_TARGET_CONFLICT`。
4. `:1407-1409`：选出完整 canonical id，拒绝无目标、绝对路径、分隔符和 `..`。
5. `:1410-1411`：拒绝长度 `[8,36)` 的上游前缀形态，返回 `SUPERVISOR_STEER_TARGET_AMBIGUOUS`。

resolver 结束后，`executeControl` 才在 `extension.ts:1482-1495` 检查 `index` 并读取 supervisor identity。也就是说 `dir` 早于所有 owner、runtime 和 child 校验。

### A

原始参数含：

- `dir:/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/3a723f51-2504-42fd-814c-cf3ff3e43f9a`
- `id:3a723f51-2504-42fd-814c-f3ff3e43f9a`（相对完整 `runId` 少一个 `c`）
- `runId:3a723f51-2504-42fd-814c-cf3ff3e43f9a`
- `index:0`
- 非空 `message`

首个拒绝点：`extension.ts:1398`，因为 `dir` 存在。返回 `SUPERVISOR_STEER_TARGET_ALIAS: Supervisor control request blocked.` 的文本拼接点是 `extension.ts:1416-1421`。

因此 A 的 `id` 拼写差异没有被实际评估；它不会先得到 `SUPERVISOR_STEER_TARGET_CONFLICT`，因为 `dir` 门禁先返回。A 没有到达 `extension.ts:1495` 的 `identityForRun`、`:1513` 的 `resolveSupervisorControl` 或 `:1524` 的 `rpc.steer`，也没有进入上游队列。A 的直接结论是：**dir 误传导致的 by design 拒绝；id/runId 不一致是另一个潜在拒绝条件，但不是本次首个条件。**

### B

原始参数含：

- `dir:/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/09ef9c1b-4e39-4d24-98dc-a6a21b8a16d1`
- `id:09ef9c1b-4e39-4d24-98dc-a6a21b8a16d1`
- `runId:09ef9c1b-4e39-4d24-98dc-a6a21b8a16d1`
- `index:0`
- 非空 `message`
- 现场状态：run 当时 `running`，process terminal `pending`

首个拒绝点同样是 `extension.ts:1398` 的 `dir` 门禁。由于 `id` 与 `runId` 完整相同，若没有 `dir`，它们不会触发 `:1406` 冲突；但本次实际参数仍在 `:1398` 结束。B 也没有进入 owner/runtime/gate/RPC/queue。`running` 与 process terminal pending 只属于后续 live-run/过程事实，无法改变首个拒绝点。B 的直接结论是：**dir 误传导致的 by design 拒绝；不是 busy 排队失败。**

A、B 的返回文本相同，是 `controlFailure` 的统一外层文案（`extension.ts:1416-1421`）；不能只凭 `Supervisor control request blocked` 判断具体门禁，必须读取 `details.code`。本两例的 code 都是 `SUPERVISOR_STEER_TARGET_ALIAS`。

## 2. 合法 steer 的参数形状与完整生产调用链

受控独立工具的最小合法形状是：

```json
{
  "runId": "完整 36 字符 UUID",
  "index": 0,
  "message": "非空 steer 消息"
}
```

也可以使用单一完整 `id` 替代 `runId`：

```json
{
  "id": "完整 36 字符 UUID",
  "index": 0,
  "message": "非空 steer 消息"
}
```

不应同时传 `id` 和 `runId`；若同时传，必须逐字相同，否则 `extension.ts:1406` 返回 `SUPERVISOR_STEER_TARGET_CONFLICT`。合法 steer 不含 `dir`，不使用 8–35 字符前缀，`index` 必须是安全非负整数；单 child 也必须显式写 `index:0`，见 `extension.ts:1485-1494` 与 `operation-tools.ts:247-250`。

完整链路如下：

1. `pi.registerTool` 注册 `subagent_run_steer`：`extension.ts:2009-2015,2032`。
2. operation factory 白名单过滤并注入固定 `action:"steer"`：`operation-tools.ts:245-258`。
3. typed dispatcher 识别 `action` 并进入 `executeControl`：`extension.ts:1947-1950,1447`。
4. `canonicalSteerTarget` 规范化唯一目标并拒绝 alias/path/prefix/conflict：`extension.ts:1396-1412,1482-1484`。
5. 缺 index 或非法 index 先拒绝：`extension.ts:1485-1494`。
6. 读取身份：`extension.ts:1495-1503`。Host 注入的 runtime identity 来自 `extensions/subagent-runtime.ts:273-279`，`runtimeFromStatus` 将状态转换为 `running`、`steerable`、`liveRunEpoch` 等事实，见 `src/subagent-dispatch/runtime-state.ts:13-25`。
7. owner 三态与 generation 校验由 `supervisor-control-plane.ts:288-295` 执行。`owned` 必须匹配 root/owner generation；无法确认不降级为 unowned。
8. steer live 条件由 `supervisor-control-plane.ts:297-302` 执行：必须有 child index，runtime `running` 为真、`steerable===true`，并且若带 epoch 则必须匹配。否则返回 `SUPERVISOR_STEER_NOT_ALLOWED`。该条件表达“当前可受控投递”，不表达“必须 idle”。
9. 受控 run 的 pending supervisor request、child scope、reply gate、重复正文和幂等检查在 `supervisor-control-plane.ts:314-331`。有未解决的同 child supervisor request 时才由 `gateBlocksChildSteer` 导出 `SUPERVISOR_REPLY_REQUIRED`（`:318-321`）；这与 busy 是不同事实。
10. gate 允许后才调用 `rpc.steer(params)`：`extension.ts:1521-1524`。原生 RPC 返回 `isError` 或抛错时走失败补偿 `:1525-1538`；只有 RPC 成功并且 `commitDelivery` 成功，才返回本仓受控投递回执（`:1531-1534`）。
11. RPC 0.80.0 的参数整理仍接受 `id`、`runId` 或 `dir` 任一定位，见上游 `src/extension/rpc.js:408-423`；这正是本仓需要在受控 steer 之前禁止 `dir` 的原因：上游可以用目录 basename 解析真实 run，而本仓 owner 授权必须绑定同一个可证明的 canonical run id。

### busy/live 语义

本仓静态可证明的事实是：supervisor gate 的 runtime 条件是 `running && steerable`，见 `supervisor-control-plane.ts:299-302`；代码没有 `busy === false`、idle、process terminal 已完成或“当前没有模型 turn”这样的前置条件。`runtimeFromStatus` 也把 `state === "running"` 转成 `running:true`，并在没有显式 `details.steerable` 时以 running 作为默认 steerable，见 `runtime-state.ts:13-25`。因此“run 正在运行”本身不会导致 `SUPERVISOR_STEER_NOT_ALLOWED`；真正需要现场状态的是 `running`、`steerable`、`liveRunEpoch` 是否在本次调用时一致。

上游 0.80.0 的正常队列链也明确支持忙态：

- `async-steering-action.js:67-91` 只在 run 不是 `running`/`queued` 时拒绝普通 steer；`running` 和 `queued` 均可继续。
- `async-steering-action.js:133-170` 计算目标 child 后调用 `requestAsyncSteer`，并把文件写入队列；目标为 pending child 时可直接返回 scheduled/queued。
- `control-channel.js:208-241` 的 `requestAsyncSteer` 写入 `control/steer-requests`，有关闭门、消息大小、目标 index 和队列文件校验；它不检查“当前模型 turn 是否空闲”。
- `control-channel.js:260-305` 按文件名读取、解析、删除并按 timestamp/FIFO 顺序返回 steer 请求。
- `control-channel.js:448-552` 安装 `fs.watch` 或轮询，发现文件后调用 `onSteer`；消费发生在 runner 端，而不是本仓 supervisor gate。
- `run-child-session.js:591-613` 将请求格式化为“Mid-run steering”或“Queued follow-up”，分别调用 child session 的 `created.steer(text)` 或 `created.followUp(text)`；上游返回的状态是 `queued`，不宣称已经消费。

因此可静态证明：**通过所有目标和授权门禁后，busy 只会影响 queue file 被 runner 何时消费以及最终 receipt 的 queued/delivered 时序；不会在本次 A/B 的 alias 门禁之前产生拒绝。**

静态不能证明的部分包括：某个真实 run 在精确调用瞬间的 `steerable` 值、runner 是否仍存活、文件 watcher/轮询的实际延迟、Pi child session 何时把 queued message 处理到下一个安全点，以及最终 child 是否消费并写入对应状态。用户给出的 B 的 `running`/process terminal pending 只能证明当时记录的现场状态，不能证明一个未发出的 A/B steer 曾到达队列，更不能证明消费结果。

## 3. `SUPERVISOR_REPLY_REQUIRED` 与 busy 排队的边界

`SUPERVISOR_REPLY_REQUIRED` 是控制面基于 supervisor request 的授权 gate，不是上游 busy code：

- `supervisor-control-plane.ts:314-321` 只扫描同 root/run/owner generation 的 `pending` 或 `replying` request。
- `classifyRequest` 后，scope 无法验证返回 `SUPERVISOR_REQUEST_SCOPE_UNVERIFIED`；只有 `gateBlocksChildSteer` 判定目标 child 仍需回复时才返回 `SUPERVISOR_REPLY_REQUIRED`。
- reply 已提交但仅为 `queued` 时，策略层把它区分为 `reply-submitted`；queued 与 consumed 是两个事实，不能把 queued 当作已消费。该语义在 `supervisor-gate-policy.ts:435-440` 的注释和 `supervisor-control-plane.ts:338-371` 的 receipt 处理保持一致。
- supervisor gate 拒绝发生在 `rpc.steer` 之前，因而不会产生 steer queue file；这与“RPC 已成功、队列等待消费”完全不同。

因此，如果以后对**不含 dir**的合法完整目标调用得到 `SUPERVISOR_REPLY_REQUIRED`，首个拒绝应归因于未完成 supervisor reply/child scope gate，不能归因于忙。若得到 `SUPERVISOR_STEER_NOT_ALLOWED`，应检查 live/steerable/epoch。只有代码走到 `rpc.steer` 并返回成功，才可以讨论上游 queue 与消费时机。

## 4. 为什么 `dir` 是有意拒绝，且不是回归

历史提交 `449994179ec13b91acaa6f9db7f879147b34bd2e`（标题“fix(subagent): 封堵 steer 控制面目标别名绕过”）明确记录：此前本层按错误优先级和 owner 查询语义，可能授权一个目标、再由上游通过 `dir`、前缀或另一字段投递到另一个真实 run，形成 P0 授权绕过。该提交新增 `canonicalSteerTarget`，把以下形态全部 fail closed：

- `dir` → `SUPERVISOR_STEER_TARGET_ALIAS`；
- `id`/`runId` 冲突 → `SUPERVISOR_STEER_TARGET_CONFLICT`；
- 路径形态 → `SUPERVISOR_STEER_TARGET_INVALID`；
- 8–35 字符前缀 → `SUPERVISOR_STEER_TARGET_AMBIGUOUS`；
- 无目标 → `SUPERVISOR_STEER_TARGET_UNRESOLVED`。

同一历史记录还把 owner 查询改为 `owned | unowned | unavailable` 三态，避免把 broker 读取失败误判为明确无 owner；当前实现对应 `supervisor-control-plane.ts:165-175,236-260` 和 `extension.ts:1495-1506`。这说明拒绝 `dir` 不是临时针对某个会话的补丁，而是为确保“授权目标”和“上游投递目标”一致而设计的控制面边界。

`git blame` 也显示：`extension.ts:1396-1412` 的 canonical resolver来自上述 `4499941`；`operation-tools.ts:245-258` 的独立工具初始提交 `e61cb85` 保留了共享 `dir` 字段；`cd06cf9` 后又把 `index` 的公开合同与执行期同步。当前工具描述在 `operation-tools.ts:247-250` 已明确说明 `dir` 只在 status/interrupt/stop 等其他路径不受该 steer 门禁影响。故“schema 仍接受 optional dir”应理解为共享字段/兼容面残留，配合运行时 fail-closed 与描述中的拒绝说明；没有证据支持增加 fallback 或把 `dir` 重新放行。

上游定位逻辑本身证明该 alias 有真实解析能力：

- `async-resume.js:160-171` 先按 `id ?? runId` 得到 requested id；若有 `dir`，将目录解析为 async run location，并以 `path.basename(asyncDir)` 作为 resolved id。
- `async-resume.js:175-196` 对不存在的完整路径还支持 `[8,36)` 前缀扫描；`run-id-query.js:1-6` 定义最短安全前缀 8 和完整长度 36。

所以将 `dir` 直接传进受控 `rpc.steer` 会让控制面无法只凭 `runId` 做 owner/correlation 授权，而上游仍可能从目录得到真实 run；拒绝是安全设计需要。

## 5. 本次失败的使用错误、改道边界与处理建议

A 的调用同时带了 `dir`、错误的 `id` 和完整 `runId`；B 虽然 `id`/`runId` 正确一致，仍带了 `dir`。两者都违反了当前独立 steer 工具明确的定位合同。主代理此前把上游 status/read 等操作支持的 `dir` 误带到 steer，混淆了“能定位 run”与“能证明 supervisor 授权目标”两种语义；这属于调用方参数使用错误/接口易错点，不能据此判定 busy queue 回归。

被控制面拒绝的请求不能改道重试。具体边界是：

- 不把 `dir` 删除后自动重发；
- 不把错误 `id` 改成 `runId` 后自动重发；
- 不把缺少或不确定的 `index` 猜成 0；
- 不把 `SUPERVISOR_REPLY_REQUIRED` 改走上游直通；
- 不把 `SUPERVISOR_OWNER_UNAVAILABLE`、`SUPERVISOR_STALE_OWNER` 或 `SUPERVISOR_STEER_NOT_ALLOWED` 当作 busy 而循环重试；
- 不发 steer/stop/interrupt/resume 做现场验证或恢复。

对于用户明确要求的后续合法调用，调用方应先取得 status 中权威的完整 run id 和 child index，再由用户/上层显式决定是否重新发起一个**不含 dir、单一完整 id/runId、含 index:0、含非空 message**的 steer。该动作属于新的显式控制请求，不是本报告自动执行的 fallback。

## 6. 生产 bug 分类与证据限制

本次 A/B 没有发现 production bug。按仓库缺陷数据来源门禁分类：

- 实际入口：`subagent_run_steer` → operation factory → typed `executeControl` → `canonicalSteerTarget`。
- 权威身份：本仓 canonical full run id、supervisor owner receipt/root/owner generation、runtime `running/steerable/liveRunEpoch`；本次在 canonical 早期门禁前尚未读取这些身份事实。
- 首个偏离点：两例均为 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1398` 的 `dir` alias 拒绝。
- 完整后续链：因 `:1398` 返回，未到 `extension.ts:1495` identity、`:1513` gate、`:1524` upstream RPC、上游 `async-steering-action.js:148` queue write、`control-channel.js:544-546` consume、`run-child-session.js:591-605` child session queue。
- 数据来源：A/B 是用户提供的生产工具失败记录；报告不重新发送、不通过 fixture 复现、不以测试失败替代生产证据。

证据限制：没有真实运行实验，所以不能对 B 的某个具体 live epoch、runner watcher latency、Pi agent loop 安全点或 child 最终消费给出个案结论。当前能确定的是参数门禁和静态调用顺序；不能据此宣称某次合法无-dir steer 一定已经入队或一定被消费。若未来出现“不含 dir、完整 id/runId、index:0 的调用在所有前置 gate 通过后仍未入队”的真实生产记录，必须记录其具体 RPC 返回、`details.code`、queue 文件/steering receipt、runner 状态和 child consumption provenance，再按首个偏离点分类；不能预防性放宽当前 gate。

## 7. 相关源码、文档与历史

- `packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:245-258`：独立 steer 注册 descriptor、字段白名单、当前描述。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1396-1412`：canonical target resolver；`:1416-1421`：统一 blocked 文案；`:1482-1538`：index、owner、gate、RPC、receipt 顺序；`:2009-2033`：工具创建与注册。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts:288-333`：owner、live、child index、reply gate、幂等和 scope 校验。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/runtime-state.ts:13-25`：status 到 `running/steerable/liveRunEpoch` 的转换。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:247-279`：control plane 创建与 runtime reader 注入。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.js:408-423`：上游 RPC steer 参数映射，仍接受 `id/runId/dir`。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-resume.js:160-196`：上游 `dir` 定位、完整 id 与前缀解析。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/async-steering-action.js:67-170`：running/queued 条件与 queue 写入。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/control-channel.js:137-163,208-241,260-305,448-552`：steer request 合法性、写入、消费、watch/poll。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/run-child-session.js:591-613`：child session 的 steer/followUp 消费入口。
- `docs/bugs/2026-09-30-steer-control-plane-target-aliasing.md`：历史 P0 alias 绕过修复与 fail-closed 设计。
- `docs/architecture/supervisor-gate-recovery.md`：owner、live epoch、child index、queued/consumed 边界。
- `docs/plans/records/2026-10-17-runtime-convergence/steer-locator-contract.md`：当前定位矩阵、index 合同与“不改道”边界。
- git history：`4499941`（canonical alias gate 与 owner 三态修复）、`e61cb85`（独立 operation tools 初始注册，保留共享 dir 字段）、`08ae9ca`（child-scoped gate 与 queued receipt 处理）、`cd06cf9`（steer index 合同同步）。
