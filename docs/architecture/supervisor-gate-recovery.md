# Supervisor 控制面与恢复边界

## 入口与权威

主 Host 注册 `supervisor_request_pending/status/reply` 及 `subagent_run_steer`。operation factory 固定内部 action 并拒绝额外字段；受控 reply 以 requestId 为权威，模型不能指定 owner。`extension.ts` 将 Host 不透明 tool-call ID 转换为带 root/run/kind 作用域的内部 `svi1-` 摘要，原 Host ID 继续原样传 native adapter。

`supervisor-control-plane.ts` 核对 owner 三态、owner generation、request generation、payload digest、live run epoch 和 child index。unknown/unavailable 不当作 unowned。待决请求只阻断其已证 child；scope 无法验证时 fail closed，不广播到所有 child。

## 投递与消费

native reply 成功仅提交 queued receipt；这解除对应 child 的 reply-required gate，不宣称已消费。原生 isError/throw 经补偿记录 failed，允许显式重试，不伪造 queued。重复请求沿 receipt key 幂等，跨 child/run/root 隔离。

Root Broker 接受可信 terminal proof 后，`supervisor-consumption.ts` 通过绑定的 canonical child session 核对 request、call、tool result、正文摘要和时间顺序，再提交 delivered/consumed。status complete 不等于消费 reconciliation 已落盘；真实 CLI fixture 需等待 durable consumed 事实，不能改 production 为提前 delivered。

## 持久化

state/request v2 明确 child index，合法 v1 严格读入并在首次 mutation 迁移；只读 diagnostics 不触发迁移或 TTL 写。每 root 事务在 durable lock 中重载最新状态。reply guard v2 的保存和重载前内存失效使用同一 root 前缀；保留原 durable 去重记录，不在 root close 中删除 guard 历史。

旧 Host 不保证理解新 v2 格式，不允许同 root 混用旧/新 writer。

## Inspect/clear 的限制

C1/C2/C3 仍 blocked-upstream。native pending 空数组无法区分 exact absence、wrong-session 过滤和读取失败。未实现 clear token、force、bulk clear 或直接删除请求。M4 的 scope-unverified steer 张力仍保留：缺少可靠 child scope 时阻断，不能用缺 inspect 作为放宽门禁的理由。

## 证据分层

- 历史 G1/G2/G2-wire 验收：[G2 acceptance](../plans/records/2026-10-15-supervisor-gate/acceptance.md)，历史 173/173 数字不回写。
- 操作工具 S6：[S6 acceptance](../plans/records/2026-10-16-operation-tools/acceptance.md)，历史 492/492 不冒充本轮文件清单。
- 本轮 H1/M1 与真实 CLI 结果：[当前验收证据](../plans/records/2026-10-17-runtime-convergence/current-validation.md)。
- `pi -c` guard 残留：[问题记录](../bugs/2026-10-18-pi-continue-durable-guard.md)。用户要求不再处理，该分支不妨碍其它修复推进，也不标成已恢复。
