# 历史 RPC / Supervisor 个案当前归因

## 当前边界

D0–D3 诊断、G1/G2 gate 已实现。本轮 H1 修复 Responses opaque ID，M1 修复 v2 reply guard 保存/重载，fresh CLI ask/managed 两个场景已有实际通过证据。这些不自动证明 10-10 历史 incident 与本轮同因。

历史 RPC 缺少同次 ping/session identity/cwd/capability/protocol 对照，仍为 blocked-evidence；不扫描用户完整 session 或 authority 补猜。最小解阻字段为失败同次 diagnostic 中 code、stage、version/session/cwd presence、cwdEqual、missingCapabilities。

历史 Supervisor pending/reply/消费视图个案缺少 request/run/ownerGeneration/childIndex、登记→提交→native消费→terminal reconciliation 的同次时序，仍为 blocked-evidence。pending 可见或 reply queued 不等于 consumed。本轮 fixture 已修正 status complete 后读取 receipt 的竞态，真实 CLI 能最终达到 consumed/replied，但不能回填旧 incident。

## M4 与清理

scope-unverified 请求缺少可靠 child scope 时仍阻断 steer；保留 fail-closed 张力，不把它改成默认 child0 或全局广播。inspect/clear 缺少 exact absence：pending=[] 可能来自 wrong-session 或读取失败。C1/C2/C3 保持 blocked-upstream，无 token、force 或删除 fallback。

## `pi -c`

另列 2026-10-18 durable guard 问题；用户明确要求不处理。只保留错误信息改进与来源记录，不再索要 session ID，不做锁清理。

来源：runtime-closeout rpc-diagnostics.md、supervisor-diagnostics.md，Supervisor G2 acceptance 与 contract，当前 current-validation.md。
