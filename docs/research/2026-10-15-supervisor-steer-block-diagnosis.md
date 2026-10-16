# `SUPERVISOR_REPLY_REQUIRED` 阻断 steer：静态触发链与门禁收敛诊断（2026-10-15）

## 0. 结论摘要

用户报告的现象是「有的会话 steer 无法投递，报错 `SUPERVISOR_REPLY_REQUIRED: Supervisor control request blocked.`」。本轮为**纯静态源码诊断**，无用户样本，因此**不给出个案根因**，只给出可判定的触发链、状态生命周期与候选分类。

1. 该错误文本在本仓只有**唯一**产生点：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1144-1150`（`controlFailure`）拼接 `supervisor-control-plane.ts:203` 返回的 code。全仓（含测试）只有 `supervisor-control-plane.ts:203` 一处产生 `SUPERVISOR_REPLY_REQUIRED`（`grep -rn` 结果：源码 1 处、测试断言 4 处）。
2. 触发条件精确为：`subagent({action:"steer", ...})` 命中受控分支，且本仓 durable 状态中存在**任一** `state==="pending"` 的 supervisor request，其 `runId + rootSessionId + ownerGeneration` 与本次 steer 目标一致。判定**不含 `requestId`、不含 `childIndex`、不含「是否已 reply」**（`supervisor-control-plane.ts:196-198, 203`）。
3. reply 成功后本仓 request **仍是 `pending`**：`commitDelivery` 默认只写 `status:"queued" / consumed:false`，并显式把 request 保持为 `pending`（`supervisor-control-plane.ts:229, 232`）。把它推进到 `replied` 的唯一生产路径是 `observeReplyConsumption`，而它只被 `reconcileSupervisorConsumption` 调用；后者只由 `subagent:process-terminal` 事件触发，且要求 run 的 terminal proof `state === 'observed'`（`extensions/subagent-runtime.ts:289-301`、`supervisor-consumption.ts:52-59, 99`）。
4. 因此「已 reply 但 child 仍在运行」期间，steer 一定被该码拒绝，直到 run 终局对账、或 durable request 20 分钟 TTL 在事务重载时被判过期（`supervisor-control-plane.ts:184, 106-108, 138-155`）。**这不是「永远」**：持久化模式下 TTL 给出确定上界；非持久化模式下 steer 分支的 TTL 判据不可达（`:203` 先于 `:205` 返回），才可能持续到终局。
5. 分类结论（详见 §4）：
   - **正常门禁**：child 确有未回复的 `need_decision` / `interview_request` 时拒绝 steer —— 与上游同类守卫方向一致（`pi-subagents@0.75.0` `src/runs/foreground/async-steering-action.js:31-46`）。
   - **待证候选（生产静态可达，非个案结论）**：reply 已提交且上游 ask 已 resolved 后，本仓门禁仍关闭到终局/TTL；上游 ask 10 分钟超时与本仓 20 分钟 TTL 错位；多 child run 的 run 级围栏拦截对另一 child 的 steer；Host 非正常关闭残留 pending。四者都**只静态可达**，缺少现场字段前不得当作用户个案根因。
   - **明确排除**：登记失败（`registrationFailures`）、owner 三态不可用、steer 目标别名/前缀、幂等重放、durable 锁竞争——它们产生**别的** code，不产生本码（§4.3）。
6. 诊断能力缺口（§5）：`subagent_supervisor` 的 `pending` / `status` 直接透传上游（`extension.ts:1266`），展示的是上游文件视图，**不能权威证明本仓门禁状态**；`controlFailure` 对本码只回 `details:{code}`，不含 `requestId/runId`；全部 supervisor 诊断条目都会被 trace sink 白名单丢弃（`extension.ts:122-131, 154-185`）。所以现场无法自证，必须按 §6 取最小样本。
7. 本轮**未修改任何 production/测试/门禁**，未运行测试或真实工具，未读真实 authority/state/session 正文，未执行 steer/reply/interrupt/resume/kill/notify/stage/commit。

## 1. 证据边界与方法

- 证据模式：`static`；来源分类：`unconfirmed`（无用户样本，无法证明个案首个偏离点）。
- 已读证据源：
  - `docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`
  - `docs/plans/records/2026-10-13-supervisor-provenance.md`、`docs/plans/records/2026-10-13-supervisor-disposition.md`
  - `docs/research/2026-10-14-trigger-rpc-supervisor-design-gaps.md`
  - `docs/bugs/2026-09-30-supervisor-reply-deadlock.md`、`docs/bugs/2026-10-05-supervisor-consumption-receipt.md`、`docs/bugs/2026-10-08-supervisor-durable-lock-release-race.md`
  - `packages/pi-subagents-enhanced/src/subagent-dispatch/{supervisor-control-plane,supervisor-consumption,supervisor-adapter,runtime-membrane,extension,durable-storage,runtime-state,supervisor-replay}.ts`
  - `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
  - 上游 `packages/pi-subagents-enhanced/node_modules/pi-subagents@0.75.0`：`src/intercom/native-supervisor-channel.js`、`src/runs/foreground/async-steering-action.js`、`src/runs/background/async-execution.js`
  - 既有公开测试（作为**实现合同**证据，不是产品语义正确性证明）：`test/subagent-runtime-membrane.test.mjs:1791-1822, 2076-2112`、`test/supervisor-consumption.test.mjs`、`test/joint-upgrade-contact-supervisor.integration.mjs:11, 28, 66-84`
- 未读/未做（按合同禁止）：`pi/settings.json`、`pi/models.json`、任何 auth/credential、真实 authority store、真实 durable `supervisor-control/*.json` 正文、真实 session jsonl 正文、`.pi/subagents/**` run 现场；未跑 test/typecheck/Host/provider/RPC/网络/npm；未 poll pending；未 stage/commit。
- 术语约定沿用 V1 记录：`submitted`（上游本侧调用接受）/ `queued`（本仓 receipt 默认）/ `delivered`+`consumed`（须可信对账）/ `gate-open`（durable pending 的派生判定，非持久字段）。
- `supervisor-replay.ts` 与本轮无关：它处理 durable event outbox 的 replay barrier，名字里的 “supervisor” 是消费者角色，不参与 request/steer 门禁（`supervisor-replay.ts:17-40`）。

