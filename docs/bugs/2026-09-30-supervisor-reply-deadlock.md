# Supervisor reply 死锁：native pending 可见但 enhanced reply 被拒

- 发现日期：2026-09-30
- 源码基线：`4bea6b5`。分析期间 HEAD 前进到 `39731e1`（parent 并发提交），经 `git diff --name-only 4bea6b5..39731e1` 核实该提交仅改 `HANDOFF.md`（+29/−8），对 `supervisor-control-plane.ts`、`subagent-dispatch/extension.ts`、`extensions/subagent-runtime.ts`、`test/pi-subagents-runtime.integration.mjs` 零改动（对应 `git diff --stat` 为空），故本文源码结论对当前 HEAD 同样成立。
- 严重级别：P1（合法的 attention 请求无法通过 reply 解锁；需 interrupt + resume，影响人工编排连续性）。
- 数据来源分类：**类别 1——预期 production 数据未被正确处理**。分类依据见本文“数据来源分类”以及 `var/upgrade/supervisor-reply-deadlock-live-evidence.md`。
- 登记 owner：`pi-subagents-enhanced` runtime/control-plane 维护者（负责 enhanced ingress、supervisor control-plane 与其 upstream 0.71 接线的 owner）。
- issue：`SUPERVISOR-REPLY-DEADLOCK-2026-09-30`（本缺陷单；与集成门禁排除项独立登记）。
- 到期时间：2026-10-07 前完成修复方案评审和固定 Host 复现证据；在此前不得把 attention 双测排除项写成“已通过”。
- 恢复门禁：`test/pi-subagents-runtime.integration.mjs` attention 两测在固定 repo-local Pi 0.87.1 Host 下连续转绿，且 `scripts/run-integration-gate.ts` 的该文件条目被移除；同时需保留 reply、pending、steer 和 interrupt→resume 的身份/事件证据。

## 现象

真实生产编排中，child 通过 `contact_supervisor` 请求决定后，parent 的 pending 展示明确列出请求并给出相同 request id 的 reply 指令，但 reply 返回 `SUPERVISOR_REQUEST_NOT_PENDING`。随后对同一 run 的 steer 又被运行时告知该 run “blocked on a pending supervisor ask”，要求先 reply；唯一有效恢复路径是 interrupt 后 resume。

### `bf27eaf2` 现场

`var/upgrade/t11c-matrix.md:54-66` 记录了升级后真实 Host 会话：interrupt 进入 `Paused`，resume 以新指令恢复；同一现场的 supervisor reply 请求“在 pending 列表显示，reply 被拒 `SUPERVISOR_REQUEST_NOT_PENDING`，steer 亦被拒；interrupt+resume 解锁”。这是历史生产现场的第一例。

### 追加的一手生产复现

`var/upgrade/supervisor-reply-deadlock-live-evidence.md` 记录主会话真实 typed 入口的完整序列：

- request id：`b4be7931-eb1d-4b85-8cf0-8ac87d8cc6ec`
- 裸 run id：`5805c9b7-6b06-4e68-9b56-963c6a52e502`
- child index：`0`，agent：`delegate`
- `subagent_supervisor({action:"pending"})` 列出该 request，并指示用同一 id reply；
- 使用该 id reply 连续两次都返回 `SUPERVISOR_REQUEST_NOT_PENDING`；
- `subagent({action:"steer", id:<run>, index:0, ...})` 被运行时以 pending ask 阻止，并再次要求该 request id reply；
- `interrupt` 后 `resume` 解锁，复活为新 run `418fab59-062e-4ca9-964a-880b38aa23c2`。

### 第二个独立现场

同一真实编排会话随后向本分析 run（`703164c3-52f9-4b73-8209-4bb38018f324`）的 request `9da79cf0-2108-4d48-8cca-6e76519f31ac` 发 reply，同样返回 `SUPERVISOR_REQUEST_NOT_PENDING`；再对该 run steer，同样得到运行时层“blocked on a pending supervisor ask … Reply explicitly”并被迫使用 `interrupt + resume` 送达。本现场与上例拥有不同 run/request、不同子任务实例，但同一错误码、同一三平面矛盾和同一解锁路径，构成第二次真实编排复现。该事件顺序由原始 session file `var/sessions/2026-09-29T07-10-29-963Z_01a0ec00-2e4b-741f-949e-770a35da3ca1/6b3fa223-3f8b-416b-85be-44033ad231ab/run-0/session.jsonl` 保存；本次未读取或输出任何凭据类字段。

因此这不是单纯的测试超时或标题矩阵：展示、授权、运行时三层对同一合法请求给出了互斥状态，并已在至少两个独立真实编排 run 中复现。

## 根因与首个偏离点

### 首个偏离点（精确位置）

