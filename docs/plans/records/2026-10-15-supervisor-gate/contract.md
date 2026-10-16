# G0 接口可行性冻结合同（supervisor-gate-recovery）

- 任务：G0（dispatch-b3bfe4e0，contract sha `b3bfe4e073291c3b692e729dcd5116caa4b4b4aee1886346d144b12117d05a57`）
- 计划：`docs/plans/2026-10-15-supervisor-gate-recovery.md`（已完整 read）
- 基线：`docs/plans/records/2026-10-15-supervisor-gate/baseline.json`（B 已完成；任务书称提交 `357bade`）
- 提交事实（只读核对，写入本合同后复测）：`git log --oneline -3` 当前 HEAD = `f309781`；`git merge-base --is-ancestor 357bade HEAD` 退出码 0 ⇒ `357bade` 是 HEAD 祖先（B 确已提交）。`git status --porcelain=v1` 仅列 `?? docs/plans/records/2026-10-15-supervisor-gate/contract.md`（本任务新增）与 `?? pi/models.json.bak-qoder-thinking-20261016161901`（外部备份，未读/未动）；`git diff --cached --name-only` 为空；`git diff --check` 通过。baseline 中记录的 4 条 dirty 现场，本次复测已有 3 条不再出现在 status（`process-birth-identity.ts` 的修改、`docs/plans/2026-10-16-subagent-operation-tools-guidance.md`、`docs/plans/records/2026-10-15-runtime-closeout/heartbeat-types.md`），属父层已提交事实；第 4 条（外部 models.json 备份）仍在，本任务未读/未动/未 stage。
- 根因：`docs/research/2026-10-15-supervisor-steer-block-diagnosis.md`（已完整 read）
- package 约束：`packages/pi-subagents-enhanced/AGENTS.md`（深层 import 唯一 owner 为 `src/compat/pi-subagents-0.75.ts`）
- 证据模式：static（只读源码/公开 schema）。未运行 test/tsc/npm/Host/provider/网络/kill，未 stage/commit，未读真实 settings/session/authority/state 正文。
- 上游只 read：`node_modules/pi-subagents@0.75.0` 全部引用均为源码阅读，未新增深层 import，未改 upstream。

> 基线 `v2Status` 中「磁盘上也不存在 v2」不是现场证明（基线自身已声明未读真实 state）。本合同不据此断言任何具体 pending 内容；一切结论只来自源码事实。

---

## 1. 结论摘要（两条分支分别判定）

| 分支 | 判定 | 一句话理由 |
| --- | --- | --- |
| gate-target（child 级门禁所需的目标目录/身份） | **ready（限显式 index + 已证 correlation.childIndex 子集）**；「缺 index 推断唯一可 steer child」与「全量 child 目录」= **blocked** | 没有任何 public 接口能给出 `{childIndex, agent, lifecycleIdentity, steerable}` 的完整集合：`readRuntime` 是 run 级投影，`asyncSnapshot`/`fleet` 是带 `omitted` 计数的有界展示投影，`identityForRun` 不含 children。child 身份只在「单条请求」层面可证（durable `correlation.childIndex` 与 native pending 行 `{runId,agent,childIndex}`）。 |
| upstream-absence（清理资格所需的「上游已无该 live 请求」） | **blocked（absence 不可证）**；presence（存在）可证 | 公开 `pending` 只回 `details.pending` 数组（`publicPendingRequests`，字段 `id/runId/agent/childIndex/reason/expectsReply`），行内无 root/orchestrator 字段；且上游对 `wrong-session` 的行会 `pending.delete` 但保留 request 文件，加上 `listRequestFiles` 对每个 channelDir 的 readdir 失败是 `catch { continue; }` 静默跳过 → 空数组既可能是「无 live 请求」，也可能是「owner 不匹配」或「目录读失败漏检」。 |
| clear（inspect→token→clear 逃生口，C1/C2/C3） | **blocked**（依赖 absence 证明） | 见 §4/§6；不实现吞错、空集合 fallback 或 force override。 |
| 是否阻塞 G1/G2 | 否 | 计划 §4 明确：absence 不阻 gate。本合同的显式 index + correlation 子集即可支撑 G1/G2。 |

