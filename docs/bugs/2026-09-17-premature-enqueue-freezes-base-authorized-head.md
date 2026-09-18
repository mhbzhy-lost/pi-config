# 2026-09-17 过早入队固化 base 为 authorizedWorkspaceHead 导致 admission 死锁

## 现象

真实单 child 验收（qoder-pool/GLM-5.3-0.6x，`--roots 1 --subagents 1`）中，child 正常完成业务 commit（`096c4aa feat: 添加 parse 阶段`）并退出，durable resume 机制随后真实恢复 7 个 resumed child（每次 rebind、proof supersede 均正确），但 queue item 始终 `queued`、admission 从未发生，7 attempt 后 fail-closed preserve。

## 数据来源与调用链

- 现场：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/repository-merge-queue-acceptance-Jqo7D4`
- requestId 哈希反推（`sha256(repo\0root\0runId\0ws\0lease\0head\0ref)`）：queue item 由**初始 child `d57db300`** 在 **HEAD 仍为 base `f8ea609`** 时入队。
- 时间线：child spawn 21:57:49 → barrier release 21:57:51 → 工作回合（多 turn）→ commit `096c4aa` → run complete 21:59:23 → 7 次 resume（21:59–22:03）→ preserve。
- Pi 的 `agent_end` 在**每个 agent turn 结束**触发。GLM 的第一个 turn 是纯文本（无工具调用），agent_end 时 lifecycle `advance → prepareAutoIntegration` 以当时 HEAD（base）入队；bash commit 发生在后续 turn，之后的 agent_end 中 `prepareAutoIntegration` 命中 existing 早退，`authorizedWorkspaceHead` 永久固化为 base。
- `admissionFactsForClaim` 要求 `headCommit === authorizedWorkspaceHead`：HEAD（096c4aa）≠ 授权头（f8ea609）→ admission 永远失败（retryable，不 preserve）→ child 退出 → resume → 同一失败，循环至 attempt 上限。

## 首个偏离点

`child-integration-lifecycle` 首个 agent_end（无工具 turn）调用的 `prepareAutoIntegration` 以 base HEAD 入队；child 后续自有 commit 不再刷新授权头。

## 修复

`prepareAutoIntegration` 命中已存在的 `queued` autoManaged item 时，若当前 HEAD 是旧 `authorizedWorkspaceHead` 的**后代**（child 纯新增 commit）且 workspace clean，则刷新授权头为当前 HEAD（revision+1）；非后代/漂移时保持不变，由 admission 失败 fail-closed 进入人工处置。claim 阶段的完整 clean/descendant/writePaths 门禁不变。

RED/GREEN：`test/managed-workspace-integration-queue.integration.mjs` 新增「首个文本 turn 过早入队后，child commit 刷新授权头并完成 FIFO 集成」与「非后代 HEAD 拒绝刷新」两测试；真实验收重跑确认收敛。

## 分类

预期 production 数据未被正确处理（类别 1）：managed coding child 的多 turn 执行（首个 turn 无工具调用、业务 commit 在后续 turn）是合法 public 入口与正常事件顺序产生的真实数据；probe、R8 scripted fixture（首个 turn 即 toolCall）与此前 sol 模型行为均未覆盖该顺序。
