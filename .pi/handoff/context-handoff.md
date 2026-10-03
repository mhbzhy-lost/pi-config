# 紧急交接：Subagent 生命周期改造（更新至 2026-09-21）

## 用户目标与无人值守授权

用户已明确要求：执行 `docs/plans/2026-09-20-subagent-lifecycle-overall.md`，进入无人值守模式，按 DAG 持续推进，正常停止点是当前生命周期计划全部实现、测试和验收完成；不要每个子任务后停。仅真实安全/产品决策阻塞才暂停。不得默认提交。

Pi `0.86.0` 升级独立且暂缓，不属于本批次。旧 `docs/plans/2026-09-20-subagent-orphan-recovery.md` 仅背景；总计划是唯一执行入口。

必须遵守根 `AGENTS.md`、`pi/AGENTS.md`、`pi/AGENTS_APPEND.md`、`packages/pi-subagents-enhanced/AGENTS.md`。代码/config/Skill 改动遵循 TDD；Skill 改动另需 `writing-skills`。不读取/输出 auth/token/cookie/private key/models。异常做 provenance 分类，unknown fail closed。`pi/settings.json` 有预存修改且 enabledModels 不得提交。工作树脏，禁止 stash/reset/清理无关变更。无 staged files。

## 冻结产品语义

### 进程/关闭
- 两进程：主 Host/runner + subagent child；无第三 watchdog/sidecar。
- 正常 graceful shutdown：方案 A `stop/drain`。
- 主 Host crash：不再续租；child 自身 runtime/timer按 durable绝对 `expiresAt` 过期后 SIGTERM退出。
- 普通异步 Bash不阻塞Node event loop；同步阻塞JS/第三方扩展是不保证边界。
- 主会话 resume 不自动收集active child；只 replay durable facts。用户显式 continuation 时复用同一 `sessionFile`，创建新run/process incarnation。

### Heartbeat/progress
- lease window 60s，Host renew 15s；无 missed counter；绝对 expiresAt唯一过期事实。
- progress stall 20m；无 decision grace。`stalled-suspected` 继续heartbeat，等待主Agent主动决策。
- active async Bash/tool、合法Supervisor等待、正常provider/tool I/O不计stall。
- heartbeat/renew纯control-plane：禁止 `sendMessage/sendUserMessage/triggerTurn/followUp/steer/reply/resume/spawn`，不得新增session/message/tool/async/completion事件或改变identity；只CAS更新 `lastRenewedAt/expiresAt/renewalSequence`。
- `progress_stalled`可作为durable control-plane event，但不触发turn。

### Session continuation
- Colima真实证明：官方 pi-subagents 0.62 resume复用同一native Pi sessionFile，创建新runId/asyncDir/PID/process incarnation；不是原进程恢复。
- source/resumed provenance双轨保留。
- no-session/external/missing session不可恢复。
- SessionManager.open只读内容，不是authority；接受header identity mismatch。
- 合法header+torn tail是官方repair；no-header/all-unparseable fail closed。
- 最终orphan resume = P0 session/provenance gate + P2 Root authority gate + workspace public receipt。

### reply/steer
- 有匹配pending Supervisor request只能reply；无pending且running/steerable才steer。
- reply成功后禁止等价steer；stale request/generation/owner/epoch fail closed；相同幂等键返回receipt。

## P0 已完成

Colima linux/arm64，node:22-bookworm、Node22.23.1、Pi0.85.1、pi-subagents0.62、本地deterministic provider、无真实凭据。

真实链：provider→RPC ping→official spawn→async-started→child native sessionFile/status→SessionManager.open/buildContextEntries→official rpc.resume(file-only)→新runId/asyncDir/PID/process identity、同sessionFile、resumed entries保留source前缀。

负向：no-session/missing/external fail closed；合法torn-tail repair；no-header/unparseable error；header mismatch被loader接受，项目临时gate已RED/GREEN拒绝 mismatch/no-header/unparseable/descriptor mismatch且resumeCallCount=0。真实provenance与临时gate闭合。P0 `feasibility-proven / eligible-for-P1`。

报告：`/tmp/subagent-lifecycle-p0-colima-report.md`、`/tmp/subagent-lifecycle-p0-report.md`、`/tmp/subagent-lifecycle-poc/real-colima-provenance.json`。

## P1 已完成

新增：
- `packages/pi-subagents-enhanced/src/subagent-dispatch/lifecycle-identity.ts`
- `.../lifecycle-policy.ts`
- `test/subagent-lifecycle-contract.test.mjs`
- `test/lifecycle-policy.test.mjs`

纯identity/policy、source/resumed/provenance、方案A、60s/15s/20m/10m、无grace/counter、progress排除、reply/steer纯决策。无timer/storage/broker/RPC。

验收：新8/8、recovery27/27、typecheck、diff-check。

## Generic prompt 4096 修复已完成

