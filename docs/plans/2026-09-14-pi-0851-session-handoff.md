# Pi 0.85.1 Repository Merge Queue 收尾阶段会话交接文档

> 生成时间：2026-09-14
> 用途：主会话因 subagent tool 参数传输损坏需开新会话恢复（见 §7）。新会话首先完整阅读本文档，然后按 §9 的行动序列恢复执行。
> 权威计划：`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md`（本文档不替代计划，只做交接索引与状态快照）

## 1. 任务背景一句话

将 Pi core 从 `0.84.4` 升级到 `0.85.1`（保持 `pi-subagents@0.62.0` 不变），实现 repository-scoped coordinator、durable FIFO merge queue、child-owned Auto Integration（自动集成），并用两个 root、五个真实 coding subagent、真实 Git 冲突完成最终验收。

## 2. 当前总体进度（2026-09-15 深夜快照，替代 09-14 版）

| 阶段 | 状态 |
|---|---|
| T1–T8 | ✅ 已完成 |
| T9 | 🗄 已废止 |
| T10 | ✅ 已完成 |
| T11 | ✅ 已完成并主 agent 核准（42/42 复现；42 测试覆盖六阶段真实进程重启、权限矩阵、failure bounded、debt reconcile；recovery-intent.v1/通知链/门禁全部落地） |
| T12 harness | ✅ 合同测试 35/35（后经架构审阅补齐假 Root 订阅、push data 协议等缺口） |
| T12 真实验收 | 🔄 十次单 child 1/1/0 运行：R10 集成主链全通（queue completed+receipt+released），唯一残点 terminal proof 结算；方案 B（V2 统一）+七字段投影+重放触发已落地；R11 待 FIFO 测试修复后运行，通过后五 child 2/5/4 |
| T13 | ⬜ 等待 T12 真实验收 |

### 九轮真实验收修复链（全部真实缺陷，测试锁定）

watchdog 结构→fixture commit 规范→criteria 自锁→非最终 agent_end 过早 preserve→协议空对象 advance→假 Root 无 broker 订阅→push.data 协议不一致→session_shutdown 无条件 preserve→workspace v1/v2 分叉（方案 B：分配统一 V2+七字段投影+v1 降维读兼容，118 测试绿）+completed 后 outbox 重放。架构审阅（用户批准）确认设计可行，计划已修订（trusted binding 注入条款、admission 驱动责任、legacy guard 隔离、诊断字段、非 LLM wiring test 前置）。

### 并行完成的基建（当日）

1. glm-5.3 subagent 空参数修复（根 schema 顶层 anyOf 拍平，docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md）
2. security-gates 清理（外源 review 死代码与上下文逃逸/push 门禁删除，用户指令）
3. subagent-dispatch skill 三节新增（探索型工作流/停止条件/模型分级）+ S1' 评估 GREEN + model-tiers.yaml + 三 profile 三档（reviewer=astra/delegate=sol·glm-5.3/executor=terra·flash·luna，自定义 pi/agents/delegate.md 遮蔽内置已验证）
4. thinkingLevel 三层联动（L1 schema/L2 剥离透传不进 IR hash/L3 skill 标注 flash→low，141 测试绿）

### 当前阻塞（下一步）

- FIFO 集成测试（real-git L68）64s 超时——诊断在途（docs/audits/2026-09-15-fifo-replay-test-diagnosis.md 将落盘）；修复后 R11
- 已知测试债：subagent-workspace-tool five-actions、subagent-model-selection ×3（T13 收口）
- codex 池间歇过载：轻任务用 glm-5.3-flash（用户指示，附 thinkingLevel low）

## 3. 计划审阅状态（已满足门禁，勿重复）

