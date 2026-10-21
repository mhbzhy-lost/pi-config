# F8 接管验收：诊断结论为生产链路缺口，不是 fixture 问题

诊断 child：delegate `4c402da1-a1bb-4cfd-a670-301fa54dae6f`（只读；未运行 Host/provider/测试，未联网）。完整原文：async dir `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/4c402da1-a1bb-4cfd-a670-301fa54dae6f`，session `var/sessions/2026-10-17T04-49-51-175Z_01a14831-e247-7044-a36d-676dd611aed1/2ec3121b-2b2a-41ff-b72e-a2369bc1dde5/run-0/session.jsonl`。`P/` = `packages/pi-subagents-enhanced/`。

## 裁决

当前工作区不具备完整的 “handoff → root 调 typed resume → 恢复原 workspace/queue → child 发布” 链路；只改三个验收 fixture 不能声称完成 F8。诊断已触发停止条件，未实施任何改动。

## 链路时序与断点（坐标）

1. child 结束后尝试自动集成：`P/src/workspace/child-integration-lifecycle.ts:27`（`maxAdmissionPolls=3`、`pollDelayMs=25`），`agent_end` 触发、`agent_settled` 仅观察；轮询耗尽后对 queued/admitted/rebasing/prepared 调 `schedule(binding)`。该文件不创建 durable resume intent，也不是严格 75ms 超时器。
2. intent 由 terminal proof 路径创建：`P/src/workspace/coordinator-server.ts:302` `deliverTerminalProof()`，`:327`–`:334`（integration 未完成 → proof pending → `integrationQueue.requestChildResume()` → pump handoff）；`P/src/workspace/integration-queue.ts:117` 持久化 intent、`:147` `promoteRecoverableHead()` 只升 FIFO 队首；intent 类型 `integration-resume-intent.v1`（`P/src/subagent-dispatch/recovery-resume-contract.ts:162`）。
3. handoff 生成：`coordinator-server.ts:287` → `createManualIntegrationHandoff()`（`recovery-resume-contract.ts:56`，`customType: "subagent-integration-handoff"`）。两处协议不一致：(a) intent 用 `sourceRunId`（`recovery-resume-contract.ts:38`，pump 原样展开 `coordinator-server.ts:294`），而 `root-broker-server.ts:1226` 按 `event.runId` 选订阅，缺字段落入 `root-not-subscribed` debt（`:1228`），是否有 sink 转换未验证；(b) `root-broker-server.ts:1224` 输出 `handoff`，但 `root-broker-protocol.ts:426` 字段表无 `handoff` 且 `:440` 用 `exactObject()` 解析。
4. 验收 root provider 只记录不 resume：`test/fixtures/repository-merge-queue-acceptance/root-provider.mjs:49`（发 `pi-root-recovery-event-v1`，无 `triggerTurn`、不转发 handoff），`:87` 起仅按已发 toolCall ID 补发 `subagent_start`。
5. typed resume 未接 activation：`P/src/subagent-dispatch/operation-tools.ts:268`/`:277`/`:360`–`:361`，`P/src/subagent-dispatch/extension.ts:1441` `executeControl()` 校验 message 后调 `rpc[action](params)`，成功分支只取新 run ID 与继承 title；未查询/消费 intent、未调 `activateResume()`、未重绑 workspace/queue。
6. 底层重绑能力齐备但无 typed 调用方：`coordinator-client.ts:99` `activateResume()`（`recovery.activate-resume`）；`coordinator-server.ts:459`（root/intent/activation 校验 → `starting → workspace rebind → queue rebind → activated` → supersede 旧 proof）；`service.ts:250` `rebindRunForRecovery()`；`integration-queue.ts:210` `rebindChildRunForRecovery()`；`coordinator-proof-outbox.ts:90`。
7. activation 之后到不了：`P/child-extensions/integration-queue.ts:50`（30s gate）、`:69`（等 grant 与 `inspectAutoIntegration({})`）。queue claim 主体是 coordinator daemon（`coordinator-server.ts:48`–`:49`、`:83`），child 换 PID 不单独使 claim 过期；`integration-queue.ts:280` `claimNext()` 串行准入，`recoverClaims()` 仅在证明 daemon 死亡或 birth identity 不匹配时回收。**不存在基于 child 退出或固定时长的 queue lease TTL。**

## 对此前记录的事实更正

`P/src/workspace/recovery-protocol.ts`、`coordinator-recovery.ts` 当前不存在；未找到 `rebind-superseded-resume`；`coordinator-ledger.ts:14` 只实现通用锁与 JSON 读写，无 `durable-resume-intent` 专用协议。此前 handoff/摘要中按这些名字描述的恢复链属记忆错误，不得再引用；权威链路以上文为准。

## 前置修复顺序（诊断建议，未实施）