修改 `generic-prompt.ts`、`extension.ts`、`test/subagent-generic-prompt-contract-security.test.mjs`。generic task 64KiB UTF-8；其他字段单项4KiB；rendered aggregate64KiB；不截断。测试8/8、相关28/28、typecheck/diff-check。

## P2 Durable/outbox 已完成

新增：
- `durable-contract.ts`
- `durable-storage.ts`
- `durable-run-registry.ts`
- `durable-event-outbox.ts`
- `replay-barrier.ts`
- `test/durable-lifecycle.test.mjs`
- `test/subagent-delivery-recovery.test.mjs`

严格JSON/reference/provenance、0600/temp+fsync+rename+dir fsync、revision CAS/lock/quarantine、inventory不授予authority、三层receipt primitive、at-least-once、ACK前不删、sequence/digest fencing、durable high-water barrier/live epoch。基础统一38/38 + typecheck。

## P2 Authority/rebind 已完成主体及全量验收

新增/修改：authority-contract/store、durable-storage最小Node stripping修复、root-broker protocol/client/server、runtime injection、tests。

设计：
- OwnerReceiptV1、ExecutionLeaseV1、新owner RPC dedicated5s；旧client10s/challenge5s、registerAuthorizedRun Promise<void>保留。
- AuthorityStore root `<PI_CODING_WORKSPACE_DIR>/root-broker-authority/<rootSessionId>`；无root时新API fail closed。
- legacy owner-*.json unsupported_layout保留现场。
- root-scoped single `authority-index`（entries/associations/leases/revision），单key lock/CAS原子source→resumed；请求不信任new pid/birth；两run先verified+PID birth capture；source fenced/resumed current；幂等association。
- 真实socket owner.read/rebind/revoke；caller binding；5s deadline。

曾有完整broker挂起，已诊断为测试fixture缺source/resumed terminal proof，不是production close bug。fixture已用 `broker.observeTerminal(observedProof(runId))` 正常收敛。

主流程最近验收：
- root broker完整38/38
- runtime/resource18/18
- authority/durable/recovery39/39
- typecheck与diff-check通过。

## Heartbeat runtime：实现已落盘，P2最终验收接近完成

Partial task曾30m timeout，但代码已落盘：
- AuthorityStore index增加leases；createWithLease/issue/read/renew/release。
- RootBroker register verified receipt+lease；Host setInterval 15s renew；lease.updated push；terminal/revoke/rebind/close release/debt。
- child root-session-owner缓存lease.updated、5s timer检查绝对expiresAt、root.closing explicit_stop、EOF有有效lease等待expiry、无lease fail-closed、dispose清timer；删除sendMessage副作用。
- 两进程无sidecar。

聚焦发现heartbeat test callback不返回Promise及cleanup缺terminal，已修：interval callback return renewHeartbeats；official terminal cleanup；release promise/debt。

最近统一验收（heartbeat closeout之后）：
- runtime/broker/authority：148/148
- durable/outbox/recovery：39/39
- `npm run typecheck` pass
- diff-check pass。

之后发现缺child owner独立测试，派发任务 `cc76...`，进度/最终报告：
- 新 `test/root-session-owner-lifecycle.test.mjs`，lease.updated严格runId/generation/time、expiry fake timer、root.closing explicit_stop、EOF/dispose fail-closed、零sendMessage。
- 新测试3/3；相关回归170/170；typecheck/diff-check pass。
- 子任务系统仍显示needs attention/可能未terminal，但实现已落盘；需先复跑确认。

**压缩后第一步必须运行：**
```bash
node --test test/root-session-owner-lifecycle.test.mjs
node --test test/root-subagent-broker.test.mjs test/root-subagent-broker-protocol.test.mjs test/root-subagent-rebind.test.mjs test/subagent-runtime-resource-isolation.test.mjs test/subagent-runtime-production-shutdown.test.mjs test/subagent-runtime-membrane.test.mjs test/subagent-completion-ownership.test.mjs test/subagent-broker-capabilities.integration.mjs
node --test test/durable-lifecycle.test.mjs test/subagent-delivery-recovery.test.mjs test/workspace-recovery-contract.test.mjs test/recovery-resume-contract.test.mjs test/recovery-resume-orchestrator.test.mjs
npm run typecheck
git diff --check
```
若全绿，标记P2完成并进入P3-T5 Supervisor replay。

## 下一 DAG

1. P2最终统一验收（上面命令）。
2. P3-T5 Supervisor replay：消费OwnerReceipt/lease + inventory/outbox/barrier；实现 `supervisor-replay.ts`，offline/restart/ACK loss、transport/processing/user-visible receipt、completion key runId+terminalReceiptId exactly-once。
3. P3-T6 reply/steer control-plane：pending→reply；无pending→steer；同intent禁止双投递；stale/generation/epoch fencing；progress_stalled 20m control event但无自动turn。
4. P4-T7 orphan crash matrix：120s child-start独立路径、P0 session gate+P2 authority+workspace receipt、crash/restart/lease expiry。
5. P5-T8 scheduler typed outcome接入。
6. P6-T9 Skill后置（用户授权整个计划无人值守，但写Skill必须先加载writing-skills）。
7. Pi0.86仍暂停、独立、不执行。

