# FIFO follower 在子进程退出后永久 queued（admission 等待不足）

- 日期：2026-09-15
- 发现场景：五 child 冲突矩阵验收（`--roots 2 --subagents 5 --require-conflicts 4`，现场 `repository-merge-queue-acceptance-qTTIUN`）probe 在 `public-audit-settlement` 超时。

## 现象（磁盘真相）

- seq 1（parse）`completed` 且已发布到 main（`44833c6 feat: 添加 parse 阶段`）。
- seq 2–5 永久停在 `queued`（attempt 1、无 conflictDigest、无 candidateHead），workspace `active`、identity 有效，audit proof debt ×4。
- coordinator daemon 已 idle-exit（stale）；无任何进程继续推进队列。

## 根因

Auto Integration 的 admission 是 child 拉取式：`advanceAutoIntegration` → 非 FIFO head 时返回 `queued`，由 child lifecycle 继续轮询。但 `createChildIntegrationLifecycle` 的默认 `maxAdmissionPolls=3、pollDelayMs=25`：

1. follower 在 awaited `agent_end` 内只轮询 ~75ms；
2. 之后走 `schedule()` 的 **unref 后台定时器** 并从 handler 返回；
3. Pi 0.85.1 无超时地 await `agent_end` handler（`core/extensions/runner.js` `emit` 纯 await）；handler 返回后 turn settle、child session 结束、子进程退出；
4. unref 定时器随进程消亡，队列侧无服务端驱动（daemon 只服务 RPC；`reconcileIntegrations` 仅在重启/reconcile 路径触发）；
5. seq 1 的集成（真实 LLM child 的 rebase+publish）耗时远超 75ms，followers 全部在 seq 1 完成前退出 → 永久 `queued`。

单 child 验收（1/1/0）从不成为非 head，因此从未暴露。

### 第一次修复尝试（在 awaited agent_end 内静默长轮询）被现场否定

子进程确实只在 awaited agent_end 期间存活，但 **pi-subagents runner 在终止 assistant 消息（terminal stop）后仅 1 秒就 SIGTERM 子进程**（`subagent-runner.ts` `startFinalDrain` + `FINAL_STOP_GRACE_MS = 1000`），唯一豁免是 `agent_end` 事件携带 `willRetry=true`——即 handler 内排队了 follow-up continuation（`child-protocol.ts` `projectChildLifecycle`：`agent_end willRetry → cancel-drain`）。证据链（UV0Vqv/cX14He 现场 broker/coordinator 诊断）：follower 的 `advance` 到达 server 返回 `queued` 后，循环死在下一个 `await delay()` 里（无任何退出诊断）；child `session_shutdown` 的 `inspect_auto_integration` 出现在 advance 之后；所有 child exit 0。冲突路径正是靠 CONFLICT follow-up 存活的；静默轮询违反 willRetry 契约，被 1s drain 杀死。此外脏 workspace 时 `prepare/advance` 抛 `MANAGED_WORKSPACE_INTEGRATE`（retryable，静默）属预期瞬态。

## 分类

预期 production 数据未被正确处理：数据由合法 public/typed 入口（真实 dispatch → prepare/enqueue → FIFO admission）产生，身份/时间/资源事实有效。按生产缺陷处理（本记录 + 精确 RED + 最小修复）。

## 修复

admission 等待必须骑在 follow-up 轮次上（与 runner 的 willRetry 契约一致）：

- `child-integration-lifecycle.ts`：紧凑轮询（`maxAdmissionPolls × pollDelayMs`，在 1s drain 窗口内）用尽仍为背压状态（queued/admitted/rebasing/prepared）时，在 `admissionWaitMs` 预算内发送 `subagent-integration-pending` follow-up（`deliverAs: followUp + triggerTurn`，指示模型不动文件、简短回复），下一轮 agent_end 重试 admission；预算耗尽才交回 durable `schedule()`/recovery 路径。
- 生产 wiring（`child-extensions/integration-queue.ts` 两处）：`admissionWaitMs: 20 * 60 * 1000`。
- 冲突续轮路径不变（CONFLICT follow-up 本就满足 willRetry 契约）。

## RED→GREEN

- RED：`test/subagent-auto-integration-lifecycle.integration.mjs` “follower continues on bounded admission follow-ups until head”——旧行为无 continuation、静默后台定时器，断言失败；预算耗尽用例锁定不再发 continuation。
- GREEN：lifecycle 聚焦 9/9；随后五 child 冲突矩阵复跑。