---

## 2. gate-target：真实可用接点（含行号证据）

### 2.1 run 身份 / owner（可信来源，可冻结）

| 事实 | 来源 |
| --- | --- |
| `identityForRun(runId)` → `{owner, ownerState, runtime}`，`ownerState ∈ owned/unowned/unavailable` | `src/subagent-dispatch/supervisor-control-plane.ts:402-409`；类型 `:87-91` |
| 三态判据：`readOwnerReceipt` 抛 `code==='unknown_run'` 才算 unowned；其余任何失败一律 unavailable（fail-closed，不放宽） | `supervisor-control-plane.ts:180-193` |
| broker 侧 `readOwnerReceipt` 对 `revoked \|\| supersededTo` 抛 `unknown_run`；存储/锁不可用抛其它 code | `src/subagent-dispatch/root-broker-server.ts:500-507` |
| Host root 身份 = `sessionManager.getSessionId()`，不接受模型填 root | `src/subagent-dispatch/root-broker-protocol.ts:350-353`；注入点 `extensions/subagent-runtime.ts:352`、`src/subagent-dispatch/extension.ts:1964,1547` |
| steer 上游接线：`canonicalSteerTarget`（禁 dir/禁前缀歧义/禁路径）→ `identityForRun` → `resolveSupervisorControl` → `rpc.steer(params)` | `extension.ts:1379-1395,1461-1495`；`params` 保留 `index`（`extension.ts:1460`） |
| steer 现 gate 判据不含 childIndex（本计划要改的缺陷点） | `supervisor-control-plane.ts:219-223`（`pending` 搜索仅 `state/runId/rootSessionId/ownerGeneration`，steer 命中即 `SUPERVISOR_REPLY_REQUIRED`） |

**冻结 owner 接口**（不新增、不改语义）：

```ts
// 现有 public（control-plane.ts:402-409），G1/G2 直接消费，不扩参数
identityForRun(runId: string): Promise<SupervisorRunIdentity>
// SupervisorRunIdentity = { owner: unknown; ownerState: 'owned'|'unowned'|'unavailable';
//   runtime?: { runId?; ownerGeneration?; liveRunEpoch?; running?; steerable? } }
```

### 2.2 child 身份：唯一可证的两条来源

1. **本仓 durable request 的 correlation**（强证明，已存在）
   - `SupervisorRequestV1.correlation` 含 `agent`、`childIndex`（严格校验：`Number.isSafeInteger(c.childIndex) && c.childIndex >= 0`，字段集 `exact(...)` 白名单）：`supervisor-control-plane.ts:10,66-70`
   - 写入来源为 broker 权威绑定 + `status.json` 交叉校验：`src/subagent-dispatch/supervisor-consumption.ts:31-37`（`inspectExecutionProof(runId)`/`facadeRuns` → `status.runId/pid/sessionId` 全等，再取 `status.steps[native.childIndex]` 且 `step.agent === native.agent`）
   - 结论：`childIndex ↔ agent` 的对应关系是「已绑定 run + 已校验 step.agent」的证据链，不是模型文本推断。
2. **native pending 行**（public RPC 结果字段，可证存在性）
   - `publicPendingRequests(pending)` → `{id, runId, agent, childIndex, reason, expectsReply}`：`node_modules/pi-subagents/src/intercom/native-supervisor-channel.js:507-516`
   - 行的 `runId/agent/childIndex` 由 `parseRequestFile` 强制校验类型（`childIndex` 只校验 `typeof === "number"`，未校验整数）：`native-supervisor-channel.js:203-205`

**冻结目标解析接口（G1）**：