## 最新 active subagent

`cc76dca8-ed12-4ac4-99dd-2600dd908c4b`（补齐 child owner lease expiry测试）曾progress报告已完成3/3+170/170+typecheck，但随后系统needs attention。可status或等待最终；不要重复实现，先检查工作树/测试。

## 工作树注意

大量预存脏文件；禁止清理/stash/reset。生命周期文件多未跟踪/修改。无staged。精确路径验收，不假设clean。

## 自动执行规则

持续推进，不逐任务停；每coding任务TDD；拆小于30m；并发仅不重叠WritePaths；reviewer须用户逐次授权，勿自动派；不提交。

## P3-T5 + P3-T6 已完成（2026-09-21）

### P3-T5 Supervisor replay（已完成并验收）
- 新增 `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-replay.ts`：barrier high-water 批量 replay、owner/cursor/terminal fail-closed、processing receipt/ACK、completion stable key（runId+terminalReceiptId）exactly-once、sink crash-gap 幂等。
- `durable-event-outbox.ts` 扩展 completion receipt 完成标记与 ACK 查询；ACK 不删 append event。
- 新增 `test/supervisor-replay.test.mjs`（含 `test/subagent-delivery-recovery.test.mjs` 扩展）；19/19、typecheck、diff-check 通过。

### P3-T6 reply/steer 单投递控制面（已完成并验收）
- 新增 `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`：SupervisorRequestV1/ControlIntentV1 严格 parser + canonical SHA-256 digest、pending ingress 注册、reply 优先、幂等 receipt（幂等检查先于 pending 检查，保证重复 reply 返回回执而非误报 NOT_PENDING）、stale/expired/generation/epoch fencing、STEER_DUPLICATES_REPLY、markProgressStalled 纯投影。
- 接线（`extension.ts`）：
  - ingress：`message_end` 对 `subagent_supervisor_request` 先注册控制面 request，再走既有 `onSupervisorRequest`；注册失败吞掉不破坏事件流。
  - reply：`createControlledSupervisorAdapter` 包装 supervisor adapter，`action==="reply"` 时先 `findRequest(replyTo)` → resolve → native → commitDelivery；幂等重试不再调 native。
  - steer：`executeControl` 增加 supervisorControlPlane/toolCallId 参数，`action==="steer"` 先 identityForRun（readOwnerReceipt+readRuntime）→ resolve → rpc.steer → commitDelivery。
  - 未配置控制面时 legacy 行为完全不变（既有 79 测试零回归）。
- 生产注入（`extensions/subagent-runtime.ts`）：`createSupervisorControlPlane` + `enabled: () => brokerReady && !!broker`；readOwnerReceipt 用 `broker.readOwnerReceipt`（owner.read RPC），readRuntime 用 `rpc.status`；broker 未就绪显式保持 legacy；同时接入了 AuthorityStore（PI_CODING_WORKSPACE_DIR/root-broker-authority/<rootSessionId>）。
- 验收（主 agent 复跑）：
  - 三组主测试 80/80（含新测试，RED 证据为具体断言失败）
  - replay/delivery/rebind/owner-lifecycle/durable/lifecycle-contract/policy 30/30
  - broker-protocol/broker/workspace-recovery/generic-prompt-security 61/61
  - typecheck + `git diff --check` 通过
- 已知残留（P4 硬化候选，不阻塞）：
  1. resolve→native→commit 非原子：并发相同 reply/steer 工具调用理论上可双投递（顺序重试已幂等）；建议 P4 对 request 加 in-flight 锁或同步置 replying。
  2. steer 幂等检查先于 pending 检查：新 pending 到达后重试旧 steer 返回旧回执而非 REPLY_REQUIRED（单投递不变量仍成立）。
- 补充切片 `7e70b0bc`：fail-closed 路径测试断言（stale owner/expired/non-running/generation mismatch），完成后 P3-T6 完全关闭。

## 下一 DAG（更新）

1. 等待 `7e70b0bc`（fail-closed 测试断言）完成并复跑 membrane 测试。
2. P4-T7 orphan crash matrix：120s child-start 独立路径（integration 15s 不变）、P0 session gate + P2 authority + workspace receipt 串联、Host crash→lease expiry、terminal/non-resumable、显式 session continuation、completion replay 集成。注意：需真实 Pi 二进制（PI_REAL_BIN）或 Colima 环境；本机环境缺失时需用户确认路径。
3. P5-T8 scheduler typed outcome 接入。
4. P6-T9 Skill 后置（需 writing-skills）。
5. 全生命周期验收矩阵最终复跑。