**首个可观察偏离点是 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1212-1213`：** reply adapter 从本仓 control-plane 的 `findRequest(params.replyTo)` / `listPending()` 查找不到 local request，直接返回 `SUPERVISOR_REQUEST_NOT_PENDING`。它发生在 `supervisor-control-plane.ts:96` 的 `findPending` 元组比较之前；因此不能把本现场错误地归因成“`findPending` 中某个字符串比较把 `runId` 的 `#0` 拼错”。

为什么列表仍可见：upstream native channel 自己维护 request 文件和 `pending` Map。其 `native-supervisor-channel.js:661-710` 先把合法 request 加入 upstream pending，再向 parent 发送 `subagent_supervisor_request`。本仓 `message_end` ingress 在 `extension.ts:1569-1574` 尝试登记，但 `:1573` 的 `.catch(() => undefined)` 静默吞掉 `registerSupervisorRequest` 失败；于是 upstream 展示 Map 仍有请求，本仓授权 Map 没有请求。

### 三个身份平面

#### 1. 展示平面

upstream `pi-subagents@0.71.0` native channel：

- 权威 owner：`request.orchestratorSessionId === state.supervisorOwnerSessionId`，`native-supervisor-channel.js:325-327`；
- request lifecycle：请求文件存在、reply 文件不存在、未过期、所属 run 仍有效，`native-supervisor-channel.js:392-403`；
- pending 注册：`native-supervisor-channel.js:663-689`；
- 用户输出：`native-supervisor-channel.js:513-529`；
- 展示元组：`id/runId/agent/childIndex/reason/expectsReply`，`native-supervisor-channel.js:503-511`；
- 文本的 `runId#0` 由 `native-supervisor-channel.js:420-422` 生成，`#0` 是 child index，不是 request.runId 的一部分。

#### 2. 授权平面

本仓 `createSupervisorControlPlane`：

- 登记从 owner receipt 取 `rootSessionId`、`ownerGeneration`，并从 native details 取 `requestId`、`runId`、`requestGeneration`，`supervisor-control-plane.ts:85-94`；
- `findPending` 完整要求：`state==="pending"` + `runId` + `rootSessionId` + `ownerGeneration` + `requestId` + `requestGeneration` 全等，`supervisor-control-plane.ts:96`；
- reply intent 在 local request 存在时从该 record 取 `runId/rootSessionId/ownerGeneration/requestGeneration`，`extension.ts:1214-1218`；
- local record 不存在时先在 `extension.ts:1212-1213` 返回 `SUPERVISOR_REQUEST_NOT_PENDING`。

展示平面未呈现 `rootSessionId/ownerGeneration/requestGeneration`，而授权平面强制要求它们；这是身份域不一致。当前源码和现场没有足够脱敏 tuple 证明 owner generation 或 root session 本身已经漂移，故不虚构该字段的实值错配。可确定的具体偏离是“upstream request 已 pending、local authorized request 缺失”，位置为 `extension.ts:1212`。

#### 3. 运行时/传输平面

upstream executor 在 `pi-subagents` `extension/index.js:571-598` 接收 `supervisorChannel.findPendingAsks`。`runs/foreground/async-steering-action.js:31-45` 在 steer 前从 async status 取裸 `snapshot.runId`、step agent、`childIndex:0`，调用 `findPendingAsks`；native channel `native-supervisor-channel.js:806-824` 按 `(runId, agent, childIndex)` 定位 channel request 文件及 pending lifecycle。命中后它返回 `async-steering-action.js:42` 的 “blocked on a pending supervisor ask” 文案，并要求原 request id reply。

这个运行时平面不读本仓 control-plane `requests` Map，也不要求 `rootSessionId/ownerGeneration/requestGeneration`。所以它与展示平面都能看到 native ask，而授权平面找不到可 reply 的 local request，形成闭环死锁。

## 完整生成调用链

