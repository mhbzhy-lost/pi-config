# D1 验收记录：RPC 准入失败安全回执与 trace 接线

- 日期：2026-10-15
- 计划/任务：`docs/plans/2026-10-15-runtime-closeout.md` §5 D1；dispatch `dispatch-916f8122`
  （contract sha256 `916f8122221108e3d4df791d2189fdbd08c5ee1073551adbe0006ca1a0148db6`，agent=delegate）
- 执行方式：用户已授权 Subagent-Driven 并行；unit-runner 为父层调度资源，本任务在获授独占槽后
  才运行 node/tsc（槽前只做静态实现与本记录草稿），未 sleep/poll 抢槽。
- provider：本窗口未调用任何 provider/模型（纯本地实现+本地 fake RPC 验证）。
- 授权追加：主管裁定「同批修复 producer/consumer 合同，不留明知无法读取的新诊断」，临时追加
  WritePath `scripts/probes/subagent-dispatch-startup.ts`，范围严格限定为该 CLI 的 trace schema
  精确纳入 `stage`/`negotiation`，其余预算/身份/门禁不变。

## 1. 变更文件（含主管追加的 1 个临时写路径）

| 路径 | 动作 | 说明 |
| --- | --- | --- |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | Modify | ①`assertSpawnCapabilities(result, cwd, dispatchPath)` 新增显式派发路径参数，仅失败时 `error.detail = { negotiation: projectRpcNegotiation(...) }`（extension.ts:339,369）；②coding/generic 两条路径 ping 成功后把**同次** ping 的 D0 投影挂在本次调用的 trace 闭包 `trace.rpcNegotiation`（extension.ts:907,1117）；③`execute()` 既有 catch 内对 RPC 失败分支安全合并 `negotiation`，保留 `createSubagentRpcFailureDetails` 全部原字段（extension.ts:1705-1729）；④file sink 只白名单 `tool-failed` 的嵌套 negotiation，逐字段重建 + 键集 fail closed（extension.ts:162-196,224-236） |
| `test/subagent-rpc-diagnostics.test.mjs` | Create | 10 个用例：合法 ping（generic/coding 成功、wire 与成功结果不变）、缺 session、缺 ctx.cwd、cwd 不符、capability 缺失、generic 早抛 `assertSpawnAllowed`、generic 无 capabilities envelope、ping 失败不补造投影、0600 trace 文件端到端；全部断言不调用 spawn、不补 ping、诊断面无 canary/禁止键 |
| `test/subagent-dispatch-startup-probe.test.mjs` | Modify（只追加） | 追加 4 个用例：sink 只落盘白名单 negotiation（12 种投毒/畸形全丢）、0600/O_NOFOLLOW/inode/dispose 门禁不变、真实 sink→`readBoundedDispatchTrace` 正例、probe 对未知键/畸形 nested/stage 非枚举/canary 的 21 条负例；既有 4 个用例与断言未改 |
| `scripts/probes/subagent-dispatch-startup.ts` | Modify（主管追加授权） | consumer 同步：`ALLOWED` 精确纳入 `stage`/`negotiation`；`STAGES` 固定枚举；`validNegotiation()` 按 D0 `rpc-negotiation-diagnostic.v1` 固定键集/枚举/布尔/capability 名严格校验，negotiation 只允许出现在 `tool-failed`；未知值一律 `invalid-schema`。version/身份/phase/单调钟/window/maxBytes/maxRecords/outputBudget 与 `invalid-*` 码全部保持 |
| `docs/plans/records/2026-10-15-runtime-closeout/rpc-diagnostics.md` | Create | 本记录 |

**未触碰**（读 only，含 D0 owner 文件）：`packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts`、
`test/subagent-diagnostic-projection.test.mjs`、`errors.ts`、`rpc-client.ts`、`supervisor-control-plane.ts`、
`supervisor-consumption.ts`、`extensions/subagent-runtime.ts`、resume/tools 拆分、AGENTS/guidance/steer gate、
package manifest/exports/tsconfig。未 stage/commit/stash/reset/push；未启动 Host；未联网；未安装依赖。

