# D3 验收记录：supervisor trace、status 与 reply 诊断接线

- 日期：2026-10-15
- 计划/任务：`docs/plans/2026-10-15-runtime-closeout.md` §5 D3；dispatch `dispatch-867e5691`
  （contract sha256 `867e56912d7d23829b8420759034f6215a77c9a47af0504b28568611b2494494`，agent=delegate）
- 执行方式：用户已授权 Subagent-Driven 并行；unit-runner 为父层调度资源。本任务先完成静态实现与
  测试代码，再经 `contact_supervisor` 申请槽；获授后单次 `ps` 观察确认无 P0 in-flight 命令（无
  `node --test`/`tsc`/`npm run` 进程）才开始运行，未 sleep/poll 抢槽，运行完毕即释放。
- provider：本窗口未调用任何 provider/模型（纯本地实现 + 本地 fake RPC/fake Host 测试）。
- 授权追加（主管裁定「选 A」）：临时追加第 7 个 WritePath `scripts/probes/subagent-dispatch-startup.ts`，
  范围严格限定为「9 类 supervisor phase/type/event 包络的严格白名单与字段校验」，保持 import-free、
  identity/phase/monotonic/window/size/outputBudget 全部 fail-closed，不接受任意嵌套或正文，
  不改 D1 negotiation 规则，且**不把已有 TS18046 预存错误改绿**。

## 1. 变更文件

| 路径 | 动作 | 说明 |
| --- | --- | --- |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | Modify | ①新增 D3 安全包络层：`monotonicNowMs()`、`unavailableSupervisorDiagnostics()`、`safeSupervisorDiagnosticRequest()`、`safeSupervisorDiagnostics()`（对 D2 `readDiagnostics` 输出再做键集 fail-closed + 逐字段重建，receipt 行复用 D0 `projectSupervisorReceipt`）、`supervisorDiagnosticCandidate()`、`withSupervisorDiagnosticDetail()`；②trace file sink 新增**独立 supervisor 白名单分支**：既有 dispatch/working-state 白名单提取为 `traceRecord()` 并**优先**，只有它不认领且 `phase`/`type` 声称 `supervisor-` 的记录才交 D0 `projectSupervisorTrace(entry, monotonicNowMs())` 规范化后落盘，写入仍走唯一 `persist()`（0600/O_NOFOLLOW/uid/inode 复核/失败即永久关闭/dispose 幂等原样）；③`createControlledSupervisorAdapter` 在 reply 早 return **之前**新增 `executeStatus`：native 透传后在 `details.supervisorDiagnostic` 附只读投影，root 仅取 `resolveRootSessionId(ctx.sessionManager)`，既有 `replyTo` 仅作 `requestId` 过滤，只调 D2 `readDiagnostics`；④reply 的 `committed.status === "committed"` 分支改为显式 if 并附 `details.deliveryReceiptDiagnostic = projectSupervisorReceipt(committed.receipt)`，execute→commit→compensate 顺序与 native sender/content 原样 |
| `scripts/probes/subagent-dispatch-startup.ts` | Modify（主管追加授权） | consumer 同步：新增 `SUPERVISOR_EVENT_KIND`/`SUPERVISOR_PHASES`（9 类）/`SUPERVISOR_ALLOWED`（13 键）/`SUPERVISOR_ID_FIELDS`/`SUPERVISOR_GENERATION_FIELDS`/`SUPERVISOR_RECEIPT_STATUSES`/`SUPERVISOR_ID`/`SUPERVISOR_ERROR_CODE` 与 `validSupervisorDiagnostic()`、`claimsSupervisorDiagnostic()`；`validate()` 在 `version` 门禁之后、dispatch 身份门禁之前分流 supervisor 包络：合格则只参与单调时序校验（不作为 dispatch 证据返回），不合格一律 `invalid-schema`，不回落身份门禁。`PHASES`/`STAGES`/`ALLOWED`/`validNegotiation`/window/maxBytes/maxRecords/outputBudget/`invalid-*` 码与 D1 一字未改；保持 import-free |
| `test/subagent-runtime-membrane.test.mjs` | Modify（只追加） | 追加 D3 段：`createSupervisorScenario` 公开链路 harness + 8 个 `test()` 调用点（6 个顶层 + 2 个参数化循环展开 11 个用例）= **17 个新用例**；既有 94 个用例与断言未改（该文件 111 tests 全绿） |
| `test/subagent-dispatch-startup-probe.test.mjs` | Modify（只追加） | 追加 D3 段：`producerEntries()`（9 类 producer 现场形状）+ 5 个 `test()`（sink 规范化、fail-closed 与既有记录优先、门禁不放宽、真实 sink→probe 正例、probe 对不合格包络负例/9 类不误杀）；既有 8 个用例与断言未改（该文件 13 tests 全绿） |
| `docs/plans/records/2026-10-15-runtime-closeout/supervisor-diagnostics.md` | Create | 本记录 |