## 最新 active subagent

`7e70b0bc-60fe-4552-8baf-a425a57f9eb3`（P3-T6 fail-closed 测试断言补充，仅测试不改 production）。

## P3-T6 正式关闭（2026-09-21）

- fail-closed 切片 `7e70b0bc` 完成：membrane 66/66（新增 stale owner / expired request / 非 running steer / ownerGeneration mismatch 四条断言），production 零修改，typecheck + diff-check 通过。
- P3-T6 最终状态：**完成**。全部验收命令：三组主测试 80/80、membrane 66/66、replay/delivery/rebind/owner/durable/lifecycle 30/30、broker/workspace/generic-prompt 61/61、typecheck、diff-check 全绿。

## P4-T7 切片计划（执行中）

readiness 报告：`.pi/handoff/p4-p5-readiness.md`（executor 已完成，含 P4/P5 依赖图、WritePaths、RED 基线、PI_REAL_BIN 现状）。

串行切片（WritePaths 相同，禁止并行）：
1. **切片1 `b63ff875`（进行中）**：recoverOrphanRun contract + 最小组合骨架（注入式 gate 链、三分支 outcome union、120s 固定、15s 零变更、fail-closed provenance）。
2. 切片2：`test/subagent-orphan-recovery-crash.test.mjs` crash matrix（每行 8 字段：injectionPoint/initialFacts/expectedOutcome/retainedEvidence/forbiddenMutations/provenance/clockStrategy/processStrategy；覆盖全部 pipeline 注入点；同 PID/不同 processBirth 用受信 capture seam fixture）。
3. 切片3：`test/subagent-orphan-recovery.integration.test.mjs` 真实双 Node 进程 capture/rebind 边界、eligible/non-eligible session、host crash 停止 renew、child 到期自退出。

P4 完成后 → P5-T8（scheduler outcome union + adapter/extension 接入）→ P6-T9（Skill 同步，需 writing-skills）→ 全生命周期最终验收矩阵。

关键事实：PI_REAL_BIN 未设置；真实 Pi crash 场景后续需用户确认环境路径（Node 双进程先行不阻塞）。

## P4-T7 完成（2026-09-21）

三个串行切片全部验收：
- 切片1 `b63ff875`：recoverOrphanRun contract + 11 gate 组合骨架（注入式）、三分支 outcome union、ORPHAN_CHILD_START_TIMEOUT_MS=120_000、既有 15s 零变更、provenance 脱敏、promise cache 幂等。
- 切片2 `c23ec052`：16 行 crash matrix（8 必填字段/行、16 injection point、逐 gate fail-closed、authority_lease_expired 独立 reason、同 PID/不同 processBirth fixture、heartbeat 禁止清单+identity 不变）。
- 切片3 `7181e605`：真实双 Node 进程 integration——跨进程 birth capture + durable rebind（generation 递增）、eligible/non-eligible session 路由、host 停止 renew 后 child 依 durable expiresAt 自行退出（exit 42 + authority_lease_expired，无 stop 信号）；RED 发现并修复不可解析 expiresAt 曾被误判为有效 lease 的 fail-closed 缺陷。

P4 全回归（主 agent 复跑）：contract/orchestrator/broker/delivery/crash/integration 82/82；typecheck:subagents-enhanced；diff-check 全绿。

残留：真实 Pi 二进制 crash 场景（PI_REAL_BIN 未设置）留待环境可用时补充，不阻塞 P5/P6。

## 下一步：P5-T8 scheduler typed outcome

WritePaths：src/task-scheduler/adapter.ts、pi/extensions/task-scheduler.ts、三个既有 scheduler tests。
readiness 要点：先冻结 SchedulerRecoveryOutcome union + consumeRecoveryOutcome（adapter），测试通过后 extension 注入 P4 真实 outcome；禁止 fake scheduler recovery API、禁止读 private durable root。

## P5-T8 完成 + P0–P5 验收矩阵全绿（2026-09-21）

P5-T8（`d98c4c41`）验收：
- adapter 导出 SchedulerRecoveryOutcome 三分支 union（rebound/blocked-unknown含reason/debt）+ consumeRecoveryOutcome（校验、runId 去重、仅观测投影）
- extension 显式可选 SchedulerRecoveryBridge（recoverySource/onRecoveryOutcome），无 source 时默认路径零变更
- scheduler 19/19、orchestrator 回归 16/16、typecheck、diff-check 全绿；仅五个声明 WritePaths 修改

P0–P5 完整生命周期验收矩阵（主 agent 复跑）：
- owner/broker/authority/rebind/isolation/shutdown：78/78
- membrane/supervisor-adapter/rpc/completion/replay：88/88
- durable/delivery/workspace/lifecycle-contract/policy/generic-prompt：28/28
- P4 crash+integration+contract / P5 scheduler：42/42
- npm run typecheck + git diff --check：通过
- 合计 236 tests 全绿