## 2. D0 独立复验（不假设上一轮 runtime green）

上一轮 D0 汇报被截断，补报的 run `3d2a0f56` 又被 runtime 以 “Structured acceptance report not
found” 拒绝，因此本任务不采信任何转述结论，先自行复验 D0：

1. **源码级接口核对（槽前完成）**：`diagnostics.ts` 实际 exports =
   `projectRpcNegotiation(result, expectedCwd, dispatchPath)`、`projectSupervisorTrace(entry, monotonicMs)`、
   `projectSupervisorReceipt(receipt)`，类型 `RpcNegotiationDiagnosticV1`、`RpcNegotiationDispatchPath`、
   `RpcNegotiationDispatchPathProjection`、`SupervisorTracePhase`、`SafeSupervisorTraceV1`、
   `SupervisorReceiptStatus`、`SupervisorReceiptDiagnosticV1`；模块无 import、无 IO/emit/fetch；
   输出 `Object.freeze`。`test/subagent-diagnostic-projection.test.mjs` 顶层 `test(` 静态计数 = 35。
2. **runtime 复验（获槽后第一件事）**：见 §5 命令表第 1 行。
3. **未改 D0 owner 文件**：`git diff --name-only` / `git status --short` 证据见 §5；两文件仍为
   D0 交付时的内容（`diagnostics.ts` 为 untracked 新文件，本任务未写入）。

D0 偏差处置约定：若 runtime 复验出现 fail 或接口与上述不符，立即停止消费并 `contact_supervisor`。

## 3. 实现取舍与不变量

- **准入权威不变**：`assertSpawnCapabilities` 的判定顺序（4 个安全 capability → `rpc:v1/session`
  复合条件）、`code=CAPABILITY_NEGOTIATION_FAILED`、message 文案、`missingCapabilities`、
  `upgradeStopped` 全部原样；投影只在**失败**分支计算，成功路径零额外开销、零新增字段。
- **generic 早抛合并**：`negotiatedCapabilities?.assertSpawnAllowed()`（rpc-client.ts:117）抛出的错误
  只带 `code/operation/missingCapabilities/upgradeStopped`，`createSubagentRpcFailureDetails` 的
  `RPC_DIAGNOSTIC_FIELDS` 白名单会丢弃 `error.detail`。按计划在 **同一 catch** 合并已验证投影，
  未改 `errors.ts`；合并值来自本次调用的 `trace.rpcNegotiation`，不是重新 ping、不是 raw 回包。
- **不造缺失 ping**：`trace.rpcNegotiation` 只在 `rpc.ping()` 成功返回后赋值。ping 超时/协议错误时
  保持 `undefined`，catch 不附 `negotiation`（负例见测试「ping 失败」）。
- **trace 只白名单 negotiation/stage**：sink 对 `tool-failed` 之外的 phase 忽略该字段；对 negotiation
  先做键集校验（白名单外任一键 → 整条丢弃），再逐字段重建，绝不展开原对象，因此 `error.detail`
  的任意 JSON 无法透传。`0600`/`O_NOFOLLOW`/`uid`/inode 复核/`dispose` 幂等门禁一字未改。
- **wire 与成功结果不变**：RPC spawn/ping 参数、`diagnostic` 不入 wire、成功 details 字段集均未变
  （测试断言 `diagnostic/sink/toolCallId/negotiation/agent/task` 不出现在 wire spawn 参数）。
- **consumer 同步（授权追加）**：`stage` 合法值取自 producer 实际写入点的并集——
  `extension.ts` 的 `trace.stage`（`preallocate`/`rpc-ping`/`workflow-spawn`/`child-binding`/
  `grant-registration`/`bind-run`，extension.ts:894,903,908,948,966,993,1025,1109,1112,1140,1160,1181）与
  `errors.ts` `SUBAGENT_RPC_STAGES`（同集合去掉 `grant-registration`，且非法值回落 `workflow-spawn`）。
  probe 侧不做「未知即接受」，也不放行任意嵌套对象；probe 保持 import-free，未深引 package 内部
  生产模块，未把生产实现搬进 `scripts/`。