**在 WritePaths 内但未修改（静态事实，主管已接受）**：

- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-consumption.ts`：唯一 producer
  `input.diagnosticSink?.({ phase: 'supervisor-consumption-rejected', runId, requestId, code })`（第 101 行）
  已接到同一 sink；缺 `version`/`monotonicMs` 由 sink 的 D0 包络层补齐。为其包 try/catch 属于对
  「production 不可达的抛异常 sink」加防御（真实 file sink 的 `persist()` 内部已捕获全部写入异常），
  按 AGENTS.md 缺陷门禁不得新增该兼容分支，故不改；也不为补 trace 改任何消费条件。
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`：`diagnosticSink =
  createSubagentDispatchTraceFileSink()`（第 237-239 行）已作为唯一 sink 注入控制面
  （第 255 行）、消费观察（第 294 行）、`supervisor-consumption-failed` producer（第 296 行）与
  `installHeadlessTypedSubagentRuntime`（第 313-318 行）；`supervisorControlPlane:
  enabledSupervisorControlPlane`（第 460 行，展开含 D2 `readDiagnostics`）与 `resolveRootSessionId`
  （第 461 行）已就位，status/reply 诊断在 production 无需新增接线。

**未触碰**（读 only）：`diagnostics.ts`（D0 owner）、`supervisor-control-plane.ts`（D2 owner）、
`supervisor-adapter.ts`（明确 scope 外）、`errors.ts`、`rpc-client.ts`、`supervisor-replay.ts`、
steer gate/TTL/owner 三态/terminal consumption 相关实现、package manifest/exports/tsconfig、
`docs/plans/2026-10-15-supervisor-gate-recovery.md`（**未授权实施，本任务未实施其任何项**：
未新增 child gate/clear 工具、未新增 schema v2、未新增 tool 或 poller）。
未 stage/commit/push/stash/reset；未启动 Host；未联网；未安装依赖；未 kill 任何进程。

## 2. 依赖载体复验（不采信转述）

1. **D1 载体（源码级 + 实跑）**：`safeRpcNegotiationDiagnostic()` 与 sink 的 `negotiation` 白名单
   分支保持原样（本次仅把写入尾段提取为 `persist()`，门禁逻辑逐字不变）；`assertSpawnCapabilities`
   的 `dispatchPath` 参数、`error.detail = { negotiation }`、`trace.rpcNegotiation` 与 catch 合并
   均未改。实跑复验：`test/subagent-rpc-diagnostics.test.mjs` 未在本任务范围内重跑，但
   `test/subagent-dispatch-startup-probe.test.mjs` 的 D1 全部 8 个既有用例（含 negotiation 白名单、
   门禁、真实 sink→probe 正例）在本次 13/13 中通过。
2. **D2 载体（源码级 + 实跑）**：`readDiagnostics(rootSessionId, filter?)` 存在于
   `supervisor-control-plane.ts` 并在返回对象上导出（`readDiagnostics:` 一行），返回
   `{schemaVersion:'supervisor-diagnostics.v1', availability, code?, requests, receipts, complete}`；
   类型 `SupervisorDiagnosticsV1`/`SupervisorDiagnosticsRequestV1` 由本任务 import 消费。
   实跑复验：`test/supervisor-diagnostics.test.mjs` 6/6、`test/supervisor-consumption.test.mjs` 4/4、
   `test/supervisor-replay.test.mjs` 4/4，均 exit 0（见 §5）。
3. **未发现 D2 偏差**：接口签名、字段集、50 条上限、`unavailable` 固定 code、只读语义（不改 Map、
   不调 loadRoot/ready/transaction）与本任务消费方式一致，故未停报。

## 3. 实现取舍与不变量