```ts
type SupervisorTargetChild = Readonly<{ childIndex: number; agent: string }>;
// directory 只允许由「已证来源」构造，不接受 asyncSnapshot/fleet 猜行：
type SupervisorTargetDirectory =
  | { availability: 'available'; runId: string; ownerGeneration: number;
      children: readonly SupervisorTargetChild[] }   // 允许为空数组（表示本 root 无已证 child 记录）
  | { availability: 'unavailable'; code: 'SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE' };

resolveTargetChild(directory: SupervisorTargetDirectory, index?: number):
  | { status: 'exact'; target: SupervisorTargetChild }
  | { status: 'blocked'; code: 'SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE' }   // directory unavailable
  | { status: 'blocked'; code: 'SUPERVISOR_STEER_TARGET_INVALID' }           // index 非非负安全整数
  | { status: 'blocked'; code: 'SUPERVISOR_STEER_CHILD_AMBIGUOUS' }          // 缺 index 且无法唯一证明
  | { status: 'blocked'; code: 'SUPERVISOR_REQUEST_SCOPE_UNVERIFIED' };      // 缺 index 且 children 为空/多于1（不可证）
```

约束（不可放宽）：

- 缺 `index` **不得**默认 0，**不得**广播；旧的无 index 行为由上游承担，本仓 gate 一律 fail closed。上游自身的 index 边界校验只发生在**投递侧**：`node_modules/pi-subagents/src/runs/foreground/async-steering-action.js:88-96`（越界/不可 steer 的 child → `isError:true` 文本结果）。即「membership 校验」在 public 面上属于投递时失败，不是 gate 前可查目录。
- 不得把 `asyncSnapshot`/`fleet` 缺行当 child 不存在：`buildFleetStatus` 有 `MAX_FLEET_ENTRIES=16` 与 `omitted` 计数（`node_modules/pi-subagents/src/extension/rpc.js:71-198`，`omitted` 见 `:197`）；`AsyncStatusSnapshot` 有 `caps.maxRuns=20 / maxChildrenPerNode=8 / maxDepth=3` 与 `omitted{runs,children,byteLimitExceeded}`（`node_modules/pi-subagents/src/runs/shared/async-status-projection.js:9-14`、`appendBoundedChildren` 见 `:110-114`、d.ts 的 `AsyncStatusSnapshotOmitted`）。节点 `id` 为 `workflowKey|runId|step:${index}` 的启发（`stepIdentity`，同文件 `:116-120`），**不含**数值 childIndex 字段。
- `runtimeFromStatus` 是 run 级有界投影，不得当 child 目录：`src/subagent-dispatch/runtime-state.ts:13-26`（仅 `running/steerable/ownerGeneration/liveRunEpoch`；`steerable` 缺省等于 `running`，不是 per-child 事实）。
- unowned run：本仓无 durable request 时 steer 绕过控制面（`extension.ts:1471-1478`）；此时 child 目录不可证（`captureSupervisorCorrelation` 对无绑定 run 直接抛 `SUPERVISOR_CORRELATION_BINDING_MISSING`：`supervisor-consumption.ts:31-33`）→ 分支保持 blocked，不猜。

### 2.3 gate 所需 control-plane 真实兼容签名（冻结）