## 2. 精确触发链与状态生命周期

### 2.1 错误文本与 details 投影

```text
extension.ts:1144-1150
function controlFailure(code, receipt = undefined) {
  content: `${code}: Supervisor control request blocked.`   // 与用户报错逐字一致
  isError: true
  details: { code, ...(receipt?.receiptId), ...(receipt?.requestId), ...(receipt?.runId) }
}
```

steer 分支调用为 `controlFailure(decision.code)`（`extension.ts:1236`），**不传 receipt**，故 `details` 只有 `{code}`：模型/用户看不到是哪个 request、属于哪个 childIndex、是否已 reply。这是本码「无法自证」的直接原因之一。

### 2.2 steer 的完整判定顺序（唯一产生本码的公开路径）

公开入口：`subagent({action:"steer", id|runId, index?, message})` → `extension.ts:1591-1613`（tool execute）→ `executeControl`（`extension.ts:1174`）。

| 顺序 | 判据 | 位置 | 失败 code |
| --- | --- | --- | --- |
| 1 | `action ∈ CONTROL_ACTIONS` | `extension.ts:1176-1178` | `UNSUPPORTED_ACTION` |
| 2 | steer 目标规范化：禁 `dir`；`id`/`runId` 冲突禁；长度 `[8,36)` 视为前缀歧义；禁绝对路径/分隔符/`..` | `extension.ts:1120-1142, 1210-1211` | `SUPERVISOR_STEER_TARGET_*` |
| 3 | 控制面启用（`enabled() === brokerReady && !!broker`） | `extension.ts:1209`、`subagent-runtime.ts:302-309` | 未启用则直接透传 `rpc.steer` |
| 4 | owner 三态：`owned` / `unowned`（仅 `unknown_run`）/ `unavailable`（其余一律 fail-closed） | `supervisor-control-plane.ts:157-172`、`extension.ts:1212-1222` | `SUPERVISOR_OWNER_UNAVAILABLE` |
| 5 | `unowned` 且本仓无该 run 的 request → **绕过控制面**，交上游投递 | `extension.ts:1216-1222` | —（上游自行判定） |
| 6 | intent 解析 + `loadRoot`（持久化模式下清空内存并按 TTL 重载） | `supervisor-control-plane.ts:188-190, 95-121, 138-155` | `SUPERVISOR_INTENT_INVALID` / `SUPERVISOR_PERSISTENCE_CORRUPT` |
| 7 | owner/runtime generation 围栏 | `supervisor-control-plane.ts:191-195` | `SUPERVISOR_STALE_OWNER` |
| 8 | **pending 搜索（run 级）**：`state==="pending" && runId && rootSessionId && ownerGeneration` | `supervisor-control-plane.ts:196-198` | — |
| 9 | 幂等 receipt 命中（steer key = `runId:ownerGeneration:payloadDigest:liveRunEpoch`） | `supervisor-control-plane.ts:199-202` | `SUPERVISOR_RECEIPT_IDENTITY_MISMATCH` / `SUPERVISOR_DELIVERY_IDEMPOTENT` |
| 10 | **`pending && kind==="steer"` → 本码** | `supervisor-control-plane.ts:203` | **`SUPERVISOR_REPLY_REQUIRED`** |
| 11 | TTL 过期判据（对 steer **不可达**，被第 10 步先返回） | `supervisor-control-plane.ts:205` | `SUPERVISOR_REQUEST_EXPIRED`（仅 reply 分支或内存模式） |
| 12 | runtime `running` / `steerable` / `liveRunEpoch` | `supervisor-control-plane.ts:206`、`runtime-state.ts:13-26` | `SUPERVISOR_STEER_NOT_ALLOWED` |
| 13 | steer 文本与已消费 reply 重复 | `supervisor-control-plane.ts:207, 233` | `STEER_DUPLICATES_REPLY` |
| 14 | 通过后 `rpc.steer(params)` → `commitDelivery`（steer receipt，默认 queued） | `extension.ts:1237-1246`、`supervisor-control-plane.ts:210-236` | 失败则补偿 `SUPERVISOR_STEER_DELIVERY_FAILED` |

**关键排序事实**：第 10 步先于第 11、12 步。因此

- run 已停止/已完成/不可 steer 时，只要还有一条 durable pending，用户看到的仍是 `SUPERVISOR_REPLY_REQUIRED`，**掩盖**了 `SUPERVISOR_STEER_NOT_ALLOWED`。既有测试把该优先级固化为实现合同：`test/subagent-runtime-membrane.test.mjs:2103-2106`（`readRuntime` 返回 `running:false`，reply 成功后 steer 仍断言 `SUPERVISOR_REPLY_REQUIRED`）。
- 第 9 步先于第 10 步：完全相同文本 + 相同 `liveRunEpoch` 的重复 steer 会得到 `SUPERVISOR_DELIVERY_IDEMPOTENT` 而非本码。反过来说，**看到本码即说明该 steer 文本（或 epoch）与既往成功 steer 不同**。

### 2.3 durable request 状态生命周期（唯一写入点）

```text
（无） ──registerSupervisorRequest──▶ pending            supervisor-control-plane.ts:173-186
                                      │  expiresAt = createdAt + 20min      :184
pending ──commitDelivery(reply, 默认)─▶ pending（不变）   :229, 232（receipt=queued, consumed=false）
pending ──commitDelivery(success:false)▶ failed           :232（steer/reply 投递失败补偿）
pending ──observeReplyConsumption─────▶ replied           :238-239, 261-273 → :216-223（幂等 queued receipt 一次性推进）或 :229, 232（receipt=delivered, consumed=true）
pending ──loadRoot（持久化重载 + TTL）─▶ expired           :106-108
pending ──expireTerminalRequests──────▶ expired | failed  :248-259（仅 reconcile 调用）
pending/replying ──closeRootRequests──▶ failed            :241-247（Host 正常 dispose）
```

