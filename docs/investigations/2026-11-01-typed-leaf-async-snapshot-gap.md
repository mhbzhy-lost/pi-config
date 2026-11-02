# 2026-11-01 typed workflow leaf 未进入上游 asyncSnapshot 缺口——受控诊断报告

- 事故：2026-11-01 18:44:12 CST，根会话 `var/sessions/2026-11-01T10-12-25-019Z_01a19698-973b-71e6-8124-4b618a380e91.jsonl` 对 running 中的 typed dispatch leaf `4595239d-485a-4dd7-ae33-23c33e03ce01` 调 `subagent_run_steer({id, index:0})`，约 20ms 内返回 `SUPERVISOR_STEER_NOT_ALLOWED`；18:44:49 `subagent_run_status` 显示 `Active async capacity: 0`、asyncSnapshot 无 leaf；leaf 磁盘 `state=running` 直至 18:50:56 才 complete。
- 本报告为只读诊断产出：不修改任何 production 代码与既有测试；全部实验脚本见 `scripts/probes/typed-leaf-snapshot-*.ts`。
- 诊断结论一句话：**缺口未能在受控实验中复现**（4 类装载链生命周期变体全部正常登记 leaf）；但实验把断点要素收敛到了唯一剩余族——「上游 tracker 登记链路本身在所有受控形态下均正常，缺口的可变因子只能位于 Host 进程长生命周期内的会话身份/上下文陈旧窗口」，其中最强候选是 asyncSnapshot 的 session-guard（详见 §6），并给出外围（enhanced 层）修复点（§7）。

## 1. 数据来源分类（根目录 AGENTS.md 三类门禁）

初判维持 **第 1 类：预期 production 数据未被正确处理**。分类证据：

- 实际入口：根会话（交互式 TUI Host）经 typed 工具 `subagent_start` 派发（公开 typed 入口），非测试制造；
- 权威身份：leaf `status.json` 的 `sessionId` 即根会话 sessionFile（`$TMPDIR/pi-subagents-uid-501/async-subagent-runs/4595239d-485a-4dd7-ae33-23c33e03ce01/status.json`，已核对），`parentWorkflowRunId=c62a0520-8208-4332-8af3-00a896a24105`、`workflowKey=typed-e98a346e-c207-4bed-9250-a3e032bff749` 与 facade 目录一致；
- 事件/资源顺序：facade `events.jsonl`（`subagent.workflow.started` ts=1793529245944 → `subagent.workflow.completed` ts=1793529245996）与 leaf startedAt=1793529246310（runner 侧初始 status 写入）构成正常「facade 起 → 脚本 runs.run → leaf 派发 → facade 收尾」顺序；leaf runner pid 6863 独立存活 16 分钟；
- 与 production 事实的差异：本报告的受控复现尝试失败（§4），即「production 可达」在受控环境未被重放成功；按门禁要求，在补足 §6/§8 的生产侧证据前，禁止任何 production 兼容分支或 fallback 改动，本报告也确实未做任何代码改动。

## 2. 生产现场复核（只读磁盘证据）

以下均在只读条件下复核，与任务交接事实一致，另补充三点新证据：

1. **Host 进程跨会话史**：`$TMPDIR/pi-subagents-uid-501/async-subagent-runs/*/status.json` 中 `pid=25058` 的 run 覆盖 2026-11-01 01:37–19:09，且 sessionId 横跨 `2026-10-31T17-36-11-734Z_*` 与 `2026-11-01T10-12-25-019Z_*` 两个会话文件——即生产 Host 是长生命周期进程，在 ~18:12 前后从 10-31 会话切换（resume/switch）到 10-12-25 会话后继续派发。10-12-25 会话的派发序：18:12:56（bd4c7d67/ac089f33，正常 complete）、**18:34:05（c62a0520/4595239d，事故）**、18:52:44、19:09:59。
2. **facade pid=25058 即 Host 进程**：受控实验中 facade `subagent:async-started` 事件的 `pid` 恒等于 Host 进程 pid（探针 `probe-session-start` 与 facade 事件 pid 相同），证实 workflow facade 的 emit（上游 `runs/foreground/subagent-executor.js:5257`，`pid: process.pid`）与 leaf 的派发执行都发生在 **Host 主进程**，不在 runner。
3. **根会话时间线**：`10-12-25` 会话 jsonl 共 284 行、无 compaction 记录；18:32:05 用户消息「直接执行吧」触发 18:34 派发；18:44:42「为什么拒绝，有拒绝原因吗」即 steer 拒绝追问。10:12 创建至 18:12 首条用户消息之间会话空转（文件创建早于首条消息 8 小时）。