| 用途 | 现场真实签名（不可改形） | 位置 |
| --- | --- | --- |
| steer/reply 前置判定 | `resolveSupervisorControl(intent: unknown, hostRootSessionId?: string): Promise<{status:'allowed',intent,idempotencyKey,request}\|{status:'blocked',code}\|{status:'idempotent',receipt}>`（内部走 `transaction(intent.rootSessionId, ...)`） | `supervisor-control-plane.ts:211-232`、包装 `:389` |
| intent 解析（严格白名单字段） | `parseSupervisorControlIntentV1(value): SupervisorControlIntentV1`；键集固定 10 项，未知键即 throw；`kind ∈ reply/steer`；`liveRunEpoch` 可选 | `:74-83`、类型 `:12-16` |
| 提交/失败补偿 | `commitDelivery(input: {intent; success?; code?; consumed?}, hostRootSessionId?): Promise<...>`；成功默认 `status:'queued', consumed:false`，reply 成功时 request 仍 `pending` | `:233-247`、包装 `:390` |
| 只读诊断（无副作用、无迁移写） | `readDiagnostics(rootSessionId: string, filter?: { requestId?: string }): Promise<SupervisorDiagnosticsV1>`；**不经 transaction**；每组上限 50 + `complete`；失败固定 `SUPERVISOR_DIAGNOSTICS_UNAVAILABLE` | `:323-380`、包装 `:393`、`:25`、`:27` |
| 单请求查找（须带 root 才走事务重载） | `findRequestAsync(requestId: string, rootSessionId?: string)`；持久化模式无 root 时直接 `undefined`（fail closed） | `:395-400` |
| 其余（消费/终局/关闭） | `observeReplyConsumption(value, root)`、`markDeliveryConsumed(intent, root)`、`expireTerminalRequests(runId, root, 'expired'\|'failed')`、`closeRootRequests(root)`、`ready(root)`、`registerSupervisorRequest(native, root?)` | `:386-394`、`:387-388` |
| 纯分类（**当前不存在**，G1 需新建） | `classifyRequest(request: SupervisorRequestV1, receipts: readonly SupervisorDeliveryReceipt[], now: number)` → §2.2 枚举；现逻辑内联在 `:219-229`，内部 receipts 是 `Map<idempotencyKey, SupervisorDeliveryReceipt>`（`:99`，类型 `:17-20`），纯函数必须收 array 而非 Map | — |
| 摘要 | `supervisorCanonicalDigest(value)`（导出的唯一 digest 入口） | `supervisor-control-plane.ts`（现被 `extension.ts:1564`、`supervisor-consumption.ts` 消费） |

**必须在 G1/G2 记录的真实缺陷（事实，不在本任务修）**：steer 分支在 `rpc[action](params)` 之后**无条件** `commitDelivery`，未检查上游结果 `isError`：`extension.ts:1486-1490`；而 `isError` 是公开可传播的（`dataFromToolResult` 保留 `isError`：`node_modules/pi-subagents/src/extension/rpc.js:246-252`；本仓 `rpcResult` 透传：`extension.ts:498-504`）。这与计划 §2.2「`isError:true` 不写 queued receipt」直接对应，属 G2/C3 的接线改动。

---

## 3. upstream-absence：native `adapter.pending` 事实核定

### 3.1 绑定与 root 归属

| 事实 | 位置 |
| --- | --- |
| 唯一 bind 入口：membrane 只拦截 `registerTool` 且 `definition.name === "subagent_supervisor"`，`supervisorAdapter.bind(definition.execute.bind(definition))`；其它注册被过滤；`getAllTools` 隐藏上游同名工具 | `src/subagent-dispatch/runtime-membrane.ts:175-189`（常量 `:5`）；上游同名常量 `native-supervisor-channel.js:13` |
| bind 状态机：未 bind 执行 → 抛 `SUPERVISOR_TARGET_UNAVAILABLE`；重复 bind → `SUPERVISOR_TARGET_ALREADY_BOUND`；非 function → `SUPERVISOR_TARGET_INVALID` | `src/subagent-dispatch/supervisor-adapter.ts:20-40` |
| bind 丢失的可观测路径：`session_start` 时若未 bind，控制面 deactivate 工具并抛 `SUPERVISOR_TARGET_UNAVAILABLE` | `extension.ts:2061-2069` |
| **关键限制**：上游 native tool 的 execute 形参是 `(_id, params)`，**不接收 ctx**；本仓 wrapper 传的 `signal/onUpdate/ctx` 被上游忽略 | `native-supervisor-channel.js:524`（对比 `supervisor-adapter.ts:29-32` 的 5 参转发） |
| 因此 root 归属只能由上游自己的 owner 过滤证明：`requestMatchesOwner(request, state)` 比较 `state.supervisorOwnerSessionId`；该值由上游 `session_start` 从 `ctx.sessionManager.getSessionId()` 写入、session_shutdown 置 null | `native-supervisor-channel.js:327-330`；`node_modules/pi-subagents/src/extension/index.js:823`、`:943`、`fanout-child.js:243,264` |
| 本仓无法从 public 结果反查该 root 值：`details.pending` 行内无 root/orchestrator 字段；`status` 只给 `pending.size` 与 channel root 路径 | `native-supervisor-channel.js:507-516,529-531` |