补充事实：

- `replying` 在类型与 `closeRootRequests` 判据中出现，但**没有任何写入点**（全仓 grep 只有类型联合 `:4`、parse 白名单 `:39` 与 `:243`）。即：没有「reply 进行中」这一可见中间态，reply in-flight 与「尚未 reply」在门禁上不可区分。
- `replied` 只能由消费观察产生；`commitDelivery` 只有在入参 `consumed===true` 时才写 `delivered/replied`，而生产调用方 `extension.ts:1239, 1293` **都不传 consumed**。
- `expireTerminalRequests` 的唯一调用者是 `reconcileSupervisorConsumption`（`supervisor-consumption.ts:103-104`）：`timedOut` → `expired`；`status.state ∈ {stopped, failed}` → `failed`。成功完成但未被对账为消费的 request **不会**在此被清理，只能等 TTL 或 Host close。
- `closeRootRequests` 只在 `beforeRuntimeDispose` 中、且 `brokerReady && broker` 时执行（`subagent-runtime.ts:421-422`）。Host 崩溃/被 kill 时不会执行，pending 会残留在 durable 状态里（受 TTL 约束）。

### 2.4 消费对账（terminal-only）的判据强度

`reconcileSupervisorConsumption`（`supervisor-consumption.ts:52-105`）要求全部成立才推进 `consumed`：

1. broker 侧 terminal proof 存在、无 conflict、`proof.state === 'observed'`（`:54-59`）；
2. `status.json` 与 binding 的 `runId/pid/sessionId` 一致，且 `processTerminal.runnerProcessInstanceId/observedAt` 与 proof 一致（`:60-61`）；
3. `recovery-descriptor.json` 的 `sourceRunId/sessionFile/cwd` 一致（`:62-63`）；
4. session 文件在可信根内、前后两次 `checkedText` 一致、cwd 一致（`:64-73`）；
5. child 会话中存在 `contact_supervisor` 的**成功** toolResult，且 `details.requestId` 能在本仓找到 request，correlation 的 `sessionFile/childSessionId/toolCallId/reason/agent/requestBodyDigest` 全字段对齐，`request.createdAt ≤ message.timestamp ≤ proof.observedAt`（`:88-95`）；
6. toolResult 文本恰为单段且以 `**Reply from supervisor:**\n` 开头（`:97-98`，与上游 `native-supervisor-channel.js:157-160` 的返回文本同源）；
7. 以 reply 正文 digest 调 `observeReplyConsumption`，receipt 必须存在、kind=reply、身份/generation 全对齐且非 failed（`supervisor-control-plane.ts:261-273`）。

任一条不满足 → `continue` 或 `SUPERVISOR_CONSUMPTION_MISMATCH`，request 停在 `pending`。`subagent:process-terminal` 由上游在 runner 进程终局发出（`async-execution.js:374-383`），**run 级**而非 child 级；因此 mid-run 没有任何消费确认事件（与 `docs/research/2026-10-14-trigger-rpc-supervisor-design-gaps.md` §3 一致）。

## 3. reply queued 与 terminal-only 消费对 run 中 steer 的相互依赖

### 3.1 依赖链（逐跳可核）

```text
child contact_supervisor
  └─上游写 request 文件并阻塞等待（默认 10min）      native-supervisor-channel.js:15, 108-176
      └─上游 poll 发现 → pending.set → sendMessage(subagent_supervisor_request, triggerTurn:true)
                                                native-supervisor-channel.js:666-716（非 expectsReply 的 progress_update 在 :686-690 直接删文件、不通知父）
          └─本仓 message_end 登记 durable pending（含 correlation 捕获）
                                                extension.ts:1660-1686; subagent-runtime.ts:304-307; supervisor-consumption.ts:30-49
父 subagent_supervisor({action:"reply", replyTo})
  └─本仓 findRequestAsync → resolveSupervisorControl(reply) → 上游 execute
                                                extension.ts:1266-1296
      └─上游 writeReply：写 reply 文件 + **删除 request 文件** + pending.delete
                                                native-supervisor-channel.js:448-460, 536-545
  └─本仓 commitDelivery：receipt=queued, consumed=false；request **保持 pending**
                                                supervisor-control-plane.ts:229, 232
child waitForReply 命中 → toolResult 成功（`**Reply from supervisor:**`）
                                                native-supervisor-channel.js:93-107, 157-160
  └─本仓**无 mid-run 观察**；request 仍 pending
父 subagent({action:"steer", ...})（run 仍在运行）
  └─pending 搜索命中 → SUPERVISOR_REPLY_REQUIRED   supervisor-control-plane.ts:196-198, 203
run 终局 → subagent:process-terminal → reconcile → observeReplyConsumption → replied
                                                subagent-runtime.ts:289-301; supervisor-consumption.ts:99; supervisor-control-plane.ts:261-273
  └─此后 gate 打开，但 runtime.running=false → steer 变为 SUPERVISOR_STEER_NOT_ALLOWED / 上游 "not running or queued"
                                                supervisor-control-plane.ts:206; async-steering-action.js:66-72
```

**相互依赖的实质**：gate 开放依赖 `replied`，`replied` 依赖消费对账，消费对账依赖 run 终局 proof。所以在 run 存活期间，「reply 成功」这一事实**在本仓没有任何可推进 gate 的公开出口**。同时 steer 又是唯一能在 run 存活期注入指令的公开控制动作（`resume` 只对 paused/completed/failed 生效，`interrupt` 会中断当前 turn），于是形成「已回复 → 运行中 → 不能 steer」的功能性死角，直到 TTL 或终局。

### 3.2 窗口上界（不是「永远」）