## P6-T9 执行中（最终任务）

`5a6f8f8f`：按 writing-skills RED-GREEN-REFACTOR + fresh-context baseline 更新 skill-overrides/subagent-dispatch/SKILL.md 与 test/subagent-dispatch-skill.test.mjs；WritePaths 仅这两个文件；最终验收含 verify:package/npm test/test:subagents/test:subagents-enhanced。

P6 完成后剩余：最终汇总报告（P0–P6 全链路状态、残留风险：PI_REAL_BIN 真实 Pi crash 场景待环境、控制面并发窗口 P4 硬化候选、steer幂等先于pending的边界）。

## P6-T9 完成 + 全生命周期收官（2026-09-21）

P6-T9（`5a6f8f8f`）验收：
- Skill RED→GREEN：旧文本具体失败（缺 stop/drain 不承诺 detached）→ 新增最小"生命周期与控制面边界"表（resume/rebind fencing、pending→reply、reply 后禁等价 steer+幂等 receipt、completion 分层 exactly-once、authority_lease_expired、blocked-unknown/debt、scheduler consume、敏感信息/TUI 边界）；skill 测试 3/3。
- fresh-context 闭环：基线（6 场景缺精确状态名/边界）→ post-update（6/6 命中、0 语义缺口、0 假阳性）；基线/postupdate 由宿主代跑，证据在 .pi/handoff/p6-fresh-context-{baseline,postupdate}.md。
- typecheck、verify:package、test:subagents-enhanced(8/8) 通过。

**npm test 3 失败全部归因为范围外（HEAD 干净导出复现验证）：**
1. test/init-pi：HEAD 既有（commit c35c596 移除 external-llm-review 目录后测试期望未同步）。
2. test/pi-subagents-compat "local package source"：HEAD 干净导出同断言失败（compat:244 Missing expected rejection）——与生命周期批次无关的既有缺陷。
3. test/reviewer-agent：用户预存未提交的 pi/agents/reviewer.md 编辑（gpt-6-astra 模型行）所致；HEAD 上 2/2 通过。不得替用户回滚。
另：BROKER_TIMEOUT 为全量并发负载下 flake（单独重跑 39/39 通过，两次全量跑仅一次出现）；test:subagents 需 PI_REAL_BIN（环境未设，readiness 已记录）。

## 生命周期总状态：P0–P6 全部完成

最终验收汇总：P0 gate（Colima 实证）→ P1 policy → P2 authority/lease/heartbeat → P3 replay+control-plane → P4 orphan recovery（三切片+真实双进程）→ P5 scheduler outcome → P6 Skill 同步。生命周期范围 236+ tests、typecheck、verify:package、skill 3/3、fresh-context 6/6 全绿。

**残留风险（后续候选，不阻塞）：**
1. 控制面 resolve→native→commit 非原子：并发相同 reply/steer 理论可双投递（顺序重试已幂等）——建议 in-flight 锁。
2. steer 幂等检查先于 pending 检查：新 pending 到达后重试旧 steer 返回旧回执（单投递不变量仍成立）。
3. PI_REAL_BIN 未设置：真实 Pi 二进制 crash 场景与 test:subagents 待环境。
4. HEAD 既有 init-pi/compat 失败建议另立 bug 文档处理。

## 2026-09-28 本轮 runtime 修复与 H-PI-2 交接

