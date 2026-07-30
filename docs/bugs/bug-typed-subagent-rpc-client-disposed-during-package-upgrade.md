# Bug：跨 session 后 typed subagent RPC client disposed

## 1. 现象

升级期间，其他已运行的 Pi 会话调用 `subagent` 时稳定返回：

```text
disposed: typed subagent RPC client is disposed
```

同一会话并行和顺序派发都无法启动任务。

## 2. 影响

受影响进程的 typed `subagent` 工具仍可见，但其闭包引用的 RPC client 已永久释放。继续调用只会重复失败，阻塞依赖 subagent 的 TDD、skill authoring 和并行工作流。

## 3. 触发条件与证据

- `scripts/lib/subagent-dispatch/rpc-client.ts` 在 `dispose()` 后固定拒绝所有调用并返回该错误。
- `createTypedSubagentExtension()` 的 `session_shutdown` handler 会执行 `rpc.dispose()`。
- Pi 的 extension 实例和已注册工具会跨 session replacement 复用；`session_shutdown` 后会在同一个 extension runtime 上再次触发 `session_start`。
- `pi/extensions/subagent-runtime.ts` 只在 extension 初始化时创建一次旧版 `rpc`；第一次修复又错误地把初始创建推迟到 `session_start`。Pi 某些启动路径会在 extension 加载前完成首次 `session_start`，因此用户复验得到 `not_started`。
- Pi 的 session event 顺序不保证 extension 能观察到成对的 `session_shutdown -> session_start`；用户在 eager-first-generation 修复后仍复现 `not_started`，证明某条 replacement 路径只让当前 facade 观察到了 shutdown。
- 正确模型是 extension 加载时立即创建第一代 client，`session_start` 主动 renew，并在工具调用时对空 generation 做惰性创建。
- `RootBrokerServer.closeRootSession()` 也会调用共享的 `upstream.dispose()`，因此 broker shutdown 与 typed 工具都会关闭同一个 client。
- 用户在完整退出后执行 `pi -c`，新进程继续旧 session 仍稳定复现；这推翻了“仅旧进程残留”和 npm `ETARGET` 升级窗口假设。
- 单 session 的 fresh integration 测试通过，只能证明首次 `session_start`，没有覆盖 `session_shutdown -> session_start`。

## 4. 根因

生命周期所有权错误：typed RPC client 实际是 session-scoped 资源，却在 extension 初始化时只创建一次。第一次 `session_shutdown` 永久释放 client，但 extension runtime、`subagent` 工具闭包和下一次 session 继续复用它。第一次修复将初始化完全推迟到 `session_start`，又遗漏了“首次 session event 早于 extension 加载”的启动顺序；第二次修复 eager 创建首代 client，仍错误假设 shutdown 后总能观察到配对的 start。最终模型必须同时支持 extension 加载时立即可用、可见的 session start 主动 renew，以及事件顺序缺失时首次工具调用惰性创建。

## 5. 处理决策

- 保持底层 typed client 的 fail-closed `dispose()` 语义。
- 在稳定 facade 中按 session 创建 client：`session_start` renew，`session_shutdown` dispose。
- typed 工具和 Root Broker 继续引用同一个稳定 facade，避免闭包持有上一 session 的底层 client。
- 增加跨 session 回归测试，不再用单 session integration 代表 lifecycle 完整性。

## 6. 验证

- TDD RED 1：缺少 renewable facade。
- 用户复验 RED 2：修复后返回 `not_started`；新增“facade 构造后立即可调用”测试，按预期失败于该错误。
- 用户复验 RED 3：eager 初始化后仍返回 `not_started`；测试改为 dispose 后不显式 renew，下一次调用必须惰性建立第二代 client，并按预期失败。
- 最终 GREEN：RPC 与 membrane 测试 `34/34` 通过，覆盖首次立即可用、显式 renew 和事件缺失时的惰性 renew。
- typed runtime/membrane 与非 Plan Broker 回归通过；Root Broker ordered-drain 的 5 项 Task 8 intentional RED 保持不变。
- `PI_REAL_BIN="$(command -v pi)" npm run test:subagents`：`3/3` 通过。
- `npm run doctor` 和 `git diff --check` 通过。
- 待用户在加载修复后的新 Pi 进程中复验 `pi -c`。