⇒ 冻结的 bind/root 校验做法（C1 合同）：`resolveBoundRoot` 必须做两件事——(a) `adapter.isBound() === true`；(b) 对 `details.pending` **每一行**用本仓权威交叉验证 `identityForRun(row.runId).owner.rootSessionId === hostRootSessionId`；任一行不可证即整次观察 `unavailable`（不得只过滤掉不可证的行再宣称「完整」）。这验证的是「行属于本 root」，**不能**验证「本 root 的全部行都被看到」。

### 3.2 刷新完整性（决定 absence 可否证）

`pending`/`list` 分支执行顺序：`discover()` → `refreshPendingRequests(pending, state, onLifecycle, runState)` → 返回。

| 事实 | 位置 | 对 absence 的影响 |
| --- | --- | --- |
| `discover` 即 `poll()`（注册期传入 `() => poll()`） | `native-supervisor-channel.js:526,644,671-720` | 每次观察都会跑一遍完整 discover/refresh 生命周期 |
| `refreshPendingRequests`：lifecycle ≠ `pending` ⇒ **`pending.delete(request.id)`** + `onLifecycle` + `cleanupRequestLifecycle` | `:411-420` | 行被移出集合 ≠ 上游 request 文件消失 |
| `requestLifecycle` 判据顺序：`wrong-session` → `missing`（request 文件不存在）→ `resolved`（存在 reply 文件）→ `expired`（`now > expiresAt`）→ `inactive`（run 非活动）→ `pending` | `:394-405` | `wrong-session` 与 `pending` 在 public 输出里**不可区分**，两者都表现为「行不在数组里」 |
| `cleanupRequestLifecycle` 对 `resolved/expired/inactive` 删除 request 文件（best-effort，`fs.rmSync force` + 吞 `rm` 异常） | `:407-409`、`:366-373` | 已声明的上游既有副作用；真实存在，不能描述为无副作用 |
| `listRequestFiles` 对**每个 channelDir** 的 `readdirSync(requestsDir)` 失败是 `catch { continue; }`（静默漏检），只有顶层 root 目录缺失（ENOENT/win UNKNOWN）才 `return []`，其它顶层错误才 throw | `:222-246`（静默段 `:238-243`） | 空数组可能来自「目录读失败漏检」，absence 因此不可证 |
| `cleanupStaleChannelsIfDue` 的异常被 try/catch 吞掉；`pi.sendMessage` 失败只 `console.error`（ask 仍入 `pending`） | `:656-665`、`:703-718` | 通知失败不影响集合（这条是好事，但不是完整性证明） |
| 非 `expectsReply` 的 progress_update 在 discover 阶段直接删文件、不入 `pending`、不通知 | `:686-690` | `details.pending` 只含 `expectsReply` 行；非 asks 永不出现 |
| `childIndex` 类型仅校验 `typeof === "number"`（未校验整数/非负） | `:203` | observer 必须自己要求 `Number.isSafeInteger && >= 0`，否则 `unavailable` |

### 3.3 异常传播与副作用（可证事实）

- **会 throw（observer 可捕获 → `unavailable`）**：`poll()` 顶层 `listRequestFiles` 对 SUPERVISOR_CHANNEL_ROOT 的非缺失类 readdir 错误直接 rethrow（`:226-231`）；`adapter.execute` 在未 bind 时抛 `SUPERVISOR_TARGET_UNAVAILABLE`（`supervisor-adapter.ts:30`）。
- **不会 throw、只被吞**：per-channelDir readdir 失败（`:241-243`）、`fs.rmSync` 失败（`:370-372`）、`cleanupStaleEmptySupervisorChannels`（`:662-664`）、`pi.sendMessage`（`:716-718`）。⇒ 这正是 absence 不可证的根因：静默漏检与正常空集合同样返回 `isError` 缺省 + 空数组。
- **`isError` 语义**：native `pending` 分支从不设 `isError`（`:532-535`），所以 `isError !== true` 只是必要条件，不是完整性条件。reply 分支的歧义/缺失走 `throw`（`:482-505`），不是 `isError:true`。
- **副作用清单（必须写进 C1 文案/测试，禁止称「绝对无副作用」）**：一次 `pending` 观察会触发 (1) 新 request 文件发现并 `pending.set` + `markForegroundSupervisorAttention` 改写上游 state 的 child 活动字段（`:692-699`、`:332-347`）；(2) `refreshPendingRequests` 对 `resolved/expired/inactive` 删上游 request 文件并 `pending.delete`；(3) 对每个新 asks 以 `triggerTurn:true` 向父会话 `pi.sendMessage`，并 emit `INTERCOM_DETACH_REQUEST_EVENT`（`:700-723`）。本仓工具不得主动删除仍 live 的上游 request（计划 §2.3），本合同确认该禁令可被遵守（本仓无删除路径），但不能据此推出观察是只读的。