1. child 注册的 `contact_supervisor` 位于 upstream `native-supervisor-channel.js:178-190`；调用 `sendSupervisorRequest`（`:107-139`）生成 UUID request id，按 child metadata 写 request 文件。`runId` 是裸 run id，`agent` 与 `childIndex` 来自同一份 metadata。
2. parent native channel 的 `poll`（`native-supervisor-channel.js:661-689`）读 request 文件，检查 owner session 和 native lifecycle，将请求加入 upstream `pending` Map。
3. 展示消息由 `native-supervisor-channel.js:693-710` 的 `pi.sendMessage` 发出，`customType` 为 `subagent_supervisor_request`，details 含 `id/requestId/runId/agent/childIndex/replyHint`。
4. enhanced `message_end` ingress 在 `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1569-1574` 接收该消息，并在 `:1573` 调 `registerSupervisorRequest`；登记在 `supervisor-control-plane.ts:85-94` 读取 owner receipt 并构造本地 request。登记失败被吞掉。
5. 用户调用 pending 时，upstream `buildParentSupervisorTool` 在 `native-supervisor-channel.js:513-529` 从自己的 Map 输出；该输出不证明本仓授权 Map 有记录。
6. 用户调用 reply 时，`runtime-membrane.ts:225-233` 捕获 `subagent_supervisor` tool；controlled adapter `extension.ts:1210-1220` 用 replyTo 查 local request。缺失即 `extension.ts:1212-1213` 返回 `SUPERVISOR_REQUEST_NOT_PENDING`；命中才会进入 `resolveSupervisorControl`。
7. 用户改用 steer 时，upstream `async-steering-action.js:31-45` 仍通过 native `findPendingAsks` 看见 request，于是拒绝 steer，要求原 id reply。三平面因此互相矛盾。
8. interrupt 打断旧等待 turn；resume 以新消息恢复新 run。`bf27eaf2` 与一手现场都观察到该动作解锁。它绕过旧等待状态，不证明旧 request 的授权判定已经一致。

## 4499941 三态改动的影响

当前 HEAD 的 `4499941` 内容必须按当前代码理解：

- `supervisor-control-plane.ts:70-83` 新增 `readOwnerState` 三态：成功 receipt 为 `owned`，成功无 receipt或权威 `unknown_run` 为 `unowned`，其它异常/依赖缺失为 `unavailable`；
- `extensions/subagent-runtime.ts:317-329` broker 未 ready 抛 `code="authority_store_unavailable"`，读取异常不再吞掉；
- `registerSupervisorRequest` 在 unavailable 下没有 owner receipt，会得到 `SUPERVISOR_OWNER_UNAVAILABLE`（`:87-94`），但 ingress `extension.ts:1573` 把结果吞掉，因此 upstream pending 仍可显示而 local Map 不产生记录；
- `resolveSupervisorControl` 仍在 `supervisor-control-plane.ts:100-101` 对 owner/root/generation/runtime 做统一 guard。若 local record 已存在但 owner 读取失败，仍表现为 `SUPERVISOR_STALE_OWNER`，不会自动变成 `SUPERVISOR_REQUEST_NOT_PENDING`；
- 因而三态改动**没有改变本死锁的总体表现**：列表仍可见、reply 仍可能 NOT_PENDING、steer 仍被 pending ask 阻止；它改变的是 owner 读取失败时的 fail-closed 语义。
- 具体改变发生在主动 steer 路径：旧代码可把无 owner receipt 当作透传；当前 `identityForRun` 返回 `ownerState: "unavailable"`，`extension.ts:1172-1183` 返回 `SUPERVISOR_OWNER_UNAVAILABLE`，只有权威 `unknown_run` 的 `unowned` 才透传。现场 steer 文案来自 upstream `async-steering-action.js:42`，不是新增的 `SUPERVISOR_OWNER_UNAVAILABLE`，所以不应把本死锁归因给 4499941，也不应称其修复了死锁。

## 版本错配排除项登记

`test/pi-subagents-runtime.integration.mjs` attention 双测不是进程内 Host：

- 测试文件在 `:65-115` 定义 `runRpcUntil`，内部用 `spawn(command,args)`；
- `runScenario` 在 `:370-395` 将 `piBinary`（`:15` 的 `process.env.PI_REAL_BIN`）作为 command 传入；
- 参数 `:373-378` 明确启动外部 `PI_REAL_BIN`，再用 `-e` 加载 provider、enhanced `subagent-runtime.ts` 与测试 probe；
- 本仓 package 依赖 `package.json:31-34` 是 Pi 0.87.1，upstream enhanced package 的 `pi-subagents` 是 0.71.0；
- 权威环境事实为 `/opt/homebrew/bin/pi --version` = `0.85.1`，绝对路径 global package = `0.85.1`，repo-local `./node_modules/.bin/pi --version` = `0.87.1`。所以 `PI_REAL_BIN=/opt/homebrew/bin/pi` 时，attention 双测存在同 session-owner PTY 一样的 Host/扩展版本错配；**版本错配假设尚未排除，不能把 attention 双测本身当作纯进程内 production defect 证明**。
- PTY 对照链为 `session-owner-runtime.integration.mjs` fixture 的 `PI_REAL_BIN=/opt/homebrew/bin/pi`，`scripts/pi-launcher.zsh:7-14` 解析该绝对路径、`:92` 用其加载本仓 `pi/extensions/session-owner.ts`；attention 测试同样是外部 Host，但没有把 `PI_REAL_BIN` 固定成 repo-local 0.87.1。