- **既有白名单优先，杜绝投毒串道**：sink 先算 `traceRecord(entry)`（原 dispatch/working-state 分支，
  含 `version === 1 && Number.isSafeInteger(monotonicMs)` 门禁），命中即按原形状落盘并 return；
  只有它不认领时才进入 supervisor 分支。因此 `{version:1,toolCallId,phase:'tool-failed',type:'supervisor-*'}`
  这类投毒记录仍只产出原 dispatch 记录（测试覆盖），既有记录形状与门禁零变化。
- **9 类 phase/type 全覆盖**：`projectSupervisorTrace` 接受 `phase` 或 `type`，输出统一为带完整
  `supervisor-` 前缀的 `phase` 枚举；`version`/`monotonicMs` 只在诊断包络层补齐（缺字段或负数/小数
  由 `monotonicNowMs()` 替换），不补业务身份与消费事实。未知 `supervisor-*` phase/type 整条丢弃，
  不回落其它分支。
- **只输出安全 IDs/enums/有限整数**：`error`/`cause`/`secondaryError`/`compensation`/`deliveryPhase`、
  session 路径、正文、owner token、`payloadDigest`/`requestDigest`/`idempotencyKey` 均不落盘、不进
  details（canary 断言覆盖 4 类敏感值 + 大小写 `canary`）。
- **status 只增不改**：`withSupervisorDiagnosticDetail()` 返回**新对象**，`content` 按引用透传
  （测试 `assert.equal(status.content, nativeResult.content)`），原 `details` 字段全部保留，原 native
  结果对象不被就地改写（frozen 输入亦安全）；`details` 存在但不是 record 时原样返回，绝不覆盖 raw。
- **root authority 唯一来源**：只 `resolveRootSessionId?.(ctx?.sessionManager)`；resolver 抛异常、
  未接线、返回非字符串、控制面 `enabled() === false`、缺 `readDiagnostics`、读取抛异常、返回畸形包络
  → 一律附固定 `unavailable` 包络（`code=SUPERVISOR_DIAGNOSTICS_UNAVAILABLE`，空 requests/receipts，
  `complete:false`），并且**不发起任何 readDiagnostics 调用**（spy 断言 `readCalls` 为空）；
  `unavailable` 明确不等于「无 pending」。
- **只读、不动 TTL**：status 分支只调 `readDiagnostics`，不调 `loadRoot`/`ready`/`transaction`/
  `resolveSupervisorControl`/`commitDelivery`，不改 Map、不铸 token。测试用持久化 root 证明：
  远超 TTL 后只读诊断仍报告存储观察值 `pending`，durable state 字节与 mtime 不变；对照组
  （事务路径 `resolveSupervisorControl`）仍按原语义收敛（`loadRoot` 把过期 pending 置 `expired`
  → 返回 `SUPERVISOR_REQUEST_NOT_PENDING`，且未写回存储）。
- **reply 顺序与语义不变**：native `adapter.execute` → `commitDelivery` → 附投影；`idempotent` 与
  非 committed 仍走原 `controlFailure`（不附诊断、不伪装成功）；native 投递失败仍抛原错误
  （补偿成功时）或 `AggregateError`（补偿也失败时），只留下 `failed` 回执事实。
  `queued ≠ consumed` 由断言固定：committed 回执 `status:'queued', consumed:false` 且 request 仍
  `pending`；只有真实 `observeReplyConsumption` 才推进为 `delivered/consumed:true` 与 `replied`。
- **消费判据/gate/owner 三态未改**：`supervisor-consumption.ts`、控制面 TTL 与三态判定、steer 的
  `SUPERVISOR_REPLY_REQUIRED` 围栏、terminal consumption 观察条件全部原样；本任务只增加诊断投影。
- **不新增 tools/schema**：`SUPERVISOR_PARAMETERS`（`reply|pending|status` + `to/message/replyTo`）
  与 `TYPED_SUBAGENT_PARAMETERS` 未改；未新增第二 tool、poller、sender、authority 或 timer。
- **probe consumer 同步（授权追加）**：supervisor 包络没有也**不得**伪造 dispatch 身份，因此 probe
  校验后**不把它当 dispatch 证据**返回（`records` 仍按 `parentSessionId`+`toolCallId` 精确过滤），
  只保证同文件的 dispatch 证据不再被连带 fail closed；单调时序仍跨全部记录校验，身份关联错误仍
  `unproven`（非 `invalid-*`）。

## 4. 数据来源分类（AGENTS.md 缺陷门禁）

