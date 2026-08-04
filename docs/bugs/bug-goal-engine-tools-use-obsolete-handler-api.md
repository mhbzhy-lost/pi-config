# Bug：Goal Engine 工具仍使用过期的 handler 接口

## 1. 现象

当前 Pi 会发现并展示 `goal_init`、`goal_status`、`goal_dispatch`、`goal_settle`、`goal_accept`、`goal_amend`、`goal_integrate` 七个工具，但真实调用时立即失败：

```text
definition.execute is not a function
```

真实证据来自 TokenRec workspace 会话：

```text
/Users/mhbzhy/pi-config/var/sessions/2026-08-04T13-15-14-158Z_019fcce9-fb6e-7ed2-a823-32b520e22127.jsonl
```

该会话先以完整 6-task DAG 调用 `goal_init`，随后以 2-task 最小 DAG 重试；两次均返回相同错误。失败发生在参数校验和 Goal Engine 业务逻辑执行前，`/Users/mhbzhy/tokenrec/.state/goal-engine/` 未创建。

## 2. 影响

七个 Goal Engine 工具的注册定义均只有 `handler`、没有当前 Pi `ToolDefinition` 要求的 `execute`，因此当前运行时无法可靠启动、恢复或推进任何 Goal。现有事件状态机、worktree、lease 和审计能力即使单测通过，也不能通过真实 Pi 工具入口使用。

完善期间不得用 Goal Engine 自身工具或 Plan Runner 工具执行、恢复或验收本修复，避免以尚未可信的控制面自证完成。

## 3. 稳定复现

1. 在任意 workspace 启动会加载 `pi/extensions/goal-engine.ts` 的 Pi 会话。
2. 使用 schema 合法的最小 task DAG 调用 `goal_init`，或调用只读工具 `goal_status`。
3. 观察工具层返回 `definition.execute is not a function`，且 workspace 中没有新增 Goal 状态。

也可直接注册 Extension 后检查定义：七个定义的 `typeof handler` 均为 `"function"`，`typeof execute` 均为 `"undefined"`。

## 4. 根因

`scripts/lib/goal-engine/extension.mjs` 使用旧式定义：

```javascript
pi.registerTool({
  name: "goal_status",
  // ...
  async handler(params) {
    // ...
  },
});
```

当前 Pi Extension API 要求工具实现五参数 `execute(toolCallId, params, signal, onUpdate, ctx)`，并返回标准工具结果：

```javascript
{
  content: [{ type: "text", text: "..." }],
  details: {}
}
```

Pi 仍能读取工具名称、描述和参数 schema，所以工具会出现在可用列表中；直到调用阶段才访问不存在的 `definition.execute` 并失败。

## 5. 促成因素

1. `test/goal-engine-extension.test.mjs` 的 mock 只收集注册对象，并直接调用 `.handler(params)`，复制了错误接口。
2. 测试没有通过真实 `DefaultResourceLoader`、`createAgentSession` 和 `getToolDefinition(...).execute(...)` 加载 Goal Engine Extension。
3. `npm run doctor` 当前不检查 Goal Engine 工具是否具有可执行定义。
4. 54 个 Goal Engine 测试覆盖领域逻辑和 mock Extension 行为，却没有覆盖当前 Pi ABI（应用二进制接口）。

## 6. 修复与验证策略

严格执行 TDD：

1. 先增加 RED，要求七个注册定义都有 `execute` 且没有公开 `handler`。
2. 增加真实 Pi host RED：通过 `DefaultResourceLoader` 加载 `pi/extensions/goal-engine.ts`，从 session 取得 `goal_status` 并调用 `execute`，期望返回标准 `content/details` 结果和 `NO_ACTIVE_GOAL`。
3. 最小修复注册适配层，将现有领域 handler 的返回值包装为 Pi 工具结果；业务异常继续通过 throw 表示失败。
4. 将现有 Extension 测试统一改为通过五参数 `execute` 调用，禁止测试再次依赖 `.handler`。
5. 重跑 Goal Engine、真实 host、Doctor 和 Skill 白名单门禁。

验收命令至少包括：

```bash
node --test test/goal-engine-extension.test.mjs test/goal-engine-runtime.integration.mjs
node --test test/goal-engine-*.test.mjs
node --test test/doctor.test.mjs test/skill-whitelist-extension.test.mjs
npm run doctor
```
