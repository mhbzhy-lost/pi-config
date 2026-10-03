# Bug：authority 注册锁竞争吞码 + spawn 失败零回滚导致孤儿 run 重复执行

- 发现日期：2026-09-29
- 发现方式：真实生产动态验证（本会话三任务并行派发，第三个失败；用户在 TUI 观察到幽灵条目）
- 严重级别：P1（并行派发偶发失败 → 孤儿与重派副本并行重复执行 → 双倍 token 消耗；本例浪费 417k tokens）
- 分类：类别 1（预期 production 数据未被正确处理）——真实并行派发、真实文件锁竞争、真实孤儿执行；身份/时间/资源事实有效
- 完整诊断：var/upgrade/footer-bug-diagnosis.md §4（时序还原与代码链）；footer 显示侧已由 docs/bugs/2026-09-29-custom-footer-stale-running-and-missing-model.md 的修复覆盖，本记录只登记 runtime 侧三个修复面
- 用户决策：选 A 全修（2026-09-29）

## 现象

三任务并行 typed 派发（主会话 2026-09-29T08:37:05Z）：第三个派发（typed-f7156ce0，root 7fba8a95 + leaf 2bb5e33f）在上游 spawn 全部成功后，增强层 `registerAuthorizedRun` 抛 `authority_store_unavailable: authority_store_unavailable`（错误 message===code）。leaf 2bb5e33f 作为孤儿继续运行至 16:50 完成（exitCode 0，417,372 tokens），与重派副本 c3e551ca（16:37:26→16:58:41，615,345 tokens）**并行重复执行同一任务**。

## 根因（三个独立修复面）

1. **错误码被吞**（diagnosability）：`src/subagent-dispatch/authority-store.ts:43` `unavailable()` 把一切非 `DURABLE_REVISION_CONFLICT` 的 `DurableStorageError`（含 `DURABLE_LOCK_HELD`）包装为 `authority_store_unavailable`，底层错误码丢失、无日志——锁竞争与其他存储故障不可区分，诊断报告只能标注「时间证据支持的最可能解释」。
2. **锁竞争无重试**：`src/subagent-dispatch/durable-storage.ts:26-37` `acquireLock`：`wx` 失败 + 锁新鲜 ⇒ `DURABLE_LOCK_HELD`，无等待无重试；两个 generic 派发的 `createWithLease` 在同毫秒级竞争同一 authority-index 锁，先到者胜（51e8db30），后到者立即失败（2bb5e33f）。`root-broker-server.ts:376-455` `registerAuthorizedRun` 对瞬时锁竞争同样无重试。
3. **失败零回滚**：`src/subagent-dispatch/extension.ts:427-465` `spawnWorkflowLeaf` 失败路径 `finally { collector.cancel(); }`（:464）只取消事件收集器；对已 spawn 的 root/leaf 无任何 stop/interrupt/清理。错误上抛为 tool 失败后孤儿 run 继续执行，与重派副本并行重复消耗。

## 现场证据

- `var/tmp/pi-subagents-uid-501/async-subagent-runs/7fba8a95…/events.jsonl`：16:37:05.221 workflow.started → .488 child-status(started, childRunId=2bb5e33f) → .499 workflow.trace started → .515 workflow.completed（spawn 全部成功后才失败）
- authority-index entries = 51e8db30/c3e551ca/495daa1b，唯独缺 2bb5e33f（注册失败的直接物证）
- 主会话 jsonl line 78：toolResult `authority_store_unavailable: authority_store_unavailable`（message===code 即 :43 包装形态）
- 2bb5e33f 与 c3e551ca 的 status.json：并行时间窗重叠、token 合计 >1M

## 处置（用户选 A 全修，已全部落地并验收，2026-09-29）

1. **修复面 ①（错误码保留）✅**：`authority-store.ts` `unavailable()` 新增 `DURABLE_LOCK_HELD → authority_lock_contention`（附 cause）分支；默认分支保持 `authority_store_unavailable` 但附 cause；`cas_conflict` 与 `AuthorityStoreError` 直通分支原样保留。
2. **修复面 ②（有界重试）✅**：`root-broker-server.ts` 新增 `createAuthorityLeaseWithRetry`（3 次尝试、25ms 线性退避、总最坏附加时延 75ms ≪ 1s），仅对 `authority_lock_contention` 重试；两个 `createWithLease` 调用点（generic 直呼 + coding observation）均切换；确定性错误零重试。
3. **修复面 ③（尽力回滚）✅**：`extension.ts` 新增 `stopSpawnedRunsBestEffort`（去重、并行、逐个捕获），`spawnWorkflowLeaf` 记录已 spawn runId（leaf 先记录再委托 onBinding）+ catch 回滚；`executeGeneric`/`executeCoding` 的 authorizationRegistration 拒绝点同样回滚。尽力语义：stop 失败仅记日志不影响原错误上抛；复用既有 typed RPC client 的 stop control method（未新造协议、未改 rpc-client）。

## 验证（全部 TMPDIR=/tmp）

- RED→GREEN：`test/subagent-authority-retry.test.mjs` 5/5（修复前 4 fail/1 pass，失败均为待实现行为缺失；真实文件锁 + 真实 AuthorityStore 委托包装）；`test/subagent-spawn-rollback.test.mjs` 6/6（修复前 5 fail，`actual: []` 无任何 stop 调用）。
- 聚焦回归：root-subagent-broker + durable-lifecycle + retry 52/0；membrane 66/66；notify 集成 2/2；footer 聚焦 81/81；pi-shell 9/9。
- **全量门禁：984 pass / 0 fail / 1 skip / 1 todo**（基线 973 + 新增 11 用例）。

## 附带发现（类别 2：基线就红的 out-of-gate 测试）

验收过程中发现 `test/subagent-model-selection.integration.mjs` 有 3 个基线就红的用例：该文件为 `.integration.mjs`，不在 `npm test` 的 `test/**/*.test.mjs` glob 内，从未被任何门禁覆盖。经 HEAD 基线比对（`git show HEAD:extension.ts`）：Goal 契约预检先于模型发现/准入（基线有意设计，含 "production contract preflight" 注释）与 coding worktree:false 不注册 authority（dff0da9 解耦代理名称与运行授权以来的 workspace/grant gating）均为基线语义——测试期望描述的是从未存在的行为，与①②③及升级均无关。已修正测试期望对齐当前架构（8/8 绿）。是否把 `*.integration.mjs` 纳入门禁 glob 属产品决策，登记 HANDOFF 决策项。另：③子代理报告中「3 失败归因①②」系误判（其逆向实验结论「非③引起」正确），已由主 agent 基线比对定案。

## RED（已观察，全部转 GREEN）

1. ①：DURABLE_LOCK_HELD 场景抛出区分性 code（authority_lock_contention）且 cause 保留；未知错误保持原 code 且携带 cause ✅（retry 用例 1/2）。
2. ②：锁竞争时经有界重试后成功（同窗口二次得锁）；超限抛区分性错误；非瞬时错误零重试（attempts=1）✅（用例 3/4/5）。
3. ③：spawn 成功后注册失败时对已 spawn 的 run 发起 stop（断言目标 runId）；stop 失败不影响错误上抛 ✅（rollback 6 用例，含 stop 整体 reject 的尽力语义守护）。

## 关联

- 环境泄漏（authority 写旧仓目录）是独立缺陷（docs/bugs/2026-09-29-pi-shell-inherits-cross-repo-state-roots.md，已修复 pi-shell.zsh 侧）；本缺陷与跨仓泄漏无直接因果——单仓内并行派发同样命中（锁竞争时间证据见诊断 §4）。
