# Coordinator 同步 Git admission inspection 阻塞真实 FIFO 验收

- 日期：2026-09-16
- 场景：五 child 真实冲突验收（`--roots 2 --subagents 5 --require-conflicts 4`）。

## 现象

真实 child 的 workspace 已提交且 Git 事实有效，但 probe 长时间停在 public-audit-settlement；短窗口现场显示多个 child 的 `prepare_auto_integration`/`advance_auto_integration` 相互排队。单 child 可通过，五 child 并发时 operation latency 明显放大。

## 证据

对 `inspectManagedGitWorkspace` 的每个同步阶段打点（现场 QZY2ct）：

- `identityMs`：约 0.40–0.53s；
- `merge-base`：约 35–60ms；
- `rev-list`：约 35–62ms；
- `status`：约 35–63ms；
- origin preflight：约 0.17–0.29s；
- 单次完整 inspection：约 0.77–1.00s。

多个 child 同时请求时，`prepare_auto_integration` 的 operation latency 达到 1.1–5.3s。coordinator server 在同一 Node 事件循环内使用 `execFileSync` 执行 Git；每个 broker coordinator request 又重复调用 `client.listOwned({ runId })`，随后 prepare/inspect/advance 再次 inspection，造成单例 coordinator head-of-line blocking。Pi runner terminal assistant stop 后 final drain 只有 1s，child 在第二个 advance 返回前可能被终止。

## 首个偏离点与调用链

合法入口：真实 coding child 的 `agent_end` → `prepare_auto_integration` → Root Broker `coordinator.request` → Host `connectRuntimeCoordinator` → `client.listOwned({ runId })` → coordinator `prepareAutoIntegration` → `enqueueIntegration` → `integrationAdmissionFacts` → `inspectManagedIntegrationAdmission` → `inspectManagedGitWorkspace`。

首个偏离点：多个 child 在同一 coordinator 上重复触发同步 Git inspection；请求不是错误数据，也不是 fixture 伪造状态。此前验证中的 `.pi/subagents` 属于合法 runtime metadata，已被 Git status 排除，不是本次阻塞根因。

## 分类

预期 production 数据未被正确处理：数据来自合法 typed/public dispatch、真实 workspace、真实 Git 和正常事件顺序；按 production 缺陷处理。验收 harness 只负责暴露 latency，不以提高整体 timeout 作为修复。

## 修复方向

1. 在可信 Host runtime 内缓存每个 `runId` 的 trusted workspace binding，避免同一 run 的 prepare/inspect/advance 每次重复 `listOwned` 扫描；缓存只存由 coordinator 权威返回的 workspaceId/leaseId/ownerScope/runId，失败不缓存，run 关闭时清理。
2. 对同一 workspace/run 的 admission facts 做短生命周期、版本绑定的共享结果或 admission-flight 去重，避免并发重复同步 Git inspection；不得绕过 origin/HEAD/writePaths/CAS 校验，任何 workspace HEAD、origin HEAD、lease/revision 变化都必须失效。
3. 保留 timing diagnostics 作为 RED 证据，修复后移除临时 stderr/file 打点；不得通过延长 final-drain 或 acceptance timeout 掩盖同步阻塞。

## RED→GREEN

- RED：同一 run 连续执行 prepare/inspect/advance 时，当前 runtime 每次调用 `listOwned({ runId })`；测试锁定调用次数为 1，并验证不同 run 不共享 binding，解析失败不缓存。
- GREEN：binding cache 与 admission-flight/事实缓存测试通过，现有 coordinator/workspace 回归通过，再复跑一次五 child probe。