### 3.4 冻结 `UpstreamPendingObservation`（exact schema）

```ts
export type UpstreamPendingObservation =
  | { availability: 'available'; rootSessionId: string; observedAt: number;
      requests: readonly UpstreamPendingRow[] }
  | { availability: 'unavailable'; code: 'SUPERVISOR_UPSTREAM_UNAVAILABLE' };

export type UpstreamPendingRow = Readonly<{
  requestId: string;      // ← 上游字段名是 id（publicPendingRequests），observer 负责映射
  runId: string;
  childIndex: number;     // 必须 Number.isSafeInteger && >= 0，否则整次 unavailable
  expectsReply: boolean;  // 上游该集合恒为 true（progress_update 不入集合）；仍按实际字段校验，不写死
}>;
```

校验规则（全部 fail closed，任一不满足即 `unavailable`）：

1. `adapter.isBound() === true`；
2. `resolveRootSessionId(ctx.sessionManager)` 为非空 string；
3. 调用 `adapter.execute(toolCallId, { action: 'pending' }, signal, onUpdate, ctx)` 不抛错，返回值是对象、`isError !== true`、`details` 是对象、`Array.isArray(details.pending)`；
4. 每一行：`typeof id === 'string' && typeof runId === 'string' && Number.isSafeInteger(childIndex) && childIndex >= 0 && typeof agent === 'string' && typeof reason === 'string' && typeof expectsReply === 'boolean'`；`agent/reason` 只用于交叉校验/过滤，**不进** 任何输出投影；
5. 每一行的 `runId` 经 `identityForRun` 证明 `owner.rootSessionId === hostRootSessionId`（`ownerState === 'owned'`）；出现 `unowned`/`unavailable` 行 → `unavailable`；
6. **禁止**：content 文本解析（含 `"No pending supervisor requests."`）、直接读 `SUPERVISOR_CHANNEL_ROOT` 私有目录、经包装 `subagent_supervisor` 工具再递归（现 wrapper 对 `pending` 是透传：`extension.ts:1588`→`:1545`→`adapter.execute`）。

**absence 结论**：规则 1-6 可以把「目标 request 仍 live」判为**可证（presence）**；但「目标 request 已不在 live 集合」**不可证**，因为 `wrong-session`（root 变更后上游删 map 行而留文件）与 per-channelDir 静默漏检都 produce 与真 absence 相同的 public 输出。⇒ `availability:'available'` + `requests:[]` **不得**签发 clearChallenge。

### 3.5 clear 侧接口（冻结为 blocked，不实现）

```ts
// 冻结形状（供 C2/C3 在 absence 可证时直接使用；当前不可证 → 实现必须停在 blocked 分支）
inspectRequest(rootSessionId: string,
               target: Readonly<{ runId: string; childIndex: number; requestId: string }>):
  Promise<SupervisorInspectResult>;   // 只读；复用 readDiagnostics 的 transaction-free 语义；不得自动迁移写盘

clearRequest(rootSessionId: string,
             input: Readonly<{ runId: string; childIndex: number; requestId: string;
                              requestGeneration: number; clearChallenge: string; reason: string }>):
  Promise<SupervisorClearResult>;     // 锁内重查 owner、重查 upstream live 集合、验 token + CAS、一次写
```