- 计划前审阅：已完成一次（早期）。
- 收尾计划复审：用户明确要求后已用 `codex-pool/gpt-6-astra` 派发（该模型 403 权限拒绝，实际由 `openai-codex/gpt-6-astra` fallback 完成）。结论：1 blocker + 4 high + 3 medium，全部已修复并写入计划文档（T10 状态转换表、T11 recovery-intent.v1 合同、T12 barrier/conflict 证据 schema、T13 精确回归命令、T8 完成状态同步、WritePaths 串行说明）。
- **计划审阅门禁已闭合，新会话不需要再派计划 reviewer。**
- T13 末尾的"计划完成后 reviewer"是另一个独立门禁：需要用户单独批准后才派发。

## 4. T10 已完成的关键实现事实（新会话必须知道）

- Auto Integration 的机械推进（prepare/enqueue/admission/rebase/publish）已从 `agent_settled` 前移到 Pi 0.85.1 **awaited `agent_end`**；`agent_settled` 只做最终记录/恢复补偿，不再是正常集成入口。
- lifecycle owner generation fence 防止 reload 时重复推进/重复 follow-up。
- conflict digest、admission generation、continuation attempt 持久化在 queue record；相同 digest 判定无进展并 preserve；最多两次有进展 continuation。
- 每个 `agent_end` 最多一个 follow-up。
- 成功唯一条件：queue `completed` + integration receipt + terminal proof accepted + workspace `released`，全部来自 trusted receipt，不以模型文本为权威。
- Goal acceptance grant 在 `session_start` 被排除，不创建 lifecycle。
- 主要文件：`packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`、`child-integration-git.ts`、`child-extensions/integration-queue.ts`、`src/workspace/coordinator-server.ts`、`src/workspace/integration-queue.ts`；测试：`test/subagent-auto-integration-lifecycle.integration.mjs`、`subagent-auto-integration-recovery.integration.mjs`、`subagent-integration-completion-guard.test.mjs`、`subagent-auto-integration-real-git.integration.mjs`。
- Bug 记录：`docs/bugs/2026-09-14-child-integration-auto-lifecycle.md`。

## 5. 待执行任务合同要点

### T11：异常恢复、主 Agent 回收与通知（executor，优先 `token-switcher/Qwen3.8-Max-DogFooding`）

- coordinator 持久化 `recovery-intent.v1`（queueItemId、workspaceId、ownerScope、runId、attempt、reason、requiredAction、generation、delivery state；不含 token/私有路径/session 正文）。
- 主 agent 工具：`status/audit/preserve/recover/retry/discard/release`，走现有 owner scope/action token/terminal proof 门禁；新增 `test/subagent-workspace-recovery-tool.test.mjs` 验证权限矩阵（foreign root、旧 token、重复 action、并发处置）。
- `recover` 绑定原 workspace、queue item、owner scope 和新 run/lease；`retry` 新 attempt；`discard/release` 不跳过 proof/lease/action token。
- coordinator → Root Broker recovery event；离线写 notification delivery debt，attach 后 replay；通知可丢失，receipt 才是事实来源。
- 各阶段（queued/admitted/rebasing/resolving-conflict/prepared/completed-awaiting-proof）root close/restart 后可恢复或保守 preserve。
- 详细 WritePaths/验收标准见计划 Task 11 节。

### T12：真实五 Child 冲突验收 Harness（executor，优先 Dogfooding）

- 本轮只交付 harness 合同测试（`scripts/probes/repository-merge-queue-acceptance.ts`、`test/repository-merge-queue-acceptance-probe.test.mjs`、fixture）；**不运行真实 LLM probe**（真实运行在 T11 完成后串行派发）。
- barrier ready 证据只来自 trusted run/cwd/HEAD/PID；五个 child 同 base、五个 managed worktree；确定性地修改 `src/pipeline.ts` 同一行（parse/validate/transform/serialize/audit）保证 ≥4 真实冲突。
- conflict 证据 schema：rebase 非零、unmerged entries、sequencer、来自 Git 事实的 conflict digest。
- probe 只消费 public receipts；记录 `agent_end`/follow-up/`agent_start` 生命周期计数；`ACCEPTANCE_OVERALL_TIMEOUT_MS` 覆盖 barrier+settlement+audit。
- 失败保留现场，不 force cleanup。

