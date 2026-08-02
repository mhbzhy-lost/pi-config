# Bug：Goal Engine Extension 使用进程 cwd 读写错误仓库状态

## 1. 现象

真实 Pi host 即使以临时业务目录创建 `DefaultResourceLoader`、`createAgentSession` 和 `SessionManager`，Goal Engine 仍可能从启动 Pi 的 `process.cwd()` 读取 `.state/goal-engine`，而不是从当前工具执行上下文的项目目录读取。

现有真实 Host 测试把 session cwd 改成临时目录后仍然通过，只是因为启动测试进程的仓库当前没有 `.state/goal-engine`。双 cwd 探针可以稳定观察到：

```text
stateInProcessCwd=true
stateInSessionCwd=false
```

## 2. 影响

从仓库 A 启动 Pi、再让 session 或工具在仓库 B 工作时，七个 Goal Engine 工具可能读取、创建或修改仓库 A 的 Goal 状态和 worktree，而向 agent 展示的 cwd 却是仓库 B。结果包括：

- `goal_status` 泄漏另一个仓库的活动 Goal；
- `goal_init` 把状态写入错误仓库；
- `goal_dispatch` 基于错误仓库 HEAD 创建 worktree；
- integrate、amend、accept 和 checkpoint 作用于错误 Goal；
- 测试错误地读取当前开发仓真实状态，无法保持隔离和确定性。

完善期间仍禁止用 Goal Engine 或 Plan Runner 工具编排、恢复或验收本修复；只允许 `node --test` 在两个临时 cwd 中直接执行 ToolDefinition 复现。

## 3. 稳定复现

1. 创建互不相同的临时目录 `processCwd` 和 `projectCwd`。
2. 将 Node 进程 cwd 切换到 `processCwd`。
3. 用 `projectCwd` 创建 Pi loader、session 和 SessionManager，并通过绝对路径加载当前 Goal Engine Extension。
4. 从 session 取得 `goal_init` ToolDefinition，以 `{ cwd: projectCwd }` 作为 execute context 调用。
5. 观察旧实现创建 `processCwd/.state/goal-engine`，而 `projectCwd/.state/goal-engine` 不存在。
6. finally 恢复原进程 cwd，再删除两个临时目录。

整个复现不读取当前仓库 `.state/goal-engine`。

## 4. 根因

`scripts/lib/goal-engine/extension.mjs` 在 Extension factory 执行时捕获：

```javascript
const cwd = pi.cwd || process.cwd();
const root = stateRoot(cwd);
```

当前 Pi 0.83 的真实 `ExtensionAPI` 不提供 `cwd` 字段，因此该表达式稳定回退到启动进程目录。后续七个 handler 和 `tool_result` hook 都闭包引用同一个 `cwd/root`，忽略 ToolDefinition.execute 与事件 handler 提供的 `ExtensionContext.cwd`。

Task 1 初版 adapter 虽接收五参数 execute，却把 `_ctx` 丢弃：

```javascript
async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
  return toolResult(await handler(params));
}
```

所以 ABI 外形已修复，状态归属仍错误。

## 5. 促成因素

1. unit mock 自造了 `pi.cwd`，与真实 ExtensionAPI 不一致，掩盖回退分支。
2. 初版真实 Host 测试只调用无副作用的 `goal_status`，没有断言状态落点。
3. 测试的 Node `process.cwd()` 恰好是当前仓库，与 Extension 路径所在仓库相同，未建立双 cwd 条件。
4. adapter 测试只验证 `execute` 存在和结果 shape，没有验证 execute context 被传给领域 handler。
5. `tool_result` hook 同样未使用其第二个 `ctx` 参数，恢复提醒也可能查询错误仓库。

## 6. 修复与验证策略

严格先写 RED：

1. 真实 Host 测试创建 `processCwd` 与 `projectCwd`，在不同 cwd 下调用隔离的 `goal_init` ToolDefinition。
2. RED 必须证明旧实现把 registry 写入 `processCwd`，而期望 `projectCwd/.state/goal-engine/registry.json` 存在。
3. adapter 将真实 execute `ctx` 传给领域 handler；统一 `executionScope(ctx)` 只接受非空绝对 `ctx.cwd`，不再读取 `pi.cwd` 或 `process.cwd()`。
4. 七个 handler 在每次调用开始时从 ctx 推导 `{ cwd, root }`；不得跨调用缓存 cwd/root。
5. `tool_result` hook 从其 `ctx.cwd` 推导 state root；缺少合法 ctx 时 fail closed，不读取进程目录。
6. unit mock 删除 `pi.cwd` 依赖，所有 invoke 显式传 execute context，增加缺少 ctx.cwd 时拒绝的测试。
7. 验证 project cwd 写入成功、process cwd 保持无状态、当前仓库状态从未被读取或创建。

验收命令：

```bash
node --test test/goal-engine-runtime.integration.mjs
node --test test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
node --test test/goal-engine-*.test.mjs
```