- 现 control-plane **不存在** `inspectRequest/clearRequest`（grep 无匹配）→ 属新增，实现归 C2；其资格判据依赖 §3.4 的 absence 证明。
- 因 absence 不可证，C2 的 `clearAllowed` 在当前 public 面上恒为 `false`，固定 code：`SUPERVISOR_UPSTREAM_UNAVAILABLE`（不得改为空集合放行）。

### 3.6 冻结 fixedcodes（G1/G2 可用；blocked 分支不得复用他人 code）

| code | 状态 | 用途/来源 |
| --- | --- | --- |
| `SUPERVISOR_REPLY_REQUIRED` | 已存在（唯一产生点 `supervisor-control-plane.ts:223`，文案 `extension.ts:1397-1403`） | 目标 child 确有 needs-reply |
| `SUPERVISOR_STEER_CHILD_AMBIGUOUS` | 新增（全仓 grep 无匹配） | 缺 index 且无法唯一证明可 steer child |
| `SUPERVISOR_REQUEST_SCOPE_UNVERIFIED` | 新增（grep 无匹配） | request 缺可信 child 关联（无 correlation），不默认 0、不阻断所有 child |
| `SUPERVISOR_TARGET_DIRECTORY_UNAVAILABLE` | 新增（grep 无匹配） | child 目录不可证（含 directory 自身不可用）；identity 读失败沿用下行既有 code |
| `SUPERVISOR_TARGET_UNAVAILABLE` | 已存在（`supervisor-adapter.ts:30`、`extension.ts:2066-2069`） | owner/runtime 身份读不可用（不新增别名） |
| `SUPERVISOR_STEER_TARGET_{INVALID,ALIAS,CONFLICT,AMBIGUOUS,UNRESOLVED}` | 已存在（`extension.ts:1379-1395`） | runId 形态/前缀歧义；与 child 歧义**分离**，不复用 |
| `SUPERVISOR_OWNER_UNAVAILABLE` / `SUPERVISOR_STALE_OWNER` / `SUPERVISOR_PERSISTENCE_CORRUPT` / `SUPERVISOR_INTENT_INVALID` | 已存在（`supervisor-control-plane.ts:184,196,213,221` 区段） | 身份/CAS/intent 门禁，不放宽 |
| `SUPERVISOR_STEER_NOT_ALLOWED` / `STEER_DUPLICATES_REPLY` / `SUPERVISOR_DELIVERY_IDEMPOTENT` / `SUPERVISOR_RECEIPT_IDENTITY_MISMATCH` | 已存在（`:222,227,225,229` 区段） | 排序与幂等既有语义保持 |
| `SUPERVISOR_DIAGNOSTICS_UNAVAILABLE` | 已存在（`:27`） | 只读诊断 fail closed |
| `SUPERVISOR_UPSTREAM_UNAVAILABLE` | 新增（计划 §G0 指定；grep 无匹配） | 上游观察不可用 / absence 不可证 → 不签 token |
| `SUPERVISOR_ORPHAN_CLEARED` | 新增（计划 §2.3 `administrativeResolution.code`；grep 无匹配） | 行政清理标记（blocked 分支不产生） |

`reply-submitted`（pending + `kind:'reply' && status:'queued' && consumed===false`）的判据字段全部 present：`SupervisorDeliveryReceipt`（`:17-20`）与 `projectSupervisorReceipt`（`src/subagent-dispatch/diagnostics.ts:254-297`，明确「queued 与 consumed 是两个独立事实」）。⇒ gate 放行 reply-submitted **不需要**任何上游观察，纯本仓 durable 事实即可支撑（G1/G2 ready 的核心依据）。

---

## 4. observer / control-plane 的可执行接口边界（G1/G2/C1 实际可写什么）