## 4. 数据来源分类（AGENTS.md 缺陷门禁）

| 现象 | 分类 | 依据与处置 |
| --- | --- | --- |
| probe `readBoundedDispatchTrace` 对含 `negotiation` 的 `tool-failed` 记录整文件 fail closed（`invalid-schema`/`cause=unproven`） | **类别 1：预期 production 数据未被正确处理** | producer 是本仓合法入口：`extensions/subagent-runtime.ts:239` 在 `PI_SUBAGENT_DISPATCH_TRACE_FILE` 存在时 `diagnosticSink = createSubagentDispatchTraceFileSink()`，sink 白名单写入该字段；consumer 是 `scripts/probes/subagent-dispatch-startup.ts` CLI。身份/时间/资源事实均有效，非手拼 fixture。处置：主管授权同批修复 consumer（精确白名单），不新增 production 兼容/放宽分支 |
| probe 之前就已无法读取带 `stage` 的 `tool-failed` 记录 | **类别 1（既有、单列）** | `stage` 由 `createSubagentRpcFailureDetails` 原字段经 sink 白名单写入，本次改动之前就存在于 RPC 失败记录；probe `ALLOWED` 未含 `stage`。这是既有 producer/consumer 不一致，**不是本批引入**，也不冒称已复现的现场故障（无用户现场样本、无历史 trace 文件）。处置：同批纳入固定枚举校验 |
| 新增测试中的失败注入（缺 session/cwd 不符/capability 缺/投毒 negotiation/畸形 stage） | **类别 2：测试矩阵** | 全部经公开入口（`createTypedSubagentExtension` 的 `tool.execute`、`createSubagentDispatchTraceFileSink`、`projectRpcNegotiation`）构造，未手拼 projection/event、未绕过 public 入口 append、未使用非法时间。只用于证明新诊断投影的白名单与 fail-closed 行为，不作为任何 production 根因证据 |
| 历史 RPC/supervisor 个案（`docs/bugs/2026-10-10-rpc-session-capability-negotiation.md`） | 仍 **blocked-evidence** | 本任务只交付「未来可诊断性」；未读取用户 session/authority/凭据，未声称修复 session 丢失或任何历史故障根因 |

## 5. 实际命令与结果（unit-runner 独占槽内，Node v26.8.1）

