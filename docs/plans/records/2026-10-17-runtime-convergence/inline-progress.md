# Inline 修复记录

用户已授权主会话 Inline 持续推进剩余事项。本记录只记已实际写入的实现，不把未完成的跨层验收写成完成。

## 当前更新（以本节为准）

- 收口权威状态已迁到 `closure-matrix.md`、`acceptance.md`、`fixture-inventory.md`、`settlement-window-audit.md`、`agent-profile-drift.md`；本文件以下条目保留为过程记录，与本节冲突时以新记录为准。
- 真实旧 workspace `a8f3cdf0-…` 已用当次 status token 完成 `preserve`（state=preserved）；`release` 返回 `MANAGED_WORKSPACE_TERMINAL`，属 H2 门禁预期 fail-closed，未 raw 删除。
- `test/subagent-model-selection.integration.mjs`（23/23）与 `test/subagent-auto-integration-real-git.integration.mjs`（4/4）的位置依赖已按工具名迁移；生产未改。
- 发现 `pi/agents/{delegate,executor}.md` frontmatter 漂移（`contact_supervisor` 消失、`DeepSeek-Flash` 首位候选），非本批脚本产物，未擅自回改，等用户裁决。
- 用户已要求停止处理 `pi -c` 锁阻塞，保留现场，不再清理锁。
- 既有测试/断言/fixture 可以随修复修改或删除；新增测试仍需明确授权。
- prepare/apply、queue settlement/receipt/replay、startup barrier 已实际接线。合同见 `workspace-disposition-contract.md`；当前验证和未覆盖范围见 `current-validation.md`。
- `subagent-managed-worktree.integration.mjs` 已将工具数组位置依赖迁移为精确工具名，5/5 pass，exit 0；另两份 fresh provider 的旧 subagent 名已迁移，未执行真实模型或危险实验。
- footer + wire 联合检查共 59 项通过，不能把这个数字写成 footer 独有数量。
- 新 disposition settlement 七个故障点尚无独立行为覆盖；不把旧 integration crash 四窗口当作替代。
- 以下“已实施/验证与限制”是首批修改快照，其中“prepare/apply 未完成”等描述已被本节更新，不作为当前状态。

## 已实施

- `supervisor-control-plane.ts`：`saveRoot()` 和事务重载前的 root 内存清理同时覆盖 `supervisor-reply-guard.v2:<root>:`，修复 v2 durable guard 重载后遗留在内存中的不对称。
- `supervisor-intent-id.ts`：新增 `svi1-` + SHA-256 的版本化内部 intent ID；reply/steer 入口保留原 Host tool call ID 给 adapter，只把内部 gate intent 改为安全 opaque ID。
- `workspace/service.ts`：bound release 不再使用 `challenge.used` shortcut；先执行同一 `resolveProof`，无 observed 且身份不匹配时拒绝。preserve 也持久化已观察 proof，供后续 release 审计。
- `workspace/coordinator-errors.ts`、protocol/client/server：加入严格可选 `errorInfo` 投影，保留原字符串 error；只传 code/detail/keypath，不传 Error/cause/stack。
- `workspace/disposition-contract.ts`、`ledger.ts`：加入 `workspace-disposition-prepare.v1` 严格子格式识别与 binding 校验；既有旧 pendingAction 仍按原 exact schema 读取。
- `workspace/disposition-facade.ts`、runtime/tool：public dispose/release 接入 coordinator client，并等待异步结果；读取和错误不再把 Promise 对象当成功结果。
- `integration-queue.ts`、coordinator server/service：加入严格 no-payload 事实投影和仅 coordinator 的 queue cancelled 结算入口；当前只在 discard、绑定和事实完整满足时结算队列。
- runtime policy：`AGENTS_SHARED/GLOBAL`、package AGENTS、writing-skills、writing-plans、TDD skill、外部 provider skill 和测试评估参考已收敛为“未经用户明确授权不得主动编写测试”；测试建议保留为待授权，不再强制 RED/GREEN。

## 验证与限制

- 首轮 focused 检查在旧断言修订后最终通过：`node --test test/supervisor-gate-wire.test.mjs test/workspace-operation-tools.test.mjs test/managed-workspace-service.integration.mjs`，36/36 pass；root/package `npm run typecheck` 在 import 修复后通过；`git diff --check` 通过。
- coordinator startup barrier 已实施：正常 listen 与 EADDRINUSE stale-socket 重听共用 `finishStartupRecovery()`，完成 proof replay 与 resume-intent pump 后才打开 `startupReady`；recovery 期间只允许 status/receipt/audit 读取，mutation 返回 `COORDINATOR_RECOVERY_NOT_READY`。完整 durable prepare/apply 与跨 ledger receipt/replay 仍未完成；fresh Host、真实旧 workspace 后置结算、旧 integration fixture 迁移和剩余专项来源分类仍未完成。
- 未启动真实 provider、网络安装、SIGKILL、当前 Host reload 或 raw workspace 删除；未提交或推送。