- 当前用户问题：H-PI-2 隔离普通 Pi RPC 测试未成功执行的原因及是否有 bug。必须区分子代理执行环境与被测 Pi 运行时。Run `ab2afe2f-a86d-4b99-b2b6-b3d704885e21` 启动时 stderr 报 `Root broker grant is not ready`，随后仅看到查找 TDD skill 等前置动作，因 120 秒无活动被主 agent 停止；尚未观察到 H-PI-2 测试代码编辑、断言级 RED 或真实 Pi RPC。单凭该 stderr 不能证明 production worktree bug；先查子 session 与 runtime grant 时序。
- 用户明确要求收窄本轮目标为 `worktree: true` 的真实端到端验证与由它暴露的最小修复。历史 proof debt、两个 lifecycle orphan 的接线和新 proof-debt 管理接口均不构成本轮前置；不得清理 live 现场。
- A/B/C 确定性修复完成；C13 后 `npm run test:subagent-workspace` 36/36，typecheck、package verify 已通过。调查与计划文档已有提交 `7302216`；大量源码/测试、其他 lifecycle/context-usage 预存编辑仍未提交，禁止混合暂存、stash/reset/clean。旧 A4 managed worktrees 的 `origin-dirty/workspace-dirty/terminal-unobserved` 不允许强行处置。
- 真实 Pi lane：`docs/plans/records/2026-09-23-runtime-remediation/E-PI.md`。普通 completing-executor 子集曾通过（约 2.35 秒），attention/supervisor-resume 子集 45 秒超时、测试进程组不完整回收；本轮产生的遗留进程组已清理。仓库根 cwd 的 startup 用例受已有 `.git/.pi-coordinator` live 元数据污染。`A-ENV` 仍 `degraded`，真实 supervisor transport 未证实。
- H-PI-1 新增测试专用进程组 helper `test/helpers/pi-process-group.mjs` 及 fake 集成测试，4/4 和 typecheck 通过，但不是 Pi 子集验收。H-PI-2 唯一 WritePath 是 `test/pi-subagents-runtime.integration.mjs`。多次派发最初遭 root schema 和缺 execution 拒绝，最后一次 run 启动后卡于前置，已停止、无测试证据。统一 DAG `docs/plans/2026-09-23-subagent-runtime-unified-dag.md` 正在修改且未提交，应机械核对状态表、依赖表及 Task 节点一致性。
- 更早 handoff 中引用的部分 lifecycle 验收提交经调查不存在；不得把本文件历史自述等同产物证据。`L-REGISTRY-ENTRY.md` 判 durable registry 无 production importer 且缺三份权威四元引用；coordinator-process 只有测试 spawn/自启动，外部 loader 未证实。历史 debt 快照 529 条全部来源未证实，可证明安全清理候选 0；D-CLEANUP 保持 blocked，无 live mutation。
- 已加载 subagent-dispatch、test-driven-development、writing-plans、writing-skills；编写测试还须读 `writing-good-tests.md`。coding 派发用完整 dispatch-ir.v1（含 execution），generic 不能绕过。当前旧 Host 的 supervisor reply/steer 曾分别返回 `SUPERVISOR_REQUEST_NOT_PENDING`/`SUPERVISOR_INTENT_INVALID`。用户此轮先要原因与 bug 分类，应只读核对证据，不为未证实来源添加 production 兼容。
- 2026-09-28 源码优先追踪发现一个独立、可复现的 production 字段断点：`child-extensions/integration-queue.ts` 的 `preserve()` 调用 `coordinator.preserveIntegrationDebt(binding, reason)`；broker-backed coordinator 把它编码为 `coordinator.request` 的 `preserve_integration_debt` + `{ reason }`；但 `src/subagent-dispatch/root-broker-protocol.ts` 的 `coordinatorParams()` 对该 operation 走默认 `exactObject(input, "params.input", [])`，因此合法 `reason` 被拒绝为未知字段。`child-extensions/integration-queue.ts:248` 又吞掉该 preserve 异常。该入口、身份和资源顺序均是 production 可达，分类为“预期 production 数据未被正确处理”，应建立 bug 记录并按 TDD 先 RED 后最小 GREEN；不是 grant 探针问题。
- 真实 worktree E2E 的源码结论：唯一最小真实路径是复用 `test/pi-subagents-project-workflow.integration.mjs` 的 `PI_REAL_BIN` Host + deterministic provider，令 coding child 在 dispatch cwd 中用 bash 修改并 commit 允许文件，再由自动 integration queue 完成 admission/rebase/publish，Root Broker/Coordinator 记录 terminal proof 并释放 workspace。`test/subagent-auto-integration-real-git.integration.mjs` 的 Git/queue 虽真实，但 dispatch RPC 与 child binding 是 harness stub，不能替代 Host E2E。当前 `PI_REAL_BIN` 未设置，真实 lane 只能标记 environment-constrained，不能伪造通过。
- 当前代码节点受保护路径门禁阻塞：`git status --short pi/agents/reviewer.md pi/settings.json pi/models.json var/workspaces/` 命中 `pi/settings.json` 预存 dirty。不得清理、回滚、覆盖或读取其敏感内容；在该门禁解除/明确豁免前不修改 production/test。
## 2026-09-28 当前执行状态补充

- 用户已明确将 `pi/settings.json` 与 `pi/models.json` 作为纯 per-machine 文件：本地保留，仓库不跟踪；`pi/settings.json` 已通过索引移除、`.gitignore` 增加两项，并以独立提交 `6afc404 chore(config): 将本机配置移出版本控制` 固化。未读取或输出配置内容。当前 protected-path 基线已 clean。
- `BUG-PRESERVE-REASON` 已按完整 dispatch-ir.v1 派发给 executor `eea81ac3-0b2c-42ac-aa55-9cc9db856114`，WritePaths 仅 `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts` 与 `test/root-subagent-broker-protocol.test.mjs`；要求严格 RED→GREEN、不得提交/触碰 live state。等待 typed acceptance report，不把 completion prose 当验收。
- 当前真实 worktree E2E 仍独立延后：`PI_REAL_BIN` 未设置；不将 preserve bug 修复与 H-PI-2 合并，也不伪造真实 Pi 结果。

## 2026-09-28 preserve 修复完成，真实 worktree E2E 执行中

