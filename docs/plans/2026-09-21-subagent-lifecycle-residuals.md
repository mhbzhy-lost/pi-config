# Subagent 生命周期改造：残留问题收尾清单

> **交接对象：** 负责收尾的执行 agent。
> **前置状态：** `docs/plans/2026-09-20-subagent-lifecycle-overall.md` 的 P0–P6 已全部完成并验收；生命周期范围内 236+ tests、typecheck、verify:package、skill 3/3、fresh-context 6/6 全绿。全部产物处于**未提交**状态（工作区还有大量本批次之外的预存脏文件，禁止 stash/reset/clean）。
> **本文档性质：** 残留问题清单，每项已给出归因证据、分类、建议方案与验证命令。收尾 agent 执行前必须加载 `test-driven-development` skill（涉及代码变更时）并遵守仓库 AGENTS 约束。

## 残留问题总览

| # | 问题 | 分类 | 优先级 | 建议批次 |
|---|---|---|---|---|
| R1 | 控制面 resolve→native→commit 非原子，并发相同 reply/steer 理论可双投递 | production 缺陷（P3-T6 已知残留） | 中 | 批次 A |
| R2 | steer 幂等检查先于 pending 检查：新 pending 到达后重试旧 steer 返回旧回执 | 语义边界（设计取舍待定） | 低 | 批次 A |
| R3 | `PI_REAL_BIN` 未设置：真实 Pi 二进制 crash 场景与 `test:subagents` 无法运行 | 环境限制 | 中 | 批次 B |
| R4 | `test/init-pi.test.mjs` 失败：external-llm-review 目录已删但测试期望未同步 | HEAD 既有缺陷（与本批次无关） | 中 | 批次 C |
| R5 | `test/pi-subagents-compat.test.mjs` "local package source" 失败 | HEAD 既有缺陷（与本批次无关） | 高（需先归因） | 批次 C |
| R6 | `test/reviewer-agent.test.mjs` 失败：用户预存未提交的 `pi/agents/reviewer.md` 编辑 | 用户决策项 | — | 询问用户 |
| R7 | `BROKER_TIMEOUT` 全量并发负载下偶现 flake | 测试稳定性 | 低 | 批次 D |

---

## R1：控制面并发双投递窗口

**现象：** `supervisor-control-plane.ts` 的 `resolveSupervisorControl`（纯判定）→ native/RPC 发送 → `commitDelivery`（写 receipt）三步非原子。若模型在同一 assistant message 中并发发起两个相同 reply（同 `replyTo` + 同 message）或相同 steer，两者都可能在任一方 commit 前通过 resolve，导致 native 双投递。顺序重试已幂等（receipt cache 命中即返回，不再调 native）。

**证据：** `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts` 中 `resolveSupervisorControl` 无状态翻转（第一版曾有 `pending.state = "replying"` 但破坏了 commitDelivery 的二次 resolve，被移除）；现有测试只覆盖顺序重试幂等（`test/subagent-runtime-membrane.test.mjs` "configured supervisor control plane fences reply and steer delivery..."，断言 `nativeCalls === 1`）。

**影响：** 违反 P3-T6 计划验收标准"同一 user intent 至多一次实际 delivery"的严格并发解读；顺序场景不违反。

**建议方案：** 对每个 request/run 加同步 in-flight 锁（或 resolve 时同步占用 idempotency key 的 pending slot），使第二个并发 resolve 在 commit 前命中 `in-flight` 而非 `allowed`。注意保持既有语义：顺序重试返回同一 receipt、commitDelivery 内部二次 resolve 不被自锁死。

**涉及文件：**
- `packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`
- `test/subagent-runtime-membrane.test.mjs`（新增并发断言：`Promise.all` 两个相同 reply → `nativeCalls === 1`）

**验证：** `node --test test/subagent-runtime-membrane.test.mjs test/subagent-supervisor-adapter.test.mjs test/subagent-dispatch-rpc.test.mjs && npm run typecheck:subagents-enhanced`

## R2：steer 幂等检查先于 pending 检查

**现象：** `resolveSupervisorControl` 中 receipt 查询在 pending 检查之前。若某 steer 已成功投递（有 receipt），之后同 run 收到**新的** pending Supervisor request，此时重试旧 steer（同 payloadDigest + 同 liveRunEpoch）会命中幂等返回旧 receipt，而不是 `SUPERVISOR_REPLY_REQUIRED`。