| 解除路径 | 触发时机 | 位置 | 是否 mid-run 可用 |
| --- | --- | --- | --- |
| 消费对账 → `replied` | run 终局且 7 项判据全过 | `supervisor-consumption.ts:52-101` | 否（terminal-only） |
| TTL → `expired` | `createdAt + 20min` 后，任一控制面公开调用触发 `transaction → loadRoot` | `supervisor-control-plane.ts:184, 106-108, 138-155` | **是**（持久化模式） |
| reply 投递失败补偿 → `failed` | 上游 reply 抛错（如上游 pending 已空） | `extension.ts:1159-1172, 1297-1299`；`supervisor-control-plane.ts:229-232` | 是，但代价是一次失败调用 |
| terminal 清理 → `expired`/`failed` | reconcile 的 `timedOut` 或 `stopped/failed` 分支 | `supervisor-consumption.ts:103-104` | 否 |
| Host 正常关闭 → `failed` | `beforeRuntimeDispose` | `subagent-runtime.ts:421-422` | 否（且会结束会话） |

TTL 的可达性取决于 `persistenceRoot` 是否配置：`persistenceRoot = (PI_CODING_WORKSPACE_DIR || PI_CODING_AGENT_DIR) + "/supervisor-control"`（`subagent-runtime.ts:249-255`）。若两者都为空 → `storage === undefined` → `transaction` 直接执行、`loadRoot` 立即返回（`supervisor-control-plane.ts:95-96, 138-139`），TTL 只在 `:205` 判定，而该行对 steer 不可达 → 该环境下 steer 确实「到终局才可」。这是**环境相关的行为分叉**，属静态事实，未验证用户环境取值（本轮不读 env/settings）。

TTL 锚点是**本仓登记时刻**（`createdAt = now()`，`:184`），不是 reply 时刻，也不是上游 `createdAt`。所以「reply 之后还剩多久」= `20min −（登记到 steer 的经过时间）`，与 reply 时间无关。这一点必须写进任何面向用户的解释，否则会被误读为「回复后 20 分钟」。

### 3.3 与上游同类守卫的宽严对比（判定收敛缺口的核心证据）

上游 `steerAsyncRun` 自己也有「先 reply 再 steer」的守卫，但判据是**实时文件事实**：

```text
async-steering-action.js:31-46
  snapshot.mode === "single" && steps.length === 1 && (index === undefined || index === 0)
  && state ∈ {running, queued} && step.status ∈ {running, pending}
  && findPendingAsks({runId, agent, childIndex:0}).length > 0   → 拒绝 steer，并回显精确 reply 命令
findPendingAsks：只读 requests 目录，要求 request 文件存在、无 reply 文件、未过期、run 未 inactive
                                                native-supervisor-channel.js:811-828, 394-405
writeReply 会删除 request 文件                   native-supervisor-channel.js:448-460
child 等 reply 超时也会删除 request 文件并抛错      native-supervisor-channel.js:162-164, 100-107
```

对比结论：

| 维度 | 上游守卫 | 本仓 durable 门禁 |
| --- | --- | --- |
| 事实来源 | request/reply 文件（实时） | durable request.state（滞后） |
| reply 后是否自动解除 | **是**（request 文件已删 → `findPendingAsks` 返回空） | **否**（state 仍 pending） |
| 粒度 | 单 child（`mode==="single"`、`steps.length===1`、`childIndex:0`） | **run 级**（不含 childIndex） |
| ask 超时后 | 自动解除（`expiresAt` / `inactive` / `missing`） | 不解除，等 reconcile 或 20min TTL |
| 错误文案 | 列出精确 `replyTo` 与建议命令 | 只有 code，无 requestId/无「已回复未消费」区分 |

即：在「已 reply、child 仍在运行」窗口内，**上游会投递该 steer，本仓先行拒绝**。本仓门禁在该窗口是**严格更宽**（更保守）的一方，且拒绝理由（还有 pending 需要回复）在此时已与上游事实不符——上游侧并无待回复请求。这是可静态证明的**语义分叉**，也是本码最可能的过度收敛来源。

### 3.4 判定：合同内预期，还是生产可达的门禁收敛问题

分层回答，避免把设计取舍与缺陷混为一谈：

- **实现合同层面：一致、非回归。** 「reply 成功后 steer 仍 `SUPERVISOR_REPLY_REQUIRED`」被既有测试显式断言两次：`test/subagent-runtime-membrane.test.mjs:1811-1819`（reply 成功 `isError === undefined`、`nativeCalls === 1` → `duplicateSteer` 断言本码且 `rpc.steer` 调用数为 0）、`:2103-2106`（`running:false` 下仍断言本码）。同一单测亦断言「未消费时 request 保持 pending、receipt 保持 queued」：`:1848`（`plane.snapshot().requests[0].state === "pending"`，断言消息 “unconsumed delivery stays pending”）与 `:1857-1860`（只有显式 `commitDelivery({consumed:true})` 后 `listPending()` 才清零）。`docs/bugs/2026-10-10-...md` 已把它记为「产品限制」而非缺陷，`docs/plans/records/2026-10-13-supervisor-{provenance,disposition}.md` 维持 `blocked-evidence`。本轮源码核对**未发现**任何改变该合同的新迹象。
- **产品语义层面：属过度收敛（over-convergence），生产静态可达。** 门禁的声明目的是「防止用 steer 替代 supervisor 决策协议」（bug 文档「影响与限制」）。该目的在 reply 已提交、上游 request 文件已删除时**已经达成**；继续以「仍有 pending 需要回复」为由拒绝一个**内容不同**的 steer，超出了目的所需，且错误文案与 `pending` 视图（上游视角，已为空）互相矛盾。判据：§3.3 的宽严对比 + `:203` 不看 `receipt.status/consumed`、不看 `childIndex`、不看 upstream 是否仍有 ask。
- **缺陷分类层面：不是「数据非法/身份错误/fail-closed 判据错误」类缺陷。** 身份、时间、资源事实都合法：request 是本仓自己登记的，reply 是本仓自己提交的，pending 是本仓自己保持的。它也不是「测试制造的非法状态」。按根 `AGENTS.md` 的三分类，最接近**类别 1（预期 production 数据未被正确处理）中的「处理粒度/收敛时机不符合产品意图」**，但**首个偏离点未经现场证实**（缺 §6 样本），因此本轮仍记 `unconfirmed`，不得据此改门禁。
- **是否「永远到 terminal 才可」：否。** 持久化模式下上界为 `createdAt + 20min`（§3.2）；只有非持久化模式下 steer 分支 TTL 不可达，才成立「到终局才可」。任何面向用户的解释都必须带上这个上界与锚点，否则会给出错误的恢复预期。
- **修复归属：不在本轮，也不在本报告内实现。** 与 `docs/research/2026-10-14-trigger-rpc-supervisor-design-gaps.md` §3「可本地实施的后续设计」一致：真正解除需要 (a) 上游 mid-run 消费确认合同，或 (b) 本仓只读 provenance + 明确的「已提交未消费」门禁表达。二者都是 production 改动，须先做来源分类并另行审批；`docs/plans/2026-10-15-runtime-closeout.md:35` 已明确本批「不放宽 `SUPERVISOR_REPLY_REQUIRED`，不改变 TTL、terminal proof 或 owner 三态」。