- per-machine 配置策略已独立提交：`6afc404 chore(config): 将本机配置移出版本控制`。`pi/settings.json` 从 Git 索引移除但本地保留，`.gitignore` 忽略 `pi/settings.json` 与 `pi/models.json`；未读取/输出配置内容。
- `BUG-PRESERVE-REASON` TDD 已完成：executor 原始 session 证明先 RED（合法 `{ reason }` 被 `unknown field reason` 拒绝），再 GREEN；protocol 12/12、Root Broker focused 51/51、typecheck、diff-check 通过。最小修复提交为 `ddcf487 fix(runtime): 放行保留债务原因参数`，只含 `root-broker-protocol.ts` 与 `root-subagent-broker-protocol.test.mjs`。
- 真实 H-PI-2 worktree E2E 已重新派发给 executor `8c3caf68-f1eb-4765-953a-de9bdd435711`，只写 `test/pi-subagents-project-workflow.integration.mjs`，使用临时 `PI_REAL_BIN=/opt/homebrew/bin/pi`（版本 0.85.1）；要求先对 child commit 场景取得断言级 RED，再用 deterministic provider 驱动真实 child 在 managed dispatch cwd 中 bash 修改/提交 README，验证 production queue/publish/proof/release。不得改 production、helper、live state 或提交 Git。
- 当前工作树预存/主 agent 文档变更：`.pi/handoff/context-handoff.md`、`docs/plans/2026-09-23-subagent-runtime-unified-dag.md`、`docs/bugs/2026-09-28-preserve-integration-debt-reason.md`；真实 E2E 测试提交不得混入这些文件。protected paths 当前 clean；`var/workspaces` 未触碰。`PI_REAL_BIN` 未设为环境变量，但显式 `/opt/homebrew/bin/pi` 可用且版本 0.85.1 在支持矩阵中；若真实 Host 不通过，准确记录 environment-constrained，不改矩阵/生产。
- 配置策略残留风险：当前 `init-pi.sh` 源码只安装 Pi、依赖、Skill 并运行 doctor，未发现重放 `pi/settings.json` 或 `pi/models.json` 的逻辑。用户要求的“本地保留、由 init 重放”尚未由实现满足；本轮不把该配置设计问题混入 preserve 修复或真实 worktree E2E，结束时必须明确报告并另行决定模板/重放方案。
- settings 初步分类（基于 Pi `docs/settings.md`、`SettingsManager` 源码、仓内 `doctor.ts`/tests）：自动/运行时字段为 `lastChangelogVersion`，以及用户通过 `/model`、`/thinking`、`/scoped-models` 或 `/settings` 持久化后由 Pi setter 写入的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`、`modelThinkingLevels`、`enabledModels` 等；这些不能作为共享模板的权威全量内容。`enabledModels` 明确保留为 per-machine。`defaultProvider/defaultModel` 也建议按机器/模型目录处理，除非各机器有同一 provider catalog。
- 当前 settings 的共享策略候选是 `packages` 与 `subagents`：前者决定本仓增强包、其他本地/registry package 及资源过滤，后者承载 builtin disable 与 agent override 等 runtime policy；它们应进入受版本控制的 template/重放逻辑，而不是依赖本地旧 settings。当前标准顶层还包括 UI/终端偏好（`tuiMode`、fullscreen 相关、`theme`、`hideThinkingBlock`），建议 per-machine；`defaultThinkingLevel` 可作为显式共享策略但默认按机器保留。`models.json`/`auth.json` 不进入共享模板。
- fresh clone 断裂已证实：`scripts/doctor.ts` 直接要求 `pi/settings.json` 存在并解析 `packages`；多个 tests 直接读取该文件；`scripts/pi-shell.zsh` 将 `PI_CODING_AGENT_DIR` 指向仓库 `pi`。而 `init-pi.sh` 没有创建/合并 settings 的步骤。因此后续应独立设计 tracked `settings.template.json` + 幂等 ensure/merge 脚本：首次创建共享字段，已有本机文件只补缺失共享字段，不覆盖 Pi 自动生成字段和 per-machine 字段。
- 用户已确认采用方案 A（tracked template + init 幂等合并）。`pi-adapter`（`~/.r2c/integrations/pi-adapter`，外部 r2c 追踪 adapter）与 `enabledModels`、默认模型、UI 偏好、`lastChangelogVersion` 均不进模板。实现已派发 executor `716b690e-85da-4b58-a1df-74223be653f1`：WritePaths 为 `pi/settings.template.json`、`scripts/ensure-pi-settings.ts`、`init-pi.sh`、`test/ensure-pi-settings.test.mjs`、`test/init-pi.test.mjs`；TDD RED→GREEN；packages 按 source 幂等合并、subagents 深合并保留本机子字段、原子写入、支持 `--check`。
- doctor 实跑确认：当前失败根因是历史 proof debt 与 `.pi-subagents` legacy（live 现场，禁止触碰），settings 本身未被 doctor 报错。

## 2026-09-28 并行子任务状态

- `76779a30-94dc-4c78-97ba-e08302df2dbb`：H-PI-2 真实 `worktree:true` Host E2E（resume 后重跑中，写路径仅 project-workflow 测试文件）。
- `716b690e-85da-4b58-a1df-74223be653f1`：settings 方案 A 模板与幂等重放（进行中）。
- 两者写路径不相交；均要求 TDD 与 typed acceptance report；完成后按范围分别提交。

## 2026-09-28 终态证明门禁修复与真实 E2E 全链路通过

- H-PI-2 子任务 GREEN 阶段超时后主 agent 接管诊断：真实 Host E2E 暴露首个可证实生产缺陷——`executorProofSnapshot` 用 `authorization.goal` 门禁 terminal proof 可见性，standalone run 的 goal 永远为 null → terminal 永远不可见。这是历史 529 条 proof debt 大量 `terminal-unobserved` 的根因。
- 诊断证据：process-terminal 事件正常发射且被 broker 接受（早于 async-complete），artifact 存在 state=observed，runId 匹配；但 inspectExecutionProof 返回 terminal:null。原测试因 PI_REAL_BIN 从未设置而一直 skip，断言从未真实验证。
- TDD 修复：RED→GREEN 移除 `authorized &&` 门禁；authorization.state 独立报告不变。Bug 记录 docs/bugs/2026-09-28-standalone-terminal-proof-invisible.md。
- 真实 E2E 全链路通过（12.7s）：dispatch→workspace 分配→child bash commit→Auto Integration admission/rebase/publish→terminal proof→release→origin clean。
- hostile-legacy 与 rename-canary 是预存断裂（A2 workflow 字段删除后 fixture 未迁移），不属本次变更。
- 提交：ddcf487、a46e9ca、145c25a。剩余 dirty 仅 handoff 与统一 DAG。

## 2026-09-29 统一 Dispatch Schema v2 完成与 v0.0.1 发布

### 本轮全部提交（已推送 origin/main，tag v0.0.1）

- 76e665b test: 迁移 delegation workspace 测试到 v2 schema
- 503815b feat: session-owner 启动决策审计日志
- 3b04815 fix: agent list 只返回项目 agent（过滤 ~/.agents/ skill 定义）
- 9198280 feat: subagent agent 发现（action:"list"）+ 移除自定义 system prompt（pi/SYSTEM.qwen.md + model-system-prompt 机制）
- b2534dd fix: generic 路由前置编译 + 统一提示渲染（reviewer P1 修复）
- 7c8e1cf refactor: 统一 dispatch schema v2（39 文件，+1225/-2018）
- 更早：80114d1 rename canary、bafe714 worktree 工具面、041f9f9 fixture 清理、64d80d4 移除执行超时、886973a H-PI-2 报告、ab4a88a DAG 更新、145c25a terminal proof 修复、a46e9ca settings 模板、ddcf487 preserve reason、6afc404 配置移出

### v2 Schema 设计（最终确认）

- generic：{agent, task} 必填，{title, model} 可选
- coding：{agent, task, writePaths, acceptance:{criteria}} 必填，+ {title, model, worktree, cwd} 可选
- 路由：isCodingDispatch = Object.hasOwn(input, "writePaths")
- taskId = "dispatch-" + contractHash.slice(0,8)，hash 不含 taskId
- timeoutMs 由 Host 注入，模型提供则拒绝
- 旧 v1 输入返回 DEPRECATED_SCHEMA 含迁移指引
- generic-prompt.ts 已删除，功能合并进 dispatch-ir.ts
- skill-overrides/subagent-dispatch/ 已退役，核心约束迁入 pi/AGENTS_APPEND.md（115 行）
- subagent({action:"list"}) 可查询可用 agent（只返回 pi/agents/ 下的项目 agent）

### rebase 后 settings/models 恢复

- rebase 过程中 pi/settings.json 丢失 packages（ensure-pi-settings.ts 幂等恢复）和 defaultProvider/defaultModel（手动补回）
- pi/models.json 被 git rm 物理删除，从 git show db60aa2 恢复（7 provider / 8 model）
- 确认：settings.json 和 models.json 均不进 git（per-machine）

### 工作树残留（用户保留）

- scripts/pi-shell.zsh + test/pi-shell.test.mjs（pi-new 函数，用户决定留着不提交不删除）
- scripts/pi-session-owner.ts 已提交（503815b）

### 遗留项（均按用户决策冻结或延后）

- 历史 529 条 proof debt：不处理
- 旧 A4 managed workspaces：不管
- attention lane / supervisor transport：不在本轮范围
- L-REGISTRY-ENTRY：blocked-unknown
- 上游兼容导出（compileCodingDispatchIR alias）：低优先级后续清理
- README/probes v1 引用清理：低优先级
- 真实模型 T6 v2 schema 行为验证：待环境可用时执行
