# Agent admission 生产 bootstrap 缺陷（R3）

## 现象

升级到 `pi-subagents@0.71.0` 后，真实 Host 在隔离 shell + fake provider 中，经 typed `subagent` 工具派发已知本仓 profile（`delegate`、`executor` 或 `reviewer`）时，在 child 创建前返回 `AGENT_ADMISSION_UNAVAILABLE`。现场没有 RPC `ping`/`spawn`，也没有 `runId`。T11b-1 场景 4–6 因此被阻断。

证据：`var/upgrade/trace/t11b1-steer/run5/{host.jsonl,events.jsonl,host.exit}`；总验收记录 `final-gate-report.md` 的 T11b 节。

## 数据来源与首个偏离点

- 数据来源：真实 production public 入口（隔离 Host 启动 `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`，再经 typed subagent 工具派发），不是手工 append projection/event，也不是测试 fixture 伪造的数据。
- 权威身份：Host 的 `ExtensionAPI`/`events` 与 `pi-subagents/agents` 的公开 `registerAgentViaEvents` 注册面；profile 身份来自本仓 `pi/agents/{delegate,executor,reviewer}.md`。
- 首个偏离点：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:506-512` 的 `defaultDiscoverAgents` 无条件抛出 `AGENT_ADMISSION_UNAVAILABLE`；`createTypedSubagentExtension` 在 `:1322` 默认采用该函数，而 production bootstrap `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:324` 只传入 upstream bootstrap，没有注册本仓 profile。
- 正确契约：0.71 公开契约第 2 节第 8 项要求方向反转：经公开 `registerAgent/registerAgentViaEvents` 注册本仓 agent，admission 只认已注册集合；未注册 agent 必须继续 fail-closed。

## 生成调用链

真实 Host 启动 → `subagentRuntime(pi)` → `installHeadlessTypedSubagentRuntime(pi, { bootstrap: upstreamSubagentRuntime })` → `upstreamSubagentRuntime` 安装 upstream runtime → typed `subagent` tool 执行 → `resolveSpawnModel` → 默认 `discover` → `defaultDiscoverAgents` → `AGENT_ADMISSION_UNAVAILABLE`；由于 admission 在 child 创建前失败，未发生 RPC ping/spawn。

## 静态测试为何未拦截

现有 compat 测试 `test/pi-subagents-compat.test.mjs:44-58` 只验证 facade 调用公开 `registerAgentViaEvents` 并检查事件形状；真实 bootstrap 没有同等注册接线。dispatch 单元测试多通过 `createTypedSubagentExtension(..., { discoverAgents() { ... } })` 注入测试 discovery，绕过了 production 默认路径。故静态测试能够证明公开注册 API 存在，却不能证明真实 Host bootstrap 已将 `pi/agents` profile 注册到 admission 集合。

## 分类结论与最小修复方向

这是“预期 production 数据未被正确处理”：profile 可由合法 public registration 入口注册，Host、事件顺序及身份均有效。采用方案 a：在 production bootstrap 初始化时，经 `registerAgentViaEvents` 注册本仓固定 profile；admission 仅查询公开注册集合，未知 profile 保持 `AGENT_ADMISSION_UNAVAILABLE`。不扫描目录、不调用 upstream 私有 discovery API，不修改 T7–T9 lifecycle/RPC/workspace 代码。

## 修复迭代记录（2026-09-28，R4 后续收敛）

- R3/R4 引入的 afterBootstrap 前无条件 activateEventSubscriptions() 破坏了 reload 门不变量：
  旧 shutdown debt 未偿还时，新 RPC 桥的事件订阅被提前激活（测试证据：
  test/subagent-runtime-production-shutdown.test.mjs:106 断言 replies=["old","old"] 实得
  [...,"new"]）。根因：注册需要激活的监听器，与门要求的延迟激活冲突。
- 修复：有未偿还 debt 时将注册（afterBootstrap）与激活一并推迟到 beforeSessionStart
  偿还点；无 debt 时保持立即激活+注册。admission 在 drain 期间不可用（fail-closed 语义一致）。