## 3. 已定位的事实链（实验证实 + 代码路径）

| 要素 | 结论 | 证据 |
| --- | --- | --- |
| leaf started 事件 emit 点 | 上游 `runs/background/async-execution.js:2091`（`mode:"single"` 路径，含 `parentWorkflowRunId`/`workflowKey`），在 **Host 主进程** 同步 emit | 实验中 leaf 事件 payload 形状（mode/agent/workflowKey/parentWorkflowRunId）与该 emit 点字段集一致；:1502 是 chain 路径、subagent-executor.js:5257 是 facade（`agent:"workflow"`），均与 leaf 事件不符 |
| payload 实际 sessionId | 恒等于 Host 会话 sessionFile（多轮实验 `sessionId === knownSessionFile`），与生产 leaf status.json 一致 | 探针 `probe-events.jsonl` 全量记录 |
| 事件投递路径 | membrane `events.emit` 透传（仅 decorateLifecycle 加 title）→ 真实 Host EventBus；collector（typed 层直连真实 bus）与探针均收到 | `runtime-membrane.ts:121-125`；实验中 dispatch 回执的 leafRunId 即 collector 匹配结果 |
| 上游 tracker 逻辑 | `handleStarted`（`async-job-tracker.js:759-780`）唯一过滤是 `info.sessionId !== state.currentSessionId`；登记与 snapshot 同源 | 既有单元实验 `var/tmp/probe-tracker.mjs` + 本轮真实链实验一致 |
| facade 在册机理 | facade 由 executor **进程内直接** `deps.state.asyncJobs.set(workflowRunId, ...)`（`subagent-executor.js:5240-5243`），不经 asyncStartedHandler | 代码路径 + 实验中 reload 后 asyncJobs 清空但新 facade 仍即时出现 |
| EventBus 吞错 | pi Host EventBus 以 `safeHandler` 包裹全部 handler（`core/event-bus.js`），异常只 console.error 不中断 emit | 实验全程 stderr 无 `Event handler error` |
| snapshot 投影语义 | running 的 leaf（即使其 facade 已 complete）是 live root，出现在 `asyncSnapshot.runs[]` 顶层；完成后被折叠进父节点或丢弃 | `async-status-projection.js:250-256`（keepLiveRoot）+ 实验采样序列 |

## 4. 受控实验（可重复执行，均未复现缺口）