### T12 后续真实运行（单独派发，串行）

1. 单 child：`PI_REAL_BIN=/opt/homebrew/bin/pi ACCEPTANCE_OVERALL_TIMEOUT_MS=1900000 node scripts/probes/repository-merge-queue-acceptance.ts --roots 1 --subagents 1 --require-conflicts 0`（bash timeout ≥2000s）。
2. 通过后五 child 一次性：`--roots 2 --subagents 5 --require-conflicts 4`，只跑一次，失败保留现场。
3. 验收 fixture 的真实 coding child 模型保持 `codex-pool/gpt-5.6-sol`（除非用户变更）。

### T13：最终回归与独立完成审阅

- 全部计划聚焦测试、`npm run typecheck`、`npm run verify:subagents-enhanced`、`npm run doctor`。
- 最后一轮**只运行一次** `npm test` 全量。
- 向用户单独请求"计划完成后 reviewer"批准（这是新门禁，与计划审阅不同），批准后派发一次 reviewer；reviewer 只审不授权。
- 已知 out-of-scope：`test/process-fleet-removal.test.mjs` 等旧 runtime 测试的历史失败需区分，不误判为本次回归。

## 6. 模型与派发规则（当前有效）

- 实现/诊断类 subagent：优先 `token-switcher/Qwen3.8-Max-DogFooding`；无特殊理由不用 Codex。
- 验收 fixture 内的真实 coding child：`codex-pool/gpt-5.6-sol`。
- `codex-pool/gpt-6-astra` 对当前 group 403，不可直接指定；如需 astra 用 `openai-codex/gpt-6-astra`。
- `zai-coding-cn/glm-5.3` 的 subagent 空参数问题已于 2026-09-14 修复（见 §7 修正）；`/reload` 后 glm-5.3 可正常派发 subagent。
- `zai-coding-cn/glm-5.3*` 的 `thinking: medium` 实际钳制为 `high`（向上就近），已知问题，暂不处理。

## 7. 上一会话故障记录（已于 2026-09-14 彻底解决，以下保留历史 + 修正）

**原始现象**：主会话（模型 `zai-coding-cn/glm-5.3`）subagent 调用参数恒为 `{}`。

**旧根因结论（已证伪）**：并行双 subagent invoke 触发、历史重放固化、模仿自身历史格式——均不成立。证据：全量扫描旧会话发现 glm-5.3 的 8 次 subagent 调用 8 次全空（从首次即失败，此前成功的调用全部是 gpt-5.6-sol）；新会话无任何调用历史首次调用即空；gpt-5.6-sol 到会话末尾 id 也变为裸格式但参数完整（裸 id ≠ 合成 id，仅为 provider 返回格式变化）。

**真实根因**：`TYPED_SUBAGENT_PARAMETERS` 根节点为 `{type:"object", anyOf:[三分支]}`，zai glm-5.3 服务端对顶层联合组合子（anyOf/oneOf/allOf）的受约束参数生成静默失败，字面量输出 `"{}"` 单分片后直接 finish（reasoning tokens 正常消耗、id/name 正常）。与 `tool_stream` 无关。字段级 anyOf 安全。详见 `docs/bugs/2026-09-14-glm-empty-tool-args-from-root-union-schema.md` 与探针 `scripts/probes/zai-tool-stream-diagnostic.ts`。

**修复**：根节点拍平为单一 object（三分支字段并入 properties、顶层无 required、保留 additionalProperties:false 与字段级联合）；分支互斥由 runtime 路由（action→control、version→coding、其余→generic）与 compile keypath 诊断裁决。glm-5.3/deepseek 双 provider 探针回归通过（语义完整 dispatch-ir 参数），聚焦测试 141/141。