## 4. 正常门禁 vs 待证候选（分类表）

### 4.1 明确正常（预期门禁，不需修复）

| 情形 | 判据 | 证据 |
| --- | --- | --- |
| child 确有未回复的 `need_decision` / `interview_request` | durable pending 存在且从未 reply | `supervisor-control-plane.ts:196-203`；上游同向守卫 `async-steering-action.js:31-46` |
| 同一 run 内还有**另一条**未回复请求（含 repeat-question / two-asks） | pending 搜索为 run 级 | `:196-198`；集成场景 `joint-upgrade-contact-supervisor.integration.mjs:11, 80` |
| 重复完全相同文本的 steer | 幂等 receipt 命中 → `SUPERVISOR_DELIVERY_IDEMPOTENT`（不是本码） | `:199-202`；`extension.ts:1235` |
| run 已终局/不可 steer | 本码**掩盖** `SUPERVISOR_STEER_NOT_ALLOWED`；即使放行也无法投递 | `:203` 先于 `:206`；`async-steering-action.js:66-72` |

### 4.2 待证候选（生产静态可达；不得当个案根因）

| # | 候选 | 静态可达性论证 | 边界/上界 | 需要的证伪或证实字段 |
| --- | --- | --- | --- | --- |
| C1 | **已 reply（queued）→ run 中 steer 被拒** | `:229, 232` 保持 pending；`:203` 不看 receipt；无 mid-run 消费出口（`subagent-runtime.ts:301`） | terminal 对账，或 `createdAt+20min` TTL | reply 返回码与时间戳、`replyTo` 的 requestId、steer 失败时间戳、durable `requests[].state` + `receipts[].{status,consumed}` |
| C2 | **上游 ask 已超时（默认 10min）但本仓 TTL（20min）未到** | 上游 `expiresAt = createdAt + askTimeout`（`native-supervisor-channel.js:15, 116, 394-405`）；child 超时会删 request 文件并抛 `Timed out waiting for supervisor reply.`（`:100-107, 162-164`）；本仓只有 reconcile 的 `timedOut` 分支或 TTL 能清（`supervisor-consumption.ts:86, 103`） | reconcile（需 terminal proof observed）或 20min TTL；或一次失败 reply 的补偿把 request 标 `failed`（`extension.ts:1159-1172`） | child `contact_supervisor` 是否返回 `Timed out`（用户可见的 isError + 文案枚举即可）、`PI_INTERCOM_ASK_TIMEOUT_MS` 数值、durable `createdAt/expiresAt/state` |
| C3 | **多 child run：child A 的 pending 拦截对 child B 的 steer** | pending 搜索不含 `childIndex`（`:196-198`）；上游守卫只在 `mode==="single" && steps.length===1` 生效（`async-steering-action.js:32-38`） | 同 C1/C2 | run 的 steps 数量、steer 的 `index` 参数、pending request 的 `childIndex`（枚举/整数，非正文） |
| C4 | **Host 非正常关闭残留 pending** | `closeRootRequests` 仅在正常 dispose 执行（`subagent-runtime.ts:421-422`）；durable 状态跨 Host 重载（`supervisor-control-plane.ts:95-121`） | 下一 Host 首次事务重载时按 TTL 判过期；或 ownerGeneration 变化使 pending 不再匹配（`:191-198`） | 是否发生过 crash/kill/强制退出、Host 重启时间、durable `ownerGeneration` 与当前 owner receipt generation（枚举/整数） |
| C5 | **消费对账判据未过 → run 终局后仍 pending** | `supervisor-consumption.ts:88-98` 的 7 项全字段判据任一不满足即 `continue`；成功完成的 run 不走 `expireTerminalRequests`（`:103-104` 只覆盖 timedOut/stopped/failed） | 20min TTL；此时 run 已终局，steer 本身也不可投递 | durable `receipts[].{status,consumed,code}`、run `status.state` 枚举、是否有 completion 通知 |

C1–C5 全部**只静态可达**：本轮没有任何现场字段，因此不宣称用户命中的是哪一个，也不排除「就是 4.1 的正常门禁」。「有的会话」这一表述与 C3/C4/C5（会话/Host 相关）以及 C1（长任务相关）都相容，无法据此收窄。

### 4.3 明确排除：不会产生本码的相邻失败（用于分诊）

