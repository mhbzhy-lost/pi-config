# Bug：reload 将 session 文件路径误用为 Root Broker 身份

## 1. 现象

Pi 进程执行 `/reload` 时，`subagent-runtime.ts` 加载失败：

```text
rootSessionId must be a safe non-path identity
```

堆栈位于 `resolveCurrentSessionId -> RootBrokerServer.start -> brokerSocketPath`。

## 2. 影响

Root Broker 无法启动，extension reload 失败，后续 subagent 与 Plan Runner 都不可用。

## 3. 触发条件与证据

- `pi-subagents/src/shared/session-identity.ts` 的 `resolveCurrentSessionId()` 优先返回 `sessionManager.getSessionFile()`。
- reload 时 `getSessionFile()` 返回绝对 `.jsonl` 路径。
- `root-broker-protocol.ts` 的身份规则只允许安全、非路径 ID；该校验用于 socket/grant 隔离，不应放宽。
- 首次启动时 session file 可能尚不可用，函数退回 `getSessionId()`，因此普通启动测试未覆盖 reload 差异。

## 4. 根因

项目把上游“可用于通知关联的 session identity”直接复用于 Root Broker 的协议身份。两者契约不同：前者允许 session 文件路径，后者必须是稳定的非路径 session ID。

## 5. 修复决策

- 保留协议的严格身份校验。
- 为 Root Broker 增加专用解析函数，只读取 `sessionManager.getSessionId()` 并经过同一安全身份校验。
- completion notifier 继续使用上游 resolver，不改变其关联语义。
- 增加 reload 形态测试：manager 同时提供绝对 session file 和安全 session ID 时，Broker 必须选择 ID。

## 6. 验证

- TDD RED：protocol test 因缺少 `resolveRootSessionId` 按预期失败。
- GREEN：Root Broker protocol、typed RPC 和 membrane 聚焦测试 `42/42` 通过。
- SDK 真实路径：使用持久化 `SessionManager.create()` 调用 `AgentSession.reload()` 成功；reload 后 session file 为绝对路径、Root Broker 仍 active，Supervisor status 返回 `active=true`。
- `PI_REAL_BIN="$(command -v pi)" npm run test:subagents`：`3/3` 通过。
- `npm run doctor` 和 `git diff --check` 通过。
- 用户在原交互进程执行 `/reload`，确认 extension 正常重载且未再出现 Root Broker identity 错误。