待补的排除证据是：以绝对路径记录两种 Pi 版本、实际 extension resolved path，使用 repo-local 0.87.1 Host 在隔离环境重跑 attention 两测并保存 stderr/退出结果。本文没有运行该测试，遵守“禁止运行任何测试”约束。

## 数据来源分类

**类别 1：预期 production 数据未被正确处理。**

证据覆盖门禁要求的四面：

- **实际入口：** 真实 child `contact_supervisor`，真实 parent `subagent_supervisor pending/reply` 和 `subagent steer` typed 工具；无手工 projection/event append。
- **权威身份：** 第一现场的 request id、裸 run id、agent、child index 和新旧 run id 均在 `var/upgrade/supervisor-reply-deadlock-live-evidence.md` 记录；pending 输出和 reply 指示使用同一 request id。第二现场的 request 为 `9da79cf0-2108-4d48-8cca-6e76519f31ac`，run 为 `703164c3-52f9-4b73-8209-4bb38018f324`，来自原始 session file。
- **事件与资源顺序：** 第一现场是 request 文件/展示 pending → reply 两次 NOT_PENDING → steer 被 pending ask 阻止 → interrupt → resume 新 run；第二现场是同一顺序（reply 被拒、steer 强制要求 reply、interrupt+resume 送达）。代码调用链和每一跳 file:line 见本文上节。
- **与 production 事实的差异：** upstream native authority 已确认合法 request pending，本仓授权 authority 没有形成对应 local record；不是缺字段 mock、过期 fixture、非法时间或绕过 public entry。历史 `bf27eaf2` 与追加一手现场均是实际生产编排会话。

attention 双测仍存在版本错配的独立验证限制，但该限制不推翻真实生产现场对缺陷可达性的 provenance；也不授权增加预防性兼容分支。

## 影响面与为何 interrupt + resume 解锁

会踩到的对象是：使用本仓 enhanced runtime、同时启用 upstream native `contact_supervisor` 和本仓 supervisor control-plane 的 parent/child 编排；请求登记失败（尤其 owner authority 暂不可读）时，native request 仍可进入展示和 runtime pending，而 local authorization record 缺失。

interrupt 会停止旧 async run 的等待 turn，并清理/冻结旧 runner 的等待上下文；resume 不是在旧 request 上继续做错误的 reply 匹配，而是发送新指令并创建/激活新 run（现场新 run 为 `418fab59-062e-4ca9-964a-880b38aa23c2`）。因此它绕开 native ask 与 local Map 的不一致状态，恢复可执行性；代价是原 request 没有走正常 reply 授权闭环，必须保留为缺陷现场。

## 修复方向（只给方向，不实现）

1. 让展示、运行时 pending 检查和 enhanced 授权共享一个 authority-backed request projection；至少关联 `requestId + runId + agent + childIndex`，并持久/可审计地保存 `rootSessionId + ownerGeneration + requestGeneration`。
2. 不在 `extension.ts:1573` 静默吞登记失败；登记不可用时返回稳定、可见且可重试的 authority 状态，或建立同 request id 的登记补偿，不让 upstream pending 单独继续伪装成可 reply。
3. 保持 `readOwnerState` 的 fail-closed 三态；不要添加“猜测 owner”或预防性兼容分支。修复应统一数据源，而非放宽 `findPending` 的身份条件。
4. 固定 repo-local 0.87.1 Host，补 attention 双测和 production-like supervisor trace；恢复条件满足前保持排除登记。

## 集成门禁排除项登记

- owner：`pi-subagents-enhanced` runtime/control-plane 维护者；测试门禁 owner 配合维护 `test/pi-subagents-runtime.integration.mjs`。
- issue：`SUPERVISOR-REPLY-DEADLOCK-2026-09-30`，与本缺陷单同号登记；不得继续仅以 `WIRED-ELSEWHERE` 概括。
- 到期：2026-10-07 前完成统一 projection 方案评审、固定 Host 复现和 attention 双测证据；若未完成，保持显式阻塞状态并更新 evidence。
- 恢复门禁：attention 双测在 repo-local 0.87.1 external Host 下通过；版本/extension identity 与完整事件顺序落盘；`test/pi-subagents-runtime.integration.mjs` 从 `scripts/run-integration-gate.ts:17-24` 排除表移除；完整 gate 重新纳入该文件后通过。仅有独立 `test:subagents` script 或 3/5 不满足恢复条件。

## 残余风险

- 本轮没有运行 attention 测试，不能声称其当前实际 exit 结果；版本错配排除仍待固定 Host 证据。
- 当前现场证明 local registration absent 与三平面分裂，但没有脱敏的 owner receipt/local register tuple，不能进一步宣称某个 `ownerGeneration` 数值必然漂移。
- 4499941 的三态改动保持 fail-closed，但仍允许 ingress 吞掉登记失败结果；这只是修复方向，不是本任务实现项。