全部实验：真实 pi `1.4.0`（`PI_REAL_BIN`，unbundled `dist/cli.js`）+ 真实 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` 装载链 + fake/deterministic provider 驱动 `subagent_start → subagent_run_status → subagent_run_steer` 工具序列；bus 观察扩展记录 `subagent:async-started` payload、session_start reason，并经 `subagents:rpc:v1` 直连上游 rpc bridge 采样 in-memory asyncSnapshot（targeted/untargeted）。

| 探针 | 形态 | 结果 |
| --- | --- | --- |
| `scripts/probes/typed-leaf-snapshot-gap.ts` | fresh Host（RPC 模式），单次 typed 派发，leaf running 期间观测 | `In-memory subagent status: 2 active children`（facade+leaf 均在册），steer 放行（`Steering scheduled ...`）。**不复现** |
| `scripts/probes/typed-leaf-snapshot-session-switch.ts` | 会话A 派发基线 → `new_session`（reason=new, previousSessionFile）→ 会话B 派发观测 | B leaf 在册（2 active）、steer 放行。**不复现** |
| `scripts/probes/typed-leaf-snapshot-reload.ts` | PTY TUI（python pty relay）真实 `/reload`（session_shutdown reload → 重装载 → session_start reload）；leaf 完成后 reload 与 leaf running 中 reload（`PROBE_RELOAD_AFTER_LEAF_COMPLETE` 控制） | running leaf 经 `restoreActiveJobs` 从磁盘重建进 snapshot（`after-reload+1500/3000/5000/8000` 采样均在册）；reload 后新派发也登记。**不复现** |
| `scripts/probes/typed-leaf-snapshot-resume.ts` | 会话A 基线 → new_session B 基线 → `switch_session` 回 A（reason=resume，生产 18:12 形态）→ A 内派发观测 | resume 后 leaf 事件 sessionId=A 文件、untargeted snapshot 含 running leaf（`session-resume` 采样）。**不复现**（注：该探针 phase-C 的 status/steer 工具序列受恢复会话历史 toolResult 干扰，观测以探针 rpc 采样为准；脚本会带 `error` 字段退出，属 fixture 限制，见 §8） |

与生产的差异（如实列出，不复现的可能解释面）：
- 生产 Host 为交互式 TUI、运行 ~25h、累计 50+ 次派发、两次会话替换之间相隔 8h；受控 Host 生命周期分钟级。
- 生产 18:34–18:44 之间的 10 分钟 Host 内部事件不可回溯（无 dispatch trace / workingStateTrace 采样落盘）。
- 受控环境 fake provider 的子代理回合时序与真实模型不同（但登记链路时序与之无关：登记发生在派发 emit 时刻）。

## 5. 假设逐项判定

- **H1（enhanced 延迟订阅激活失败）**：受控证据不支持「激活从未发生」——dispatch 依赖的 rpc bridge 订阅与 asyncStartedHandler 同属一批 deferred subscriptions（`extension.ts:2746-2753` capture → `:2797-2801` 或 `:2868-2876` activate），dispatch 成功即证明该批订阅在派发时刻已在 bus 上。reload 变体（hiddenOwnership 触发路径）也未观察到缺口。
- **H2（leaf 事件 emit 点/进程与 collector 不同）**：**证伪**。emit 点为 `async-execution.js:2091`、Host 主进程、与 collector 同一真实 bus（§3）。
- **H3（sessionId 瞬时不一致）**：受控证据不支持——多轮实验 payload sessionId 恒等于 Host sessionFile，且登记过滤与事件 sessionId 同源（`subagent-executor.js:6282` rememberParentModel 用派发 ctx 写 `state.currentSessionId`）。但注意：该一致性依赖「派发 ctx 与 tracker 状态同源」，长生命周期会话替换后的混合陈旧窗口未被排除（见 §6-M2）。
- **H4（handleStarted 中途异常被吞）**：无证据——全部实验 stderr 无 `Event handler error`；且 pi EventBus 的 safeHandler 会吞异常不中断 emit，若发生必留 console.error 痕迹（生产侧该痕迹不可回溯）。

## 6. 剩余候选机制（按证据强度排序；均未获生产侧闭合证据）

**M1：asyncSnapshot 的 session-guard 在会话身份分歧时整体返回空。**
`asyncStatusSnapshotJobsForState`（上游 `runs/background/async-status-snapshot.js:21-24`）在 `state.currentSessionId !== sessionId` 时直接返回 `[]`——不是「该 run 缺失」而是「整个快照为空」。`rpc.status` 携带的 sessionId 来自 `resolveCurrentSessionId(ctx.sessionManager)`，而该 ctx 是 rpc bridge 的 `getContext: () => state.lastUiContext`（上游 `extension/index.js:602-608`、`extension/rpc.js:592-630`）。在 enhanced Host 中 `state.lastUiContext` 的刷新面收窄为：
1. 上游 `resetSessionState`（session_start 链）——但 enhanced 层把上游 session_start handlers 捕获后**每 Host 进程只执行一次**（`extension.ts:2572` `if (started) return;` + `:2870`，后续会话替换不再运行）；
2. 上游 `tool_result` 监听——**只认 `toolName === "subagent"`**（`index.js:759-763`），而该工具在 enhanced Host 从不注册（`runtime-membrane.ts` registerTool 仅放行 supervisor）。
同时 `state.currentSessionId` 会被每次派发的 `rememberParentModel`（`subagent-executor.js:6282`）改写。两者一旦分源（一个新鲜一个陈旧），targeted status 的 asyncSnapshot 即空 → `runtimeFromStatus`（enhanced `runtime-state.ts:13-25`）取不到 runtime → steer 门（`supervisor-control-plane.ts:299-302`）返回 `SUPERVISOR_STEER_NOT_ALLOWED`，且 untargeted 投影同样显示 0——**与生产 18:44 全部观测吻合，且不需要 tracker 登记链路曾经失败**。
未闭合点（如实声明）：生产 leaf 事件的 sessionId 是新会话文件，说明派发 ctx 新鲜；若派发 ctx 也来自 `lastUiContext` 则两者应同陈旧（自洽无缺口）。要闭合需证明「派发 ctx 与 status ctx 分源」（例如会话替换重建的 extension runtime 新代 vs 旧代 state 混用），这需要生产侧下次复发时的现场采样（§8）。

**M2：会话替换/重装载代的 shutdown-debt 竞争导致旧代 state 与新代订阅/上下文交错。**
pi 的 `newSession/switchSession/reload` 都会重建 extension runtime（`agent-session.js:2998+` reload 流、`agent-session-runtime.js:141/165/291` 各 reason）；enhanced 层每次装载都进入 `installHeadlessTypedSubagentRuntime` 的 debt/hiddenOwnership 判定（`extension.ts:2697`）。受控实验中所有代际迁移均正常，但竞争窗口（旧代 debt 未清偿时长）随负载增大，未能在分钟级受控 Host 内触发。

**M3（弱）：生产 18:34–18:44 之间存在一次未留痕的 reload/会话事件**，使登记后的 asyncJobs 被新代清空且 `restoreActiveJobs` 因身份分歧未恢复——受控 reload 实验证实「running leaf 会被 restore」，故 M3 需叠加 M1 式身份分歧才成立。

## 7. 外围修复点建议（仅 enhanced 层，不改 `packages/pi-subagents-enhanced/node_modules/**`）

1. **steer 门运行时判定增加磁盘佐证（首选）**：`extensions/subagent-runtime.ts` 的 `readRuntime`（现仅 `rpc.status({id})` → `runtimeFromStatus`）在 asyncSnapshot 无该 run 时，读 run 目录 `status.json`（enhanced 层多处已信任的磁盘事实）做二次判定：磁盘 `state=running` 且 pid 存活时按 running 处理（或至少把「snapshot 为空 vs run 不在册」区分进拒绝 details）。这直接消解 M1/M3 对 steer 的杀伤，且不依赖上游快照的 session-guard 语义。
2. **enhanced 层自持 leaf 登记**：`root-broker-server.ts` 的 `observeStarted` 已在同一 bus 收到全部 leaf started 事件（生产已证实 ownerState=owned 即其登记）；可把 runId→{asyncDir, sessionId, pid} 的登记提升为 readRuntime 的兜底来源（与建议 1 同向，事件源而非磁盘源）。
3. **诊断增强（为下次复发闭合 M1/M2）**：生产打开 `PI_SUBAGENT_DISPATCH_TRACE_FILE`（0600 预建文件）与 `workingStateTrace` sink；在 enhanced 层 `readRuntime` 拒绝路径补一条既有 diagnosticSink 记录（snapshot 空时附 `state.currentSessionId` 不可得，但可记录 snapshot.runs 数与磁盘 state），使下一次 `SUPERVISOR_STEER_NOT_ALLOWED` 可归因。
4. 风险与边界：建议 1/2 属于「外围对上游快照空缺的兜底」，按三类门禁须先有 M1/M2 的生产侧证实（§8 证据）才可进入修复实现；在证实前仅建议 3（纯诊断）可先行。报告本身不包含任何上述改动的代码。

## 8. 复现/验证命令与 failing test 草稿

探针（均可直接运行，需 `PI_REAL_BIN` 或仓库 `node_modules/@earendil-works/pi-coding-agent`）：

```bash
node scripts/probes/typed-leaf-snapshot-gap.ts            # fresh 基线（预期：leaf 在册、steer 放行）
node scripts/probes/typed-leaf-snapshot-session-switch.ts # new_session 变体
node scripts/probes/typed-leaf-snapshot-reload.ts         # /reload 变体（PTY；PROBE_RELOAD_AFTER_LEAF_COMPLETE=1 切换 reload 时机）
node scripts/probes/typed-leaf-snapshot-resume.ts         # switch_session 回既有会话（resume）变体
```

判定口径：`reproduced === true` 当且仅当「leaf 磁盘 state=running 期间，targeted/untargeted asyncSnapshot 均不含该 leaf」；本轮四变体均 `false`（如实报告，不伪造复现）。

**failing test 草稿**（复现断言；按任务约束只入报告，不新建测试文件，归属后续修复任务）：

```js
// test/subagent-async-snapshot-leaf-registration.integration.mjs（草稿）
// 守卫目标：typed workflow leaf 处于 running 时，rpc.status 的 asyncSnapshot 必须包含该 leaf
// （生产 2026-11-01 事故的反向断言；当前在全部受控变体下通过，失败即缺陷复发）。
test("typed workflow leaf stays in the upstream asyncSnapshot while running, across host lifecycle events", async (t) => {
  const host = spawnRpcHost(piBinary, [/* 同 typed-leaf-snapshot-gap.ts 的装载参数 */], { /* 同探针 */ });
  // 1) 派发并等待 leaf started（collector 回执）。
  const dispatch = await waitForToolEnd(host, "subagent_start");
  const leafRunId = dispatch.result.details.runId;
  // 2) leaf running 期间，探针经 subagents:rpc:v1 请求 status（untargeted + targeted {id: leafRunId}）。
  const untargeted = await probeRpcStatus(host);          // → reply.data.asyncSnapshot.runs
  const targeted = await probeRpcStatus(host, { id: leafRunId });
  assert.equal(readLeafDiskState(dispatch.result.details.asyncDir), "running");
  assert.ok(untargeted.runs.some((run) => run.id === leafRunId),
    "leaf must be a live root in the in-memory snapshot while running");
  assert.ok(targeted.runs.some((run) => run.id === leafRunId),
    "targeted status must attach a snapshot containing the running leaf (steer gate source)");
  // 3) 生命周期变体矩阵：对 new_session / switch_session(resume) / /reload(leaf running 中)
  //    各重复步骤 1-2（参数化 hostLifecycle 阶段，见 scripts/probes/typed-leaf-snapshot-*.ts）。
  // 4) steer 等价断言：subagent_run_steer({id: leafRunId, index: 0}) 在 ownerState=owned 时
  //    不得因 runtime 缺失返回 SUPERVISOR_STEER_NOT_ALLOWED。
});
// 单元层草稿：runtimeFromStatus 的快照缺失分支应消费磁盘佐证（对应 §7-1 修复）：
// assert.equal(runtimeFromStatus(runId, { details: { mode: "single" }, asyncSnapshot: { runs: [] } }).running, undefined); // 现状
// 修复后（外围兜底）期望：readRuntime 在磁盘 state=running 时返回 { running: true, steerable: true }。
```

## 9. 结论

- 受控实验未能复现缺口（4 变体、leaf 均正确登记），按停止条件如实报告；复现参数与差异见 §4。
- 断点要素已收敛：emit 点（`async-execution.js:2091`，Host 主进程）、payload sessionId（Host sessionFile）、bus 投递（真实 EventBus，多方收到）均证实；H2 证伪，H1/H3/H4 无受控证据支持。
- 生产矛盾（事实 4/5/6）在「tracker 登记链路正常」前提下唯一自洽的解释族是 §6-M1/M2/M3：登记可能从未缺失，缺失的是 **asyncSnapshot 投影的会话身份一致性**（session-guard 空快照）或代际迁移竞争；该解释需生产侧下次复发时的 §7-3 采样闭合。
- 后续动作建议：先落 §7-3 诊断增强；M1 获生产证据后再实现 §7-1/7-2 外围兜底；全部改动均不触碰 `packages/pi-subagents-enhanced/node_modules/**`。

## 10. 修复记录（2026-11-01，dispatch-8090fa4b）

### 10.1 精确触发条件

steer 门的 `readRuntime`（原仅 `rpc.status({id})` → `runtimeFromStatus`）在以下条件同时成立时把 running 中的 typed leaf 误判为非 running，导致 `SUPERVISOR_STEER_NOT_ALLOWED` 误拒（2026-11-01 18:44 生产事故）：

1. 上游 `rpc.status` 的 `asyncSnapshot.runs` 不含目标 run（session-guard 在 `state.currentSessionId !== sessionId` 时整体返回空快照，见 §6-M1；或缺源场景：`rpc.status` 本身抛错/解析为 `undefined`）；
2. `status.details` 无显式 `state` 字符串（即非 running 判定依据是「证据缺席」而非「证据否定」）；
3. 与此同时 Root Broker 已在册该 run（`observeStarted` 在同一真实 bus 收到 leaf started 事件并登记，生产已由 `ownerState=owned` 证实）且未接受 terminal proof。

关键点：第 1 类条件与「tracker 登记链路正常」可以同时成立——登记从未缺失，缺失的是投影的会话身份一致性；而 broker 的生命周期登记不受上游 session-guard 影响，因此可作为第二判定源。

### 10.2 修复点行号

- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
  - :22 新增 `createSupervisorRuntimeReader` 导入；
  - :608-616 原 `readRuntime` 内联实现（原 :608-618）替换为工厂调用（注释 :608-610、调用 :611-616），`brokerReady`/`broker`/`diagnosticSink` 均以 getter 注入以保持对 host 内可变状态的既有闭包语义。
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-runtime-source.ts`（新增，双源判定唯一实现处）
  - :77 `brokerLifecycleView`：组合既有只读导出面 `inspectExecutionProof`（owned）/`inspectFacadeTerminalProof`（facade），不新增 broker 写面；
  - :102 `brokerViewSaysRunning`：在册（owned/facade 均可）且无 observed terminal proof 且无 terminalConflict；
  - :113 `primaryStatusExplicitTerminal`：state 提取顺序与 `runtimeFromStatus` 完全一致（`details.state` 优先，其次快照投影 state），仅当成功取得非 running 字符串时判「显式终态」；
  - :121 `summarizePrimarySource`：诊断白名单摘要（statusOk/running/steerable/explicitState/snapshotRunCount/projected）；
  - :141-199 `createSupervisorRuntimeReader`：双源判定主逻辑 + `emitDivergence`（:142-145）落 `supervisor-runtime-source-divergence` 诊断。

### 10.3 双源判定语义（与 broker 视图的 running 语义对齐说明）

- **主链判 running：零变化。** 原 `{ ...runtime, ownerGeneration 合并 }` 逐分支保持原语义（含「receipt 的 ownerGeneration 覆盖 details」的既有合并顺序），且不落诊断。
- **主链判非 running 时分两类：**
  - 「显式终态」（`rpc.status` 成功且 state 为 `complete`/`failed` 等非 running 字符串）：上游链明确判出终态，**不经 broker 覆盖**，返回值与现状一致，仅补诊断（`resolvedBy=primary`）；
  - 「缺源」（快照空/不含该 run 且无显式 state，含 `rpc.status` 抛错或解析为 `undefined`）：查询 broker 生命周期登记；在册且无 observed terminal proof 且无 conflict → 按 running 处理（`running: true, steerable: true` + ownerGeneration 合并）；否则维持现有返回。
- **broker 视图 running 语义与上游的差异处理：** 上游 `steerable` 默认=running；本第二源沿用同构语义（`running: true, steerable: true` 成对返回）。broker 的唯一权威终局事实是已接受的 official terminal proof（`acceptTerminalProof` 严格校验，`pollTerminalArtifact` 兑底读盘）：没有 terminal proof 就不做任何猜测性终局推断，因此「已 complete 但 proof 未落」不出现——proof 未落即无终局证据，与「主链缺源」组合时按 running 处理正是上游同构语义；paused/interrupt 等中间态不会与「无 terminal proof 且主链缺源」同时出现（主链若能判出这些状态即有显式 state，归入显式终态类）。owner receipt 读取失败（含 `unknown_run`）不阻止第二源按在册事实放行 running，但 ownerGeneration 读不到就不合并——控制面 owner 围栏（`SUPERVISOR_STALE_OWNER`/`SUPERVISOR_OWNER_UNAVAILABLE`）继续 fail-closed，owner 读失败时 `readRuntime` 返回 `undefined` 的现状语义不放宽（catch 路径仅当缺源发生在 `rpc.status` 时才启用第二源）。
- **诊断：** 凡「走第二源」或「最终仍判非 running」的 `readRuntime` 调用各落一条既有格式条目（`{ version: 1, phase: "supervisor-runtime-source-divergence", runId, primarySource, brokerView, resolvedBy }`，`resolvedBy ∈ primary|broker|null`）；两源分歧字段齐备：snapshot 判定（`primarySource.snapshotRunCount/projected/explicitState/statusOk`）、broker 登记态（`brokerView.registration/terminal/terminalConflict`）、runId。经 `diagnosticSink` 既有通道落 dispatch trace，字段白名单，不含凭据或消息正文；主链判 running 路径不落条目（零噪声）。
- **停止条件核对：** 未修改 `packages/pi-subagents-enhanced/node_modules/**`（上游 pi-subagents 与 pi-coding-agent 均未动）；broker 生命周期视图经既有 terminal proof 机制闭合终局判定，未引入猜测性状态推断；「判 running」场景行为零变化（探针 steer 放行 + 场景 E 双重验证）；工作区既有未提交变更（subagent-runtime.ts 的 managed-resume lineage 改动与 resume-lineage.ts）与本修复改动区间不相交，未覆盖。

### 10.4 验证证据

1. **四探针重跑（全部通过，既有断言不回退；探针 Host 真实加载的扩展即本次改动后的 production 装载链）：**
   - `typed-leaf-snapshot-gap.ts` exit=0：untargeted `2 active children`（facade+leaf 在册）、steer 放行（`Steering scheduled`）、`reproduced=false`；
   - `typed-leaf-snapshot-session-switch.ts` exit=0：B 相 leaf 在册（2 active）、steer 放行、无 `Event handler error`；
   - `typed-leaf-snapshot-reload.ts` exit=0：running leaf 经 reload 后仍在快照（两相 `leafInSnapshot=true`）、steer 放行（`SNAPSHOT_RELOAD_STEER_OK`）；注：相 B 的 child 终态为 fixture 无 acceptance report 导致的 `failed`，属探针自身限制，不影响登记/steer 断言；
   - `typed-leaf-snapshot-resume.ts` exit=0：resume 后新派发 leaf（83d00cd4）在 `session-resume` rpc 采样中 `state=running`（在册）、A/B 相 leaf 在册；相 C 的 status/steer 工具序列仍受 §8 记录的恢复会话历史干扰（steer 序列命中已完成的旧 leaf 被上游正确拒绝），按 §8 口径以 rpc 采样为准。
2. **broker 第二源判定验证（临时脚本 `/tmp/verify-supervisor-runtime-second-source.ts`，真实 `RootBrokerServer` + 真实 `createSupervisorRuntimeReader`，仅 `rpc.status` stub 注入；11/11 通过，临时脚本不留仓库）：**
   - A/D/I（事故形态三变体：status 抛错 / session-guard 空快照 / status 解析为 undefined，facade 在册无 terminal）→ 均 `running=true, steerable=true` 且 ownerGeneration=3 正确合并，诊断 `resolvedBy=broker`；
   - B：`observeTerminal` 接受真实 terminal proof 后 → 维持非 running（`undefined`，不放宽），诊断 `resolvedBy=null` 且 `brokerView.terminal=observed`；
   - C：status 显式 `state=complete` → broker 不覆盖（`resolvedBy=primary`）；
   - E：主链判 running → 返回值与既有实现逐字段一致且不落诊断（零行为变化）；
   - F：owned 在册分支（`inspectExecutionProof` 视图）→ `running=true`；
   - G/H：双源皆缺 → `undefined`；owner receipt 读失败 → 维持现状 `undefined`（不放宽）；
   - J：全部诊断条目字段均在白名单内（version/phase/runId/primarySource/brokerView/resolvedBy）。
3. **类型检查：** `npm run typecheck:root` 与 `npm --prefix packages/pi-subagents-enhanced run typecheck`（即 `tsc --noEmit -p tsconfig.json`）均通过。