- **G1（ready）**：`supervisor-gate-policy.ts` 纯函数三件套 `resolveTargetChild / classifyRequest / steerReceiptKey`，只消费 §2.2/§2.3 已证字段。禁止 IO、禁止 asyncSnapshot/fleet 猜目录、禁止缺 index 推断。
- **G2（ready）**：`supervisor-control-plane.ts` 内 v1→v2 严格 parser 与 gate 接线；intent 现键集是**闭合白名单**（`:76-77`，未知键 throw），加 `childIndex` 属 v2 intent 变更，须随 §2.4 存储版本决策一起做，不得在 v1 parser 上偷偷放宽。
- **C1（blocked，不实现）**：typed observer 可以按 §3.4 实现并输出 `unavailable('SUPERVISOR_UPSTREAM_UNAVAILABLE')`；但「可清理」所需的 exact-absent 观察不可证 ⇒ 不签 token。
- **C2/C3（blocked）**：依赖 C1 的 absence 资格；`clearRequest` 冻结形状已备（§3.5），本轮不落地。
- **V（部分可验）**：只验 gate（child 隔离、reply-submitted 放行、不同 run/root/ownergen 不互影响、unknown 身份仍拒），clear 单列未验，不冒称整功能完成。

---

## 5. 停止条件命中与未闭合字段

**已触发的停止条件（只停相应分支，不自动 fallback）**

1. 「未知身份/不可证 public 事实」：child 全量目录、index↔child 归属（缺 index）、upstream exact-absence 三项均不可由 public 面证明 → 对应分支停报（§1、§2.2、§3.4）。
2. 「须上游变更或放宽门禁才能满足验收」：若要证明 absence，需要上游在 `details.pending` 行内暴露 root/orchestrator 归属，或区分 `wrong-session` 与真删除，或让 `listRequestFiles` 的 per-channelDir 失败可观测。本任务禁止改上游（计划 §1）→ 不接受「放宽门禁」替代方案。
3. 未发生 scope 外写入、敏感数据读取；无测试/Host/网络/stage/commit。

**未闭合字段（unknown，须后续现场证据才能闭合，本合同不猜）**

- 当前 Host 是否配置 `persistenceRoot`（决定 TTL 是否可达）：只读 `extensions/subagent-runtime.ts:247-254` 得出「取决于 `PI_CODING_WORKSPACE_DIR`/`PI_CODING_AGENT_DIR`」，未读 env → unknown。
- 上游 `state.supervisorOwnerSessionId` 与 `resolveRootSessionId(ctx.sessionManager)` 在真实 Host 上是否恒等（代码同源 `sessionManager.getSessionId()`：`node_modules/pi-subagents/src/extension/index.js:823` vs `root-broker-protocol.ts:350-353`），未运行 → 仅静态同源，未证恒等无漂移。
- 用户历史故障（`ae0ae1d2…`、`3e255363…` 两例）的具体根因分类 C1–C5：仍 `unconfirmed`，本任务不采集样本。
- `liveRunEpoch` 的真实来源在上游源码不可见（上游 `liveRunEpoch`/`steerable` 字面量 grep 无匹配）→ `runtime.liveRunEpoch` 现由本仓 `runtimeFromStatus` 读 `details.liveRunEpoch`，public 面是否总提供该字段 unknown；幂等 key 含 `undefined` 尾段的风险保持（研究文档 §4.4）。

---

## 6. 最窄父决策（不泛问授权）

1. **clear 路径处置**：在 pi-subagents 0.75.0 的 public 面上 exact-absence 不可证。请二选一：(a) 本计划把 C1/C2/C3 标记为 `blocked-upstream` 并从本轮 DAG 移除（V 只验 gate，Z 记录「不可清理类别」）；(b) 另立上游任务，要求 `pending` 行暴露 root 归属/lifecycle 区分（计划 §1 禁改上游，需你明确批准范围变更）。我不自行选 (b)，也不做「空集合即无 live 请求」的 fallback。
2. **G2 的 intent 版本**：给 steer intent 加 `childIndex` 是否随 §2.4 v2 一并做（v2 intent 键集扩展 + 严格 parser），还是本轮只允许用「request.correlation.childIndex 侧过滤 + 显式 index 透传」的更小改动？两种都可交付，但落盘 schema 不同，属需你定的窄技术问题。