| # | 命令 | exit | 计数/输出 |
| --- | --- | --- | --- |
| 1 | `node --test test/subagent-diagnostic-projection.test.mjs`（D0 独立复验，获槽后第一件事） | 0 | **35 tests / 35 pass / 0 fail / 0 skipped / 0 todo / 0 cancelled**，duration 86ms。与静态计数 35 一致，与上一轮被 runtime 拒绝的补报声称（35/35）一致；**本行为本任务实跑证据，不采信转述** |
| 2 | `node --test test/subagent-rpc-diagnostics.test.mjs test/subagent-dispatch-rpc.test.mjs test/subagent-dispatch-startup-probe.test.mjs` | 0 | **36 tests / 36 pass / 0 fail / 0 skipped / 0 todo**，duration 149ms（rpc-diagnostics 10 新用例、dispatch-rpc 18 既有用例、startup-probe 4 既有 + 4 新增）；首次运行即全绿 |
| 3 | `npm --prefix packages/pi-subagents-enhanced run typecheck`（`tsc --noEmit -p tsconfig.json`） | 0 | 无诊断输出。修正了 D2 并行时报出的 extension.ts 11 条 `unknown` 属性错误（改为就地窄化 `const projection = value as Record<string, unknown>`，未改共享 `isRecord()`） |
| 4 | `node_modules/.bin/tsc --noEmit --ignoreConfig --allowImportingTsExtensions --module NodeNext --moduleResolution NodeNext --target ES2024 --skipLibCheck --types node scripts/probes/subagent-dispatch-startup.ts` | 1 | 仅 1 条错误：`(60,33) TS18046: 'entry.monotonicMs' is of type 'unknown'`。**预先存在证据**：`git show HEAD:scripts/probes/subagent-dispatch-startup.ts` 写到 `/tmp/d1-probe-head/probe-head.ts` 后同一命令报同一错误（HEAD 行号 28），即本任务修改**新增 0 条类型错误**；该文件不在任何 tsconfig include 内，因此从未被标准 typecheck 覆盖。未自行修复（授权仅限 stage/negotiation schema，且该行属于“单调钟”保持项），已列入残留风险 |
| 5 | `git diff --check` | 0 | 无空白/冲突标记错误 |
| 6 | `git diff --cached --name-only` / `git status --short` | 0 | staged 文件数 = **0**；本任务只命中 5 个写路径（extension.ts、probe、两个测试、本记录）；`errors.ts`/`rpc-client.ts` 未出现在变更列表 |
| 7 | D0 owner 文件未改证据：`stat -f "%Sm %N"` | 0 | `diagnostics.ts` mtime `2026-10-15 19:17:54`、`test/subagent-diagnostic-projection.test.mjs` mtime `2026-10-15 19:18:08`（D0 交付时点）；本任务文件 mtime 均 ≥ `20:30`，当前时间 `20:48` |
| 8 | 额外回归（同一 unit 槽，因本任务改了共享的 extension.ts）：`node --test test/subagent-runtime-membrane.test.mjs test/subagent-spawn-rollback.test.mjs` | 0 | **100 tests / 100 pass / 0 fail / 0 skipped**，duration 1656ms；覆盖 `CAPABILITY_NEGOTIATION_FAILED` fail-closed、coding 成功 details deepEqual、回滚/stop 语义 |
| 9 | 额外回归：`node --test test/subagent-dispatch-extension.test.ts` | 0 | **36 tests / 36 pass / 0 fail / 0 skipped**，duration 693ms；覆盖 ping→prepare→spawn 顺序、wire 参数与 resolver 元数据 |

未跑条款：`npm run verify:subagents-enhanced` 与 `test/pi-subagents-enhanced-package.test.mjs`（需 `npm pack pi-subagents@0.75.0`，网络门禁未授权，属 N1）、全仓 `npm test`/all-integration glob、`npm run typecheck:root`（本任务未改 root tsconfig 覆盖的 production 文件；probe 不在 include 内，已由命令 4 显式覆盖）、任何真实 Host/PTY/CLI/provider/网络运行。本轮未执行额外的 parentSessionId 探针观察（主管裁定：不为此拖延，静态记录即可）。

## 6. 未纳入的其余既有 trace 字段（精确列出，未自行扩大范围）

主管明确要求：本次 probe 专项不要求消费全部无关事件。以下为静态核对到的其余 producer 字段/记录形态，
本次**未**纳入 probe 白名单，也未改 producer：

1. `timestamp`（`grant-created`/`grant-failed` 由 extension.ts:996,998,1002 写入，sink 白名单已放行）
   → probe `ALLOWED` 未含 `timestamp`。
2. phase `grant-created`/`grant-failed`（sink `TRACE_PHASES` 含，extension.ts:128-132）
   → probe `PHASES` 未含这两个 phase。
3. working-state 记录（`hostSessionId`/`completionOwnerId`/`event`/`source`/`ownershipDecision`/…，
   sink 第二分支，extension.ts:238-253）→ probe 只消费 dispatch trace 形态，不消费 working-state。
4. supervisor 诊断包络（`reportSupervisorDiagnostic`，extension.ts:1231）→ 属 D3 接线范围。
5. `parentSessionId` 仅在 `assertSpawnCapabilities` 成功后才被 trace 闭包附加
   （extension.ts:911,1124），因此真实文件里 `tool-entered`/`agent-discovery-*` 记录缺该字段，
   而 probe `validate` 要求每条记录都有非空 `parentSessionId`（否则 `invalid-identity`）。
   本次未改（授权仅限 stage/negotiation），列为残留风险与后续项。**证据类型：仅静态代码阅读**
   （主管裁定本轮不另开探针验证，因此未运行复现）。

## 7. 残留风险与未验边界