**证据：** `supervisor-control-plane.ts` `resolveSupervisorControl` 的检查顺序：`receipts.get(key)` → `pending && steer → REPLY_REQUIRED` → ...

**影响：** 单投递不变量仍成立（不二次发送），但模型可能误以为 steer 已生效而结束 turn，漏掉对新 pending request 的 reply。属语义边界而非双投递。

**建议方案（二选一，需技术决策）：**
1. 将 pending 检查移到幂等检查之前（保持"有 pending 一律优先 reply"的严格语义）——注意这会改变 reply 重试路径，需回归既有 66 个 membrane 断言。
2. 保持现状但在幂等返回的 receipt 中附加 `pendingNotice` 提示字段（TUI/renderer 不改 raw payload 原则下仅新增 details 字段）。

**涉及文件：** 同 R1（同文件同测试面），建议与 R1 同批处理。

## R3：PI_REAL_BIN 环境限制

**现象：** `test/pi-subagents-runtime.integration.mjs` 与 `npm run test:subagents` 直接读取 `process.env.PI_REAL_BIN` 并在缺失时 fail（不是 skip）；本机该变量未设置。本机 `pi` 解析到 `/opt/homebrew/bin/pi`，`colima` 在 `/opt/homebrew/bin/colima`（daemon 状态未验证）。

**影响：** 真实 Pi 二进制的 crash/restart 场景（P4 计划的真实进程 lane）与 `test:subagents` 无法在本环境执行；P4 已用真实双 Node 进程路径先行覆盖核心边界，不阻塞其他工作。

**建议方案：** 向用户确认环境路径：显式 `export PI_REAL_BIN=/opt/homebrew/bin/pi`（并确认版本兼容 `0.85.1` + `pi-subagents@0.62.0`）或用 Colima 环境（参考 P0 报告 `/tmp/subagent-lifecycle-p0-colima-report.md` 的搭建方式）。环境就绪后补跑：
```sh
PI_REAL_BIN=/opt/homebrew/bin/pi node --test test/pi-subagents-runtime.integration.mjs
PI_REAL_BIN=/opt/homebrew/bin/pi npm run test:subagents
```

**注意：** `/tmp` 下的 P0 报告可能已被系统清理；如缺失，向用户索要或从 handoff（`.pi/handoff/context-handoff.md`）重建上下文。

## R4：init-pi 测试失败（HEAD 既有）

**现象：** `test/init-pi.test.mjs` 的 "init-pi.sh reproducibly installs Pi without reading OpenCode credentials" 失败，引用不存在的 `skill-overrides/external-llm-review/reviewer.py`。

**归因证据（已实证）：** commit `c35c596`（"refactor(skill): 移除 external-llm-review 覆盖目录"）删除了该目录，但测试期望未同步。**HEAD 干净导出（`git archive HEAD` 到临时目录）同样失败**，证明与生命周期批次无关。

**建议方案：** 按 provenance 分类属"production 数据/测试期望漂移"：更新 `test/init-pi.test.mjs` 与 `test/external-review-config-home.test.mjs` 中对 reviewer.py 的引用，使其与 `c35c596` 的删除决策一致（或恢复目录，取决于该 commit 的意图——需向用户确认）。修法走标准 TDD：先让期望测试在当前 HEAD 上 RED（已天然 RED），再做最小修复。

**验证：** `node --test test/init-pi.test.mjs test/external-review-config-home.test.mjs`

## R5：compat "local package source" 失败（HEAD 既有，优先归因）

**现象：** `test/pi-subagents-compat.test.mjs:244` "loads exactly one enhanced runtime and footer from a local package source" 报 `AssertionError: Missing expected rejection`——期望 `supervisor.execute("compat-status", { action: "status" })` 因 `SUPERVISOR_TARGET_UNAVAILABLE` reject，实际却 resolve。

**归因证据（已实证）：** **HEAD 干净导出同样以完全相同的断言失败**（同文件同行 `Missing expected rejection`），证明与生命周期批次无关。含义：HEAD 状态下该 fixture 中 supervisor target 的绑定/可用行为已与测试期望漂移。