| 现象 | 分类 | 依据与处置 |
| --- | --- | --- |
| D3 后 trace 文件出现 supervisor 包络记录，probe `readBoundedDispatchTrace` 整文件 fail closed（`invalid-identity`/`invalid-phase` → `cause=unproven`），连带丢弃同文件 dispatch 证据 | **类别 1：预期 production 数据未被 consumer 正确处理** | producer 是本仓合法入口：`extensions/subagent-runtime.ts:237-239` 在 `PI_SUBAGENT_DISPATCH_TRACE_FILE` 存在时创建唯一 file sink，9 类 producer 经 `reportSupervisorDiagnostic`/控制面 `report`/`reconcileSupervisorConsumption`/`observeConsumption`/`createSupervisorReplay` 到达该 sink；consumer 是 `scripts/probes/subagent-dispatch-startup.ts` CLI。身份/时间/资源事实均有效，非手拼 fixture。与 D1 §4 同类，且 D1 record §8 已预告需同步。处置：主管裁定「选 A」授权同批以严格白名单同步 consumer，未新增 production 兼容/放宽分支，未改 D1 negotiation 规则 |
| `scripts/probes/subagent-dispatch-startup.ts` 的 `TS18046 'entry.monotonicMs' is of type 'unknown'` | 既有债务（非本批引入） | HEAD 基线同一命令报同一错误（HEAD 行 28，当前行 115，仅行号因新增代码位移）；该文件不在任何 tsconfig include 内。按主管指示**不改绿**，单列为残留项 |
| `npm run typecheck` 的 root 侧 `pi/extensions/compact-tools.ts(13,61) TS2741` 缺 `nativeEditRenderers` | **另一 workstream 的 in-flight 现场，非本任务数据** | 该必填字段来自工作区未提交的 `src/compact-tools/index.ts` 改动（`git show HEAD:src/compact-tools/index.ts | grep -c nativeEditRenderers` = 0）；root `tsconfig.json` include 不含本任务任何改动文件（`packages/**` 与 `scripts/probes/subagent-dispatch-startup.ts` 均不在 include），故与 D3 diff 无因果关系。未修（越 WritePaths），上报父层/该 owner |
| 新增测试中的失败注入（owner 读取抛异常、损坏 state、畸形包络、投毒 sink 记录、native 投递失败、补偿被阻塞） | **类别 2：测试矩阵** | 全部经公开入口构造：`createTypedSubagentExtension` 的 `message_end` ingress 与 `subagent_supervisor` tool `execute`、`createSupervisorControlPlane` 公开方法、`createSubagentDispatchTraceFileSink`、`createSupervisorReplay`。未手拼 projection/event 冒充真实 run、未绕过 public 入口 append、未使用倒退时间（TTL 用例只前移受控 `now`）。仅用于证明白名单与 fail-closed 行为 |
| `supervisor-replay-failed` producer | 类别 2（接线已就绪，production 无实例化点） | `createSupervisorReplay` 在 `packages/**`、`src/**`、`pi/**`、`scripts/**` 内无任何 production 调用点（仅 `test/supervisor-replay.test.mjs`）；sink 分支已能规范化其 `{version:1, phase:'supervisor-replay-failed', error, cause}` 形状，并经真实 `createSupervisorReplay` + 抛异常 barrier 验证落盘安全。未为其新建 caller（超出 D3 范围） |
| 历史 RPC/supervisor 个案（`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md`、`2026-10-10-rpc-session-capability-negotiation.md`） | 仍 **blocked-evidence** | 本任务只交付「未来可诊断性」；未读取用户 session/authority/凭据，未启用 raw debug 读取用户会话，未声称修复任何历史故障根因，未声称 child mid-run 已消费 |

## 5. 实际命令与结果（unit-runner 独占槽内，Node v26.8.1）