| 相邻失败 | 实际 code | 位置 |
| --- | --- | --- |
| 登记失败（broker 未就绪、root 不匹配、correlation 捕获失败、`CALL_AMBIGUOUS`） | `subagent_supervisor_registration_failed` 消息 + reply 时 `SUPERVISOR_REQUEST_REGISTRATION_FAILED`；**steer 反而不被拦**（无 durable pending） | `extension.ts:1670-1683, 1273-1281`；`subagent-runtime.ts:304-307`；`supervisor-consumption.ts:30-49` |
| owner 读取不可用（broker 未就绪、非 `unknown_run` 的错误） | `SUPERVISOR_OWNER_UNAVAILABLE` | `supervisor-control-plane.ts:157-172`；`subagent-runtime.ts:256-274` |
| generation / rootSessionId 不一致 | `SUPERVISOR_STALE_OWNER` | `:191-195` |
| steer 目标为前缀/别名/带 `dir` | `SUPERVISOR_STEER_TARGET_{ALIAS,AMBIGUOUS,CONFLICT,INVALID,UNRESOLVED}` | `extension.ts:1120-1142` |
| durable 状态损坏 / 摘要不符 | `SUPERVISOR_PERSISTENCE_CORRUPT` | `:95-121` |
| 锁竞争 > 5s | `DURABLE_LOCK_HELD`（经 tool 外层 catch 变成 `failure(code, ...)`） | `:138-146`；`durable-storage.ts:24-46`；`extension.ts:1631-1645` |
| 持久化写冲突 8 次 | `SUPERVISOR_PERSISTENCE_CONFLICT` | `:123-137` |
| reply 时 request 已非 pending | `SUPERVISOR_REQUEST_NOT_PENDING`（持久化模式下 TTL 过期也表现为此码，因为 `loadRoot` 已把 state 改成 `expired`，`:204` 先于 `:205`） | `:204-205, 106-108` |

**分诊推论（重要）**：看到 `SUPERVISOR_REPLY_REQUIRED` 就证明——(a) 控制面已启用且 broker 就绪；(b) 该 run 至少有一条 request **登记成功**；(c) owner/generation 围栏已通过；(d) 本次 steer 文本不是既往成功 steer 的重放。历史 `docs/bugs/2026-09-30-supervisor-reply-deadlock.md` 那类「登记被静默吞掉」的形态已不复现于本码：现在登记失败会显式发消息并记入 `registrationFailures`（`extension.ts:1676-1682`）。

### 4.4 并发登记 / 幂等 / TTL 错位 / 登记失败 的区分

- **并发登记**：`registerSupervisorRequest` 的公开包装先在锁外读 owner 决定 root，再 `transaction(root, ...)`（`supervisor-control-plane.ts:273-276`）；事务内清空该 root 的内存态并从 durable 重载（`:138-155`），因此同 root 的并发登记/steer/reply 串行化，不会互相丢状态。静态可见的两点弱点：① 锁外决定的 root 与事务内重读的 owner root 若发生变化，写入的 root 与持锁的 root 会不一致（靠 `saveRoot` 的 revision 重试兜底，`:123-137`）；② 事务内 `deadline = 5s`，超时抛 `DURABLE_LOCK_HELD`（不是本码）。这两点都不产生 `SUPERVISOR_REPLY_REQUIRED`。
- **幂等**：reply key = `requestId:requestGeneration:payloadDigest`，steer key = `runId:ownerGeneration:payloadDigest:liveRunEpoch`（`:199`）。`receipts` 内存表以 idempotencyKey 为键、不按 root 分区，靠 `:201` 的身份不匹配检查兜底（`SUPERVISOR_RECEIPT_IDENTITY_MISMATCH`）；跨 root 的 requestId 为 UUID，实际碰撞可忽略。`liveRunEpoch` 缺失（`readRuntime` 失败返回 undefined）时 key 以 `undefined` 结尾，会让「同一文本、epoch 未知」的两次 steer 判为幂等——但这只在**已成功投递过一次**之后才可见，不影响本码。
- **TTL 错位**：上游 ask 10min（可由 `PI_INTERCOM_ASK_TIMEOUT_MS` 改）vs 本仓 20min，且本仓锚点是登记时刻。错位窗口内上游无 pending、本仓有 pending → C2。另一处错位是**同一条件两种码**：持久化模式下 TTL 过期后 reply 得 `NOT_PENDING`，内存模式下得 `REQUEST_EXPIRED`（`:106-108` vs `:205`；单测 `test/subagent-runtime-membrane.test.mjs:2098-2101` 走内存模式断言 `EXPIRED`，集成 `joint-...:67-73` 走持久化 + reconcile 断言 `expired`）。这属诊断表达问题，不是门禁放宽点。
- **登记失败**：见 §4.3 第一行。它使 reply 不可用、并使 steer **失去**本仓围栏（只剩上游守卫），方向与本码相反；`docs/bugs/2026-09-30-supervisor-reply-deadlock.md` 记录的首偏离点（静默 `.catch(() => undefined)`）在当前源码已被显式失败消息取代。

## 5. 可观测性缺口：为什么现场无法自证

1. **`pending` / `status` 不是本仓门禁视图。** 受控 adapter 只对 `action === "reply"` 加围栏，其余动作直接透传上游（`extension.ts:1266`；`supervisor-adapter.ts:30-33`）。因此 `subagent_supervisor({action:"pending"})` 返回的是上游 `publicPendingRequests`（`native-supervisor-channel.js:507-516, 532-535`），reply 之后必为空；`status` 只给上游 `pending.size`（`:529-531`）。**没有任何公开工具暴露 `listPending()` / `snapshot()`**（二者仅在 `supervisor-control-plane.ts:298` 内部使用，被 `extension.ts:1219, 1271` 消费）。→ 结论：**公开 `status`/`pending` 无法权威证明门禁状态**，也不能用它反推「本仓已解除」。
2. **本码的 details 只有 `{code}`**（§2.1），不含 requestId/runId/childIndex，也不区分「未回复」与「已回复未消费」。
3. **supervisor 诊断条目全部被 trace sink 丢弃。** sink 要求 `entry.version === 1 && Number.isSafeInteger(entry.monotonicMs)`，且 phase/event 必须在白名单内（`extension.ts:122-131, 154-185`）。而实际发出的 supervisor 诊断都不带 `monotonicMs`：`supervisor-registration-failed`（`extension.ts:1680`）、`supervisor-delivery-compensation-failed`（`:1164, 1169`）、`supervisor-persistence-corrupt` / `supervisor-persistence-rejected`（TTL 过期！）/ `supervisor-owner-read-failed` / `supervisor-runtime-read-failed`（`supervisor-control-plane.ts:92, 107, 169, 293` 的 `report`）、`supervisor-consumption-failed`（`subagent-runtime.ts:296`）、`supervisor-consumption-rejected`（`supervisor-consumption.ts:101`）。→ **不能把「trace 里没有」当成「没发生」**；这正是 `docs/research/2026-10-14-...md` §3 提出的白名单缺口的代码级确认。
4. **steer 被门禁拒绝时 trace 只留时序不留理由**：`executeControl` 是 `return controlFailure(...)` 而非抛错，故只写 `tool-entered` / `tool-returned`（`extension.ts:1605, 1614`），两者都在白名单内但不含 code、不含 runId、不含 action；`trace.stage` 只在派发路径设置，控制路径为 undefined。
5. 因此现场可用证据只有三类：用户可见的工具返回码/文案、用户可见的上游 `pending` 投影、以及 durable `supervisor-control/*.json` 的**枚举与时间戳字段**（由有权限的一方按 §6 提取，本轮不读）。

