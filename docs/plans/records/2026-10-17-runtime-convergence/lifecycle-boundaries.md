# Heartbeat 与 session-owner 证据边界

## Heartbeat

历史 managed coding + worktree:true 父死实验已证明：单次受控父 Host 终止后，已登记 child 在 lease 期限附近自行退出；没有 child 补杀，残留进程为零。来源为 2026-10-13-heartbeat-acceptance.md，3/3 仅指历史单次授权实验。

这不证明 generic、binding-failed、detached、bash 后代、多 child 或更长 renewal 序列。本批不自动创建新的危险实验覆盖这些拓扑；保留 coverage-unverified，不预防性修改 watchdog。

旧 hb-vhjjea / hb-fTmWES / hb-iKUNgy / hb-BXRJmy active 证据根的 owner 已终止，缺当前合法 public 清理出口，仍 blocked-recovery。未读取、复用或删除这些旧根。

既有 heartbeat provider 已迁移 subagent_start / managed_workspace_status/dispose；正常 barrier 释放后通过实际 read probe.txt 结果记录 commandsRun，不再伪造空命令报告。该 fixture 源码修改不等于 prepare-only Host 重新跑过；正常结算端到端本批未运行，保留 fixture-code-updated/behavior-unverified。

## Session-owner

已存在真实 CLI 5/5 验收：active recent 阻断、-c 精确 free recent pin、no-extensions 不绕过、selecting picker 与持久 assistant；P3 历史单次终止恢复和非 PTY 边界也已验收，不重新列作未运行。

用户确认两个 Host 同时恢复同 session 已由前置门禁阻断；本批不围绕这一被阻断拓扑另建 scheduler 锁/存储系统。真正 SessionManager.open 失败路径和跨进程更广边界没有新证据，继续 coverage-unverified，不凭同 PID/串行 claim 外推。

外部 import 目标无 header 的链保持 fail-closed/blocked-upstream，不将受控 launcher 外的 CLI/SDK/RPC 声称为全覆盖独占。

## 处理结论

报告与边界归档完成；额外实验未授权/未运行不伪称行为完成。后续只有实际产品缺陷或具体用户验证需求才扩展覆盖；不因标题矩阵而改生产 fallback。