| # | 命令 | exit | 计数/输出 |
| --- | --- | --- | --- |
| 1 | `node --test test/subagent-runtime-membrane.test.mjs test/subagent-dispatch-startup-probe.test.mjs test/supervisor-diagnostics.test.mjs test/supervisor-consumption.test.mjs test/supervisor-replay.test.mjs test/subagent-supervisor-adapter.test.mjs`（第 1 次） | 1 | **142 tests / 141 pass / 1 fail / 0 skipped / 0 todo / 0 cancelled**，duration 609ms。唯一 fail 是本任务新写测试的两处自身缺陷：①`NINE_PHASES` 常量顺序与 `producerEntries()` 落盘顺序不一致（改为集合比较 + 与 producer 顺序逐条比较）；②`test/subagent-runtime-membrane.test.mjs` 顶层直接 `import` `supervisor-replay.ts`，其依赖 `durable-contract.ts` 使用 TS parameter property，Node strip-only 模式报 `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（改为沿用本文件已有 jiti 实例导入）。**仅改测试代码，未改 production** |
| 2 | 同上（第 2 次，修完测试缺陷） | **0** | **142 tests / 142 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled**，duration 1784ms |
| 3 | 逐文件计数（同槽，`node --test <file>` × 6） | 0 ×6 | membrane **111/111**、startup-probe **13/13**、supervisor-diagnostics **6/6**、supervisor-consumption **4/4**、supervisor-replay **4/4**、subagent-supervisor-adapter **4/4**；合计 142，与命令 2 一致；全部 `skipped 0` |
| 4 | `npm --prefix packages/pi-subagents-enhanced run typecheck`（`tsc --noEmit -p tsconfig.json`） | **0** | 无诊断输出。**这就是 D2 当时被污染的全包 package 侧检查：D2 报告的 11 条 extension.ts `unknown` 错误已不复现（D1 owner 已修，本任务未回退）** |
| 5 | `npm run typecheck`（root + package 全包） | 1 | root 侧 1 条错误：`pi/extensions/compact-tools.ts(13,61) TS2741: Property 'nativeEditRenderers' is missing`。归属另一 in-flight workstream（证据见 §4 第 3 行）；package 侧 0 错误。**D2 当时的 root 侧 “BA EOF” 错误已不复现**（`src/background-activity/**` 现可完整解析） |
| 6 | `node_modules/.bin/tsc --noEmit --ignoreConfig --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck --types node scripts/probes/subagent-dispatch-startup.ts` | 1 | 仅 1 条：`(115,33) TS18046 'entry.monotonicMs' is of type 'unknown'` = D1 已记录的预存错误（行号位移）。**本任务新增 0 条类型错误**；按主管指示未修 |
| 7 | 同命令跑 HEAD 基线（`git show HEAD:scripts/probes/... > /tmp/d3-probe-head/probe-head.ts`，仓库外只读提取） | 1 | `(28,33) TS18046` 同一错误 → 证明预存；另有 `(59,24) TS1470 import.meta` 属 /tmp 无 `package.json`（默认 CJS）的 harness 假象，在仓内 ESM 上下文不出现 |
| 8 | `git diff --check` | **0** | 无空白/冲突标记错误 |
| 9 | 新增 untracked 记录文件空白检查：`git diff --no-index --check /dev/null docs/plans/records/2026-10-15-runtime-closeout/supervisor-diagnostics.md` 与 `grep -nE " +$\|\t$\|^<<<<<<<\|^=======$\|^>>>>>>>"` | 1 / 1 | **无任何空白或冲突标记输出**；`--no-index` 的 exit=1 仅表示与 `/dev/null` 存在差异（非空白错误，`--check` 命中时会打印 `trailing whitespace` 行）；对照命令对 README.md 同样 exit=1/无输出。不动 index |
| 10 | `git diff --cached --name-only \| wc -l` | 0 | staged 文件数 = **0**；未 commit/push/stash/reset |
| 11 | `ps -eo pid,ppid,etime,command \| grep -Ei "controlled-pty\|node --test\|tsc \|npm run\|pi-launcher"`（槽前单次观察，非 poll） | 0 | 无匹配进程 → 未与 P0 重叠 |
| 12 | owner 文件未改证据：`stat -f "%Sm %N"`（当前时间 `2026-10-15 21:52:45`） | 0 | D0：`diagnostics.ts` 19:17:54、`test/subagent-diagnostic-projection.test.mjs` 19:18:08；D2：`supervisor-control-plane.ts` 20:14:54、`test/supervisor-diagnostics.test.mjs` 20:17:41 —— 均早于本任务首次写入（21:26）。WritePaths 内未改文件：`supervisor-consumption.ts` 2026-10-08 11:35:05、`extensions/subagent-runtime.ts` 2026-10-10 15:52:48；`supervisor-adapter.ts` 未出现在 `git status` 变更列表 |
| 13 | 收尾复跑（同一槽，仅记录文档变更后的最终绿证据）：命令 2 的六文件 + package typecheck + `git diff --check` + staged | 0 / 0 / 0 | **142 tests / 142 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled**（duration 2098ms）；package typecheck 无输出；`git diff --check` 无输出；staged = 0 |

未跑条款（按主管指示与计划门禁）：`npm test`、all-integration glob、`npm run verify:subagents-enhanced`
与 `test/pi-subagents-enhanced-package.test.mjs`（需 `npm pack pi-subagents@0.75.0`，网络门禁属 N1）、
任何真实 Host/PTY/CLI/provider/网络运行、任何 kill。`test/subagent-rpc-diagnostics.test.mjs`、
`test/subagent-dispatch-rpc.test.mjs`、`test/subagent-diagnostic-projection.test.mjs`（D0/D1 owner 文件）
未在本槽重跑：本任务未改其 owner 实现，且 D1 的 sink/negotiation 合同由 startup-probe 13/13 覆盖。

## 6. 残留风险与未验边界

- **历史个案仍 blocked-evidence + source canary**：新诊断只让**未来**的 supervisor
  registration/delivery/compensation/owner-read/runtime-read/persistence/consumption/replay 失败可归因；
  不证明任何既有 `SUPERVISOR_REPLY_REQUIRED`/gate/NOT_PENDING 故障已修复，也未读取任何真实用户
  session/authority 正文。`docs/bugs/2026-10-10-supervisor-reply-required-state-views.md` 的根因状态
  不因本任务升级（Z1 只追加诊断入口）。
- **probe 预存 TS18046 未修**（主管明确不改绿）：`scripts/probes/subagent-dispatch-startup.ts:115`，
  该文件不被任何 tsconfig 覆盖，无运行时影响（前一行 `Number.isSafeInteger` 已先判定）。
- **root 全包 typecheck 非绿**：`pi/extensions/compact-tools.ts(13,61) TS2741`，属 compact-tools
  workstream 的 in-flight 现场，需其 owner 或父层收口；不在本任务 WritePaths，未修。
- **`deliveryPhase`（steer/reply）不投影**：D0 `SafeSupervisorTraceV1` 未包含该字段，本任务不改 D0，
  因此 `supervisor-delivery-compensation-failed` 记录只能区分 phase，不能区分是 steer 还是 reply 补偿。
  需要时要由 D0 owner 扩 schema（v2 需同步 sink 与 probe 两处白名单）。
- **`supervisor-replay-failed` 无 production 实例化点**：接线已就绪但没有 caller；真实运行时不会产出
  该记录，直到有 production 代码使用 `createSupervisorReplay`。
- **probe 与 sink 是同一合同的两份实现**（主管裁定 probe 保持 import-free）：D0 schema 升级需同步
  `extension.ts` 与 `scripts/probes/subagent-dispatch-startup.ts`，否则 consumer fail closed（安全方向）。
- **未验证真实 Host/真实 pi-subagents 0.75.0 端点**：全部经本地 fake RPC/fake Host 与本地 fake
  provider 无关的纯 Node 测试；真实 `subagent_supervisor` status 文本由上游 native sender 决定，
  本任务只证明附加字段不改写它。

## 7. 交接给 Z1 的产物

- **status 诊断字段**：`details.supervisorDiagnostic`（`supervisor-diagnostics.v1`，
  `available|unavailable` + 固定 code，requests/receipts 各 ≤50，`complete`）。文档措辞必须写明
  `unavailable ≠ 无 pending`、`queued ≠ consumed`、`requests.state` 是存储观察值而非重新计算的 TTL 结论。
- **reply 诊断字段**：`details.deliveryReceiptDiagnostic`（`supervisor-receipt-diagnostic.v1`），
  只在本次 `committed` 后出现；idempotent/failed/blocked 路径不出现该字段。
- **trace 文件新记录形态**：`{version:1, eventKind:"supervisor-diagnostic", phase:<9 类>, monotonicMs, …安全 IDs/enums}`，
  与 dispatch/working-state 记录同文件共存；probe 已同步（校验但不作为 dispatch 证据返回）。
- **未实施项（Z1 需继续记为未实施）**：`docs/plans/2026-10-15-supervisor-gate-recovery.md` 全量
  （child gate/clear 工具/schema v2）、`triggerTurn` 发送前结构化合同、idle 系统通知、`resume(model)`、
  scheduler store/lock 并发修复、旧实验工作区清理。
