# Workflow leaf 启动被错误判定为超时

## 缺陷

typed coding facade 曾以固定的 30 秒 `workflowChildStartTimeoutMs` 等待真实的 `subagent:async-started` leaf 事件；因此 leaf 即使在 IR `execution.timeoutMs` 截止前启动，也可能错误返回 `WORKFLOW_CHILD_START_TIMEOUT`。返回的 workflow root binding 绝不能替代 leaf identity。

另一个实证缺陷是 lifecycle 关联使用了 RPC ping 的逻辑 `session.sessionId`，而持久化 leaf 的 `status.json` 使用 session 文件路径。真实失败 leaf `1417832d-baa7-4940-be1c-2d51ed66bbd6` 在约 400ms 内启动，`parentWorkflowRunId` 与 `workflowKey` 都正确；其 `sessionId` 是 `/Users/mhbzhy/pi-config/var/sessions/2026-08-11T04-32-46-668Z_019fef18-2c4c-7695-a4c0-deeb2d6ff1a8.jsonl`。`rpc ping` 分别从 `getSessionId()` 和 `getSessionFile()` 返回 `session.sessionId`、`session.sessionFile`，上游 `resolveCurrentSessionId` 的权威规则是 `getSessionFile() ?? getSessionId()`。错误传入逻辑 id 会过滤正确 leaf，最终在 30000ms 后产生假超时。

## TDD 证据

- **RED：** 先补入 persistent `sessionFile` 与逻辑 `sessionId` 不同的 lifecycle 单元测试；旧 adapter 传逻辑 id，正确 leaf 被过滤并返回 `WORKFLOW_CHILD_START_TIMEOUT`。
- **GREEN：** adapter 采用 `sessionFile ?? sessionId` 后，持久化 leaf 和 `sessionFile: null` 的 `--no-session` fallback 都可关联。
- 既有延迟 leaf 测试证明 coding 默认使用 IR deadline；generic 没有 `input.timeoutMs` 时仍使用有界 120000ms collector fallback。

## Inherited subagent marker fixture RED

在 subagent/CI 宿主中直接运行本 project facade integration 时，fixture 会继承 `PI_SUBAGENT_CHILD=1` 及 child runtime markers。它随后将未经处理的 `process.env` 传给 `buildTopLevelRuntimeEnv`，而 production top-level runtime 正确地拒绝该 child identity，导致测试在启动真实 Pi host 前失败。此 RED 不是 production probe 应放宽的理由；fixture 必须在构建 top-level env 前仅剥离 `PI_SUBAGENT_CHILD`、`PI_SUBAGENT_FANOUT_CHILD`、`PI_SUBAGENT_PARENT_SESSION`、`PI_SUBAGENT_RUN_ID`、`PI_SUBAGENT_ORCHESTRATOR_SESSION_ID` 和 `PI_ROOT_SUBAGENT_BROKER_ENABLED`，以便显式注入这些 markers 的真实 integration 不依赖调用方 `env -u`。

## Integration shutdown 竞态实证

project typed facade integration 单独执行通过，但与另外四项真实 integration 在同一 `node --test` 命令并行时稳定出现另一种假失败：matching leaf 已正确启动，约 **29ms** 后 Root Broker 在 parent RPC EOF 的 session shutdown 中将其停止，leaf `status.json` 的 `terminal.state` 为 `stopped`（`Subagent stopped by user`）。这不是 production shutdown 缺陷：root session 结束时停止尚未完成的 leaf 是 Root Broker 正确的 ownership 行为。

根因在测试 fixture：`runRpcUntil` 一观察到 `PROJECT_TYPED_PARENT_DONE` 就关闭 stdin；而 `compat_project_probe` 当时仅检查 start/execution/proof 后立即返回，未等待该 public `subagent` handle 的 matching structured `subagent:async-complete`。于是 provider 输出 parent done、harness 发送 EOF 与 leaf terminal completion 发生竞态。

修复是 fixture completion barrier，而非 sleep、轮询或放宽 shutdown：probe 从 extension 加载起缓存 structured completion events；execute 取得 typed handle 后先匹配缓存的 `runId`，否则注册单次 waiter。waiter 有 30000ms 硬期限，并在 completion 或 timeout 时清理 timer 和 waiter。只有 matching completion 到达后 probe 才返回，provider 才能输出 `PROJECT_TYPED_PARENT_DONE`，harness 才关闭 stdin。测试同时断言 completion `runId` 等于 typed handle、保留 lifecycle start、Root Broker ownership 以及 `status.json: complete` 验证。

## 不变量

- 保留 agent、workflowKey、parentWorkflowRunId 及 leaf `runId`/`asyncDir` 的严格过滤；缺失或冲突 identity 均 fail closed 并释放 listener。
- `sessionFile` 为非字符串、非 null/undefined 或空字符串时 fail closed；`--no-session` 仅可回退到非空 `sessionId`。
- typed handle 包含实际 leaf 的 `runId` 与 `asyncDir`，绝不包含 workflow root binding。