- **历史个案仍 blocked-evidence**：新诊断只让**未来**失败可归因；不证明任何既有故障已修复。
- **probe 预先存在的类型错误未修**：`scripts/probes/subagent-dispatch-startup.ts:60` 的
  `TS18046 'entry.monotonicMs' is of type 'unknown'` 在 HEAD 已存在（命令 4 证据）；该文件不被任何
  tsconfig 覆盖，无运行时影响（前一行 `Number.isSafeInteger` 已先判定），但属于潜在债务，需单独授权修复。
- **第 6 节 1–5 项**：真实 trace 文件若包含 grant/working-state/supervisor 记录或缺 `parentSessionId`
  的早期记录，probe 仍会整文件 fail closed（安全方向，但诊断可用性受限）。修复需另行授权。
- **probe 与 sink 的白名单是两份实现**：probe 按主管裁定保持 import-free（不深引 package 内部生产
  模块），因此 `validNegotiation` 与 extension.ts `safeRpcNegotiationDiagnostic` 是同一合同的两个独立
  实现；D0 schema 若升级（v2），两处都需同步，否则 consumer 会 fail closed。已在两侧注释标明来源。
- **negotiation 只覆盖 ping 阶段事实**：不含 spawn 回包、leaf 绑定或 terminal proof 的诊断；
  `SPAWN_REPLY_INVALID`/`WORKFLOW_CHILD_START_FAILED` 等失败仍只有既有 code/stage 级信息。
- **未验证真实 Host/真实 pi-subagents 0.75.0 端点**：全部经本地 fake RPC；真实 0.71+ 对象型
  capability 形态由既有 `test/subagent-dispatch-rpc.test.mjs` 与 D0 投影测试覆盖。

## 8. 交接给 D3 的具体载体（exports / 函数 / 接点）

- **trace sink（唯一）**：`createSubagentDispatchTraceFileSink(file = process.env.PI_SUBAGENT_DISPATCH_TRACE_FILE)`
  —— `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:198` 导出。内部三分支：
  `TRACE_PHASES` 记录分支（extension.ts:224-237，含 D1 新增的 `negotiation`）、`WORKING_STATE_EVENTS`
  分支（extension.ts:238-253）、其余 `undefined`（丢弃）。D3 新增 supervisor 分支时应作为**独立白名单分支**，不要复用/放宽
  negotiation 白名单，也不要放行任意 `error.detail`。
- **嵌套白名单载体**：`safeRpcNegotiationDiagnostic(value)`（extension.ts:162，模块内私有、未导出）
  —— 键集 fail closed + 逐字段重建的写法可直接照搬为 D3 的 `projectSupervisorTrace` 包装载体。
- **D0 可复用投影**（owner：D0，勿改）：`projectSupervisorTrace(entry, monotonicMs)`（phase/type 双形状、
  9 类枚举、包络补 version/clock）、`projectSupervisorReceipt(receipt)`、`projectRpcNegotiation(...)`
  —— `packages/pi-subagents-enhanced/src/subagent-dispatch/diagnostics.ts`。
- **既有 supervisor 诊断 producer 入口**：`reportSupervisorDiagnostic(diagnosticSink, entry)`
  （extension.ts:1231）；调用点含 `supervisor-registration-failed`（extension.ts:1770）、
  `compensateSupervisorDelivery`（extension.ts:1238-1251）。
- **每次调用的 trace 闭包**：`execute()` 内 `trace`（函数对象，携带 `toolCallId`/`stage`/
  `parentSessionId`/`rpcNegotiation` 属性；extension.ts:1671-1684）。D1 用它做「同次 ping 局部携带」，
  D3 若需携带 supervisor 事实应新增独立属性，不复用 `rpcNegotiation`。
- **consumer CLI**：`readBoundedDispatchTrace({file, parentSessionId, toolCallId, maxBytes, maxRecords, windowMs, outputBudget})`
  —— `scripts/probes/subagent-dispatch-startup.ts` 导出；白名单常量 `PHASES`/`STAGES`/`ALLOWED`/
  `validNegotiation`。D3 若新增 supervisor 记录形态，必须同步该 CLI，否则复现本任务 §4 的类别 1 缺口。