**建议方案（先归因后修）：**
1. 调查该 fixture 中 `mode: "rpc"` 绑定链路：upstream pi-subagents runtime 何时注册 `subagent_supervisor`、何时经 `runtime-membrane.ts` 绑定到 adapter、status 调用为何 resolve（是绑定了真实 RPC target 还是返回了空结果）。
2. 判定漂移方向：是 production 行为合理演化（测试期望过时）还是 fixture 制造的非预期状态。按仓库"缺陷数据来源分类门禁"分类后再动手；unknown 一律 fail closed，禁止预防性兼容。
3. 修复后验证：`node --test test/pi-subagents-compat.test.mjs`（32/32）。

**警告：** 该测试加载真实 enhanced package 本地源，与生命周期批次改动有交集（`extension.ts`、`supervisor-adapter.ts`）。收尾 agent 若在此文件上工作，务必先重做 HEAD 归因（`git archive HEAD` 导出复跑）再下结论，不要默认它是生命周期回归——本批已证伪。

## R6：reviewer-agent 测试失败（用户预存编辑，需用户决策）

**现象：** `test/reviewer-agent.test.mjs` "reviewer and executor profiles keep configuration out of their operating instructions" 失败。

**归因证据（已实证）：** 工作区中 `pi/agents/reviewer.md` 有**用户预存的未提交编辑**（models 列表新增 `codex-pool/gpt-6-astra` 行 + 指令文案修改）；**HEAD 干净导出上该测试 2/2 通过**。该编辑早于生命周期批次（来自 gpt-6-astra 模型接入任务），且不在任何生命周期 WritePaths 内。

**处理约束：** 不得替用户回滚其未提交编辑。处理选项（交用户选择）：
1. 用户确认编辑无误 → 更新测试期望以匹配新 profile；
2. 用户放弃编辑 → 用户自行 `git checkout -- pi/agents/reviewer.md`；
3. 用户提交编辑后再同步测试。

## R7：BROKER_TIMEOUT 偶现 flake

**现象：** 全量 `npm test` 并发负载下 `test/root-subagent-broker.test.mjs` 偶现 `BROKER_TIMEOUT`（两次全量跑中出现一次）；单独重跑稳定 39/39 通过。

**归因：** 测试稳定性问题（负载下 5s RPC deadline 偶超时），非 production 回归。

**建议方案：** 低优先。可选：测试内对涉及真实 socket/timer 的用例增加容错（如 deadline 前的 busy-wait 让渡）或串行化该文件内重负载用例；不建议放大 production deadline 掩盖问题。

---

## 收尾批次建议

- **批次 A（代码，TDD）：** R1 + R2（同文件同测试面，一次派发）。
- **批次 B（环境）：** R3（先向用户确认 PI_REAL_BIN 路径，再补跑两条命令并记录结果）。
- **批次 C（HEAD 既有缺陷，先归因后修）：** R5 优先（需调查），R4 次之（需向用户确认 c35c596 意图）。
- **批次 D（稳定性）：** R7。
- **R6 单独走用户决策，不进代码批次。**

## 全局约束提醒（收尾 agent 必读）

1. 严格 TDD；先 RED（具体断言失败，非 module-not-found）再最小 GREEN。
2. 按仓库"缺陷数据来源分类门禁"归因：production 可达 / fixture 制造 / unknown。unknown 必须 fail closed 并补 provenance 证据，禁止预防性兼容。R5 尤其如此。
3. 工作区有大量未提交改动：禁止 stash/reset/clean/提交；只能按任务 WritePaths 修改。
4. 不读取或输出任何 token/secret/凭据。
5. 主机 `pi/settings.json` 的 `enabledModels` 变更不得提交；`pi/models.json` 本机定义不提交。
6. 派发 subagent 遵循 `subagent-dispatch` skill；reviewer 需用户逐次授权。

## 关键文件索引

- 生命周期总计划：`docs/plans/2026-09-20-subagent-lifecycle-overall.md`
- 执行 handoff（含各阶段验收记录）：`.pi/handoff/context-handoff.md`
- P4/P5 调研报告：`.pi/handoff/p4-p5-readiness.md`
- P6 fresh-context 证据：`.pi/handoff/p6-fresh-context-baseline.md`、`.pi/handoff/p6-fresh-context-postupdate.md`
- 控制面实现：`packages/pi-subagents-enhanced/src/subagent-dispatch/supervisor-control-plane.ts`（接线在 `extension.ts` + `extensions/subagent-runtime.ts`）
- orphan recovery：`packages/pi-subagents-enhanced/src/subagent-dispatch/recovery-resume-orchestrator.ts`
- scheduler outcome：`src/task-scheduler/adapter.ts` + `pi/extensions/task-scheduler.ts`