## 6. 必要最小非敏感样本清单

只取 ID、时间、枚举、返回码；**不要**请求正文、reply 正文、完整 history、session 文件、correlation 路径、任何凭据。

### 6.1 若「尚未 reply」（先按正常门禁处理）

- 操作：用**精确 `replyTo`** 回复该具体 request，不要用 `to` 模糊匹配、不要靠 steer 代替决策：
  `subagent_supervisor({action:"reply", replyTo:"<完整 requestId UUID>", message:"<针对该请求的明确答复>"})`
  依据：上游 `resolvePendingRequest` 对 `to` 的多匹配/零匹配都会抛错（`native-supervisor-channel.js:482-503`）；本仓 `findRequestAsync` 只按 `replyTo` 精确查（`extension.ts:1269-1271`）；历史 M01 样本正是 `replyTo` 抄错一个字符导致 `NOT_PENDING`（bug 文档「本会话样本分类」）。
- 需要记录的样本：`pending` 投影里的 `{id, runId, agent, childIndex, reason, expectsReply}`（全是 ID/枚举）+ reply 的返回码与 `isError` + 两个时间戳（reply 前、reply 后）。
- 若 reply 返回 `SUPERVISOR_REQUEST_REGISTRATION_FAILED`：记录 `registrationCode` 与 requestId，按 §4.3 走登记失败分支，不要重复 reply。
- 若返回 `SUPERVISOR_REQUEST_NOT_PENDING`：记录该 requestId、durable `requests[].state`（枚举）与 `createdAt/expiresAt`，用于区分 C2/C4（TTL 或终局已清）与真正的参数错误。

### 6.2 若「已 reply 但 steer 仍被拒」（C1/C2/C3/C5 的判定所需）

需要以下 receipt / proof 事实（全部为 ID、整数、时间戳、枚举、返回码）：

1. **reply 侧**：reply 调用的返回码与 `isError`；上游回执 `details.{replyTo, runId, agent}`；reply 时间戳；是否出现过第二次 reply 返回 `SUPERVISOR_DELIVERY_IDEMPOTENT`（若有，附 `receiptId`）。
2. **steer 侧**：失败的完整参数形态（`id` 还是 `runId`、是否给 `index`、是否给 `dir`；message 是否与既往某次成功 steer **完全相同**——只需是/否，不需正文）；返回 `details.code`；时间戳；同一 run 此前是否有成功 steer（有则给其时间戳）。
3. **run 侧**：完整 36 字符 runId；`subagent({action:"status", id})` 的 `state` 枚举与 steps 数量、目标 child 的 `status` 枚举；是否已收到该 run 的 completion 通知（是/否 + 时间）。
4. **durable 投影**（由用户或父层在其权限内提取，本轮不读）：`<PI_CODING_WORKSPACE_DIR|PI_CODING_AGENT_DIR>/supervisor-control/*.json` 中**仅**这些字段——
   `rootSessionId`；`requests[].{requestId, runId, ownerGeneration, requestGeneration, state, createdAt, expiresAt}`；`receipts[].{kind, status, consumed, code, requestId, runId, ownerGeneration, requestGeneration}`。
   **排除**：`correlation.*`（含 `asyncDir/sessionFile/childSessionId/toolCallId/requestBodyDigest`）、`replyPayloads`、任何正文。
5. **时间关系**（判定 C1 vs C2 vs C5 的关键）：`steer 失败时刻 − requests[].createdAt` 是否 < 20min；`PI_INTERCOM_ASK_TIMEOUT_MS` 是否被设置（只给数值）；child 的 `contact_supervisor` 结果是否 `isError:true` 且文案含 `Timed out`（是/否即可）；Host 是否在该窗口内重启/reload/被强制退出（是/否 + 时间）。
6. **会话形态**（判定 C3/C4）：该 run 是单 child 还是 workflow 多 child（steps 数量）；报错是否只出现在部分会话（若是，给这些会话的共同点：是否多 child、是否长任务、是否经历过 Host 重启）。

### 6.3 明确不作为证据的东西

- 上游 `pending` 为空 / attention 快照 / 延迟到达的 waiting-for-reply 提示 / run 正常完成 / reply 文案「Replied to supervisor request …」：均**不构成消费证明**（bug 文档「本会话样本分类」、V1 记录 §3）。
- 既有测试断言：只证明实现合同，不证明产品语义无缺陷（根 `AGENTS.md` 缺陷分类门禁第 2、3 条）。
- trace 文件中「没有 supervisor 条目」：因 §5.3 的白名单丢弃，属预期，不具证明力。

## 7. 安全调查手段与禁止事项

### 7.1 允许且推荐的手段

1. 只使用公开工具投影与用户自述时间线：`subagent({action:"status"})`、`subagent_supervisor({action:"pending"|"status"})`、失败调用的返回码——由**用户或父层在其会话内**执行；本轮不代跑任何真实工具。
2. durable 投影按 §6.2 第 4 项的字段白名单提取（可写一次性只读脚本，只 `JSON.parse` 后挑字段输出，绝不打印 `correlation`/正文/`replyPayloads`）。本脚本属**取证辅助**，不得引入 production。
3. 需要复现时，只用隔离 fixture（合成 provider + 临时 `PI_CODING_WORKSPACE_DIR`）在**独立临时目录**内跑既有集成测试路径（参考 `test/joint-upgrade-contact-supervisor.integration.mjs` 的 env 组织方式），不触碰用户真实工作区/会话。此类复现属新任务，需另行授权（本轮未执行任何测试）。
4. 若确需真实现场才能判定，只向 `contact_supervisor` 询问 §6 中**缺失的具体字段**，不自行扩读 `var/`、`sessions/`、`state/`、authority。