1. `P/src/subagent-dispatch/extension.ts`：typed resume 接入权威 intent 查询、新 run 身份获取与 coordinator activation；明确重复调用、部分失败、旧 proof supersession 责任。判据：可从 `subagent_run_resume` 追踪到同一 intent 的 activation，workspace 与 queue 同时指向新 run 且 workspaceId/leaseId 不变，失败不得回报“已恢复集成”。
2. `root-broker-server.ts`、`root-broker-protocol.ts` 与 recovery sink：统一 source run 路由字段与 handoff 数据合同。判据：真实 producer 的通知能过严格 parser 并到达所属 root，未送达保持 delivery debt。
3. `root-provider.mjs`：链路成立后消费原 handoff、触发 root turn、按 intent 去重、发出带明确 source run 的 `subagent_run_resume`。判据：RPC trace 有 resume tool call，返回身份与 audit 的 resumedRun/activation 对应，重复通知不重复启动。
4. `acceptance-barrier.mjs`：保留初始五 child 同 base barrier；恢复入口用已发布 release 的成员身份识别，不把 resumed run 计为初始五 child。
5. `scripts/probes/repository-merge-queue-acceptance.ts`：保留严格 audit settlement，补 main 五成果行为断言、发布唯一性、root provider 工具轨迹（无 bash/raw git）。

现有 `isAcceptanceAuditSettled()`（`scripts/probes/repository-merge-queue-acceptance.ts:525`）已检查五项 completed、FIFO target head 链、observed proof、released workspace、最新 resume intent completed，但没有 main 行为断言；`:326` `createAcceptanceReceipt()` 把 conflict 数算成 `allocations.length - 1`，不能作为真实冲突次数证据。

## 冲突收敛与 fail-closed（摘要）

冲突路径：`coordinator-server.ts:213` `advanceAutoIntegration()` → `service.ts:349` managedRebase（`rebase-ff`）；resolving-conflict 后持久化状态并向模型发 follow-up，模型只解决文件 + `git add`，下一轮 coordinator continue + publication；相同 digest/no progress 尝试 preserve，上限六次 attempt、两次无进展（`integration-queue.ts:17`–`:18`）后转 preserved。**activation 缺口修复前无法证明该循环收敛。**

fail-closed 前置（非穷尽）：observed terminal proof 且身份匹配（`child-integration-lifecycle.ts:9`、`service.ts:407`）；activation 属 root 且 intent/generation/lease 匹配（`coordinator-server.ts:459`、`recovery-resume-contract.ts:226`）；workspace active 且 source run 匹配（`service.ts:250`）；queue resumable（`integration-queue.ts:210`）；admission 需授权 clean committed HEAD、允许 writePaths、有效 ancestry（`service.ts:297`）；target HEAD 匹配 admission CAS（`service.ts:313`）；completed 不可重复发布（`coordinator-server.ts:93`、`integration-queue.ts:329`）；child owner grant 5s（`P/child-extensions/root-session-owner.ts:4`、`:82`）；resumed gate 30s（`P/child-extensions/integration-queue.ts:50`、`:69`）。integration intent 合同无 `expiresAt`/TTL，不得把 authority lease 到期语义推断为 intent 到期。

合规替代：保留现场、报告 F8 阻塞，先补生产恢复入口或修时序，再从新的隔离现场重跑。不得让 fixture 直接调内部 activation、伪造 proof、延长等待或 raw git 集成。

## 身份语义更正（2026-10-21 追加，实施前必读）

后续取证（见 `contact-supervisor-runid-triage.md`）确立了权威身份事实，本文件中涉及 runId 的设计必须按此修正：

- **完成通知不带机器可读 runId**：`notify.js:421-434` 的 `sendCompletion` 只发 `{customType, content, display}`，无 `details`；runId 只在正文文本（`notify.js:120-131`、`:175-182`），正文回读解析器是 `notify.js:255 parseSubagentNotifyContent`。因此“root 从 handoff/通知里取 runId 再 resume”的设计不成立，root 侧新身份只能取自 **typed 工具回执 `details.runId ?? details.asyncId`**（上游 `subagent-executor.js:1665`、enhanced `extension.ts:1531`）或事件 payload（`result-watcher.js:517-522` 的 `subagent:async-complete`：顶层 `runId` 是 wrapper run，子 run 在 `results[].runId`）。
- **不存在 `rcp-`/`rsm-` 前缀与 superseded/active 双记录语义**；durable 目录名就是裸 UUID runId。观测到的两个 runId 是父 wrapper run 与子 run 两个角色，均 active。本文件与既往记录中任何基于该语义的推断作废。
- **resume 的唯一身份拒绝路径是 host session 绑定**：`async-resume.js:491-495`（判据 `status.sessionId !== options.sessionId`），不是 runId 版本比较。因此“resumed child 能否沿用原 workspace/lease”取决于 session 绑定与 coordinator activation（本文第 5、6 节的缺口），而不是身份漂移。

## 未验证项

未运行任何测试/probe/Host/provider/模型，未联网；未读真实 session 正文、authority/state、凭据正文；未动态确认 runner `process.exit(0)` 与三次轮询的连接时序；未穷尽 recovery sink 字段转换、全部 session-owner 前置阻断、upstream resume 的 launch/extension binding 继承；未验证真实 root 是否收到原 handoff、resumed child 能否过 owner/gate、冲突能否被模型解决、五项是否各发布一次进入 main。

## 待用户裁决

F8 已从“跑一次真实模型验收”变成需要生产改动。选项：(a) 授权按前置 1→5 顺序实施（建议 worktree + 分步验收，1 与 2 各自独立可验）；(b) 只做 1，把 2 的两处协议不一致单独立缺陷；(c) 暂缓 F8，把本缺口登记为已知生产缺陷并保留现场。未裁决前不改生产。