**遗留**：`test/subagent-workspace-tool.test.mjs` 的 "child integration tool exposes five actions" 失败为 T10 测试债（期望 5 动作 vs 实际 8，含 prepare_auto_integration 等），与本次修复无关，待 T11/T13 处理。`scripts/probes/subagent-schema-provider-regression.ts` 可随时回归。

## 8. 红线约束（沿用，不得违反）

- `pi-subagents` 固定 `0.62.0`，不升级、不新增 upstream patch（不引 Worktrunk/native AgentSession）。
- 不修改、不提交 `pi/models.json`、`pi/settings.json`；不访问凭据。
- `enabledModels` 变更禁止提交；`/scoped-models` diff 丢弃。
- TDD：production 行为先 RED 后 GREEN；单轮不频繁全量测试，只在 T13 跑一次全量。
- 不自动解决 rebase 冲突；保留 sequencer/unmerged 现场；不 `checkout/reset/stash` 覆盖现场。
- 不以模型文本/TUI 文案为权威状态；queue completed/receipt/proof/release 必须来自 trusted coordinator/ledger。
- 工作区存在大量继承的未提交修改（本计划各任务的产物），**不清理、不覆盖**；各任务保持自己的 staged 集为空。
- 真实 acceptance 失败保留临时 repo/workspace/queue/诊断现场。
- 长耗时/轮询/等待验证不由主 agent 执行，交 subagent 或 scheduler；不得用 sleep。
- 主 agent 不直接删受管 worktree（生成 git 命令给用户执行）。
- 旧 Dogfooding/诊断 run 可能处于 paused；不恢复旧暂停任务。
- 计划执行方式已定 Subagent-Driven；所有派发走 `subagent-dispatch` skill 的 `dispatch-ir.v1` 合同。

## 9. 新会话恢复行动序列（2026-09-18 收口更新：全部完成）

R11–R13/T10–T13 已全部完成（含 follow-up 计划 `2026-09-16-durable-fifo-resumed-child.md` 的 durable resume 机制实现）：

- 单 child 真实验收 ACCEPTED（`repository-merge-queue-acceptance-tu6cnL`）。
- 五 child `2/5/4` 真实验收 ACCEPTED（`repository-merge-queue-acceptance-vt9Uj4`，qoder-pool/GLM-5.3-0.6x，7 次真实 resume 恢复 + rebind + proof supersession）。
- 真实 LLM 场景暴露并修复 4 个生产缺陷（recovery descriptor child extensions、audit 排序、授权头固化、resolving-conflict durable continue），各附 bug 文档。
- T13 聚焦回归/typecheck/verify/doctor 全绿；全量 npm test 878/880（2 个既有债已分类归档）。
- 剩余动作：仅"计划完成后 reviewer"（等用户单独批准）。

## 10. 关键文件索引

- 计划：`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md`
- T10 bug 记录：`docs/bugs/2026-09-14-child-integration-auto-lifecycle.md`
- Auto Integration 核心：`packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`、`child-integration-git.ts`、`git-worktree.ts`、`integration-queue.ts`、`service.ts`、`coordinator-server.ts`、`coordinator-client.ts`
- Root Broker/proof：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`、`coordinator-proof-outbox.ts`
- 扩展入口：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`child-extensions/integration-queue.ts`
- 验收 probe：`scripts/probes/repository-merge-queue-acceptance.ts`、`test/fixtures/repository-merge-queue-acceptance/**`
- 重要测试：`test/subagent-auto-integration-real-git.integration.mjs`、`subagent-auto-integration-lifecycle.integration.mjs`、`subagent-auto-integration-recovery.integration.mjs`、`managed-child-rebase.integration.mjs`、`managed-workspace-integration-queue.integration.mjs`、`managed-workspace-terminal-proof-handoff.integration.mjs`、`pi-subagents-runtime.integration.mjs`、`repository-merge-queue-acceptance-probe.test.mjs`
- 上一会话故障现场（只读，勿删）：session `var/sessions/2026-09-12T09-20-06-514Z_01a094ea-bb72-799c-8a04-907c7bf32509.jsonl` 行 1574 起