### 7.2 禁止事项（本轮已遵守，后续同样适用）

- 不放宽/绕过 `SUPERVISOR_REPLY_REQUIRED` 门禁；不删改 durable request；不伪造 `consumed`/`delivered`；不把 `queued` 写成 `delivered`；不把上游 reply 文件当 child 消费（`docs/bugs/2026-10-05-supervisor-consumption-receipt.md` 已明确此边界）。
- 不改 TTL、terminal proof 判据、owner 三态（`docs/plans/2026-10-15-runtime-closeout.md:35`）。
- 不建议无限轮询 `pending`、不建议 steer 重试风暴（`ASYNC_SPAWN_GUIDANCE` 与工具描述已明确禁止 poll；`extension.ts:121`）。
- 不擅自对用户 run 执行 `interrupt` / `resume` / `stop` / `kill`。历史文档记录过「interrupt+resume 可解锁」（`docs/bugs/2026-09-30-supervisor-reply-deadlock.md`），那是**用户自主决定的恢复手段**，不是诊断捷径，本报告不推荐由 agent 主动执行。
- 不读 settings/models/auth/credential、真实 authority store、真实 session 正文、真实 ledger 正文；不 stage/commit/stash/reset；不发起网络/provider/通知。
- 任何新的 production 兼容、防御或 fallback：必须先按根 `AGENTS.md`「缺陷数据来源分类门禁」完成来源分类与首偏离点记录，并**另行审批**；本轮不提出实现。

## 8. 处置建议（不含实现，供父层决策）

1. **先取证再定性**：按 §6 收集一份样本（一个失败 steer + 对应 reply + durable 投影枚举字段），即可把 C1–C5 收窄到一个，或确认属 §4.1 正常门禁。缺样本前保持 `unconfirmed`。
2. **面向用户的即时解释口径**（不改代码即可用）：
   - 本码表示「本仓 durable 记录中，该 run 仍有需要 supervisor 回复的请求」；它与 `subagent_supervisor({action:"pending"})` 的上游视图**不是同一套状态**，后者为空不代表门禁已解除。
   - 已回复但 child 仍在运行时，门禁要等 child 终局对账，或等该 request 登记后满 20 分钟；20 分钟锚点是**请求登记时刻**，不是回复时刻。
   - 不要为此重复 steer 或轮询 pending；不要用 interrupt/resume 作为常规绕过手段。
3. **若样本证实 C1（过度收敛）**：修复方向只能是「让门禁表达与事实一致」，且必须另立任务 + 来源分类 + 授权。可选方向（互斥性需评审）：
   - 门禁判据引入 `receipt.status/consumed` 与 upstream ask 事实的显式合同（不是「猜测消费」）；
   - 或保持门禁不变，只改**错误表达**：`details` 附 `requestId/childIndex/requestState/receiptStatus`（枚举与 ID，不含正文），文案区分「未回复」与「已提交未消费」，并给出与上游同级的精确 reply/等待指引。此项属诊断补强，与 `docs/research/2026-10-14-...md` §3 第 3 条一致。
4. **若样本证实 C2（TTL 错位）**：不得直接调小 20min 或调大上游超时来「对齐」；应先记录首偏离点（上游 ask 超时事实 vs 本仓 TTL 判据），再由授权任务决定是引入 upstream 事实判据还是收敛 TTL 语义。
5. **可观测性缺口（§5.3）独立于本码**：把 supervisor 诊断纳入显式安全 trace schema/白名单是本地可做的诊断补强（研究文档 §3 第 1、2 条），同样需另立任务；在没有它之前，任何「无 trace 证据」的结论都不成立。

## 9. 未证边界与残留风险

- **未取得任何用户样本**：C1–C5 只是静态可达候选，**不是**用户个案根因；也无法排除用户命中的是 §4.1 的正常门禁。
- **未运行任何测试/类型检查/Host/RPC/网络**：§3.2 的 TTL 行为、§2.4 的对账判据、§4.4 的并发与锁行为全部只有源码级证据；`transaction` 重载与 TTL 交互（内存态 `expired` 未 `saveRoot` 时，durable 文件仍可能显示 `pending`）尤其需要真实运行才能确认其可观测表现。
- **未验证用户环境**：`persistenceRoot` 是否配置（决定 TTL 是否可达）、`PI_INTERCOM_ASK_TIMEOUT_MS` 是否被改、上游版本是否与本地 `node_modules/pi-subagents@0.75.0` 一致，均未核实（本轮不读 env/settings）。
- **未读取 durable 状态与 session 正文**：§6.2 第 4 项字段清单是「应该取什么」，不是「已取到什么」。
- **实现合同 ≠ 产品语义**：`test/subagent-runtime-membrane.test.mjs:1811-1819, 2103-2106` 固化了当前门禁行为；若未来判定 C1 为缺陷，这些断言需要随授权修复一起调整，不能反过来用它们证明语义无缺陷。
- **相邻风险（非本码，未展开）**：reply 提交成功但 `commitDelivery` 持久化失败时，补偿会把 request 标 `failed`，之后 terminal 对账将得到 `SUPERVISOR_CONSUMPTION_MISMATCH`（`supervisor-control-plane.ts:229-236, 265-267`），消费事实会永久丢失；`captureSupervisorCorrelation` 在 child 以完全相同 reason+message 连续两次提问且都未完成时会 `SUPERVISOR_CORRELATION_CALL_AMBIGUOUS`（`supervisor-consumption.ts:44-47`），导致登记失败。两者都需独立样本与独立任务，本报告不改任何代码。
