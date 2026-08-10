# Bug：Pi 0.84.1 使旧 TUI 测试夹具与 reload 监听断言失效

## 现象

将全局 Pi 从 `0.83.0` 升级至 `0.84.1` 后，`npm test` 中的自定义 footer 输入链和只读浏览器编辑器测试报 `TypeError: TUI is not a constructor`。另有真实 reload 测试在重试旧 runtime 的关闭债务时，预期旧 RPC listener 回应一次，实际没有任何 listener 回应。

## 影响范围

受影响的是测试夹具及其对 Pi 宿主生命周期的断言：

- `test/custom-footer-input.integration.test.mjs`
- `test/subagent-session-viewport.test.mjs`
- `test/subagent-runtime-production-shutdown.test.mjs`

项目的真实 RPC、Executor completion、Supervisor round trip 已在 Pi `0.84.1` 候选 binary 下通过；本问题不是 `pi-subagents@0.37.2` 的升级，也不涉及 Goal 数据或用户配置。

## 根因

Pi `0.84.1` 的 `@earendil-works/pi-tui` 公共入口不再导出可构造的 `TUI` 类；`TUI` 是 type-only 符号，实际的主屏实现为公开的 `TuiMainScreen`。旧测试直接构造 `new TUI({ width, height })`，因此在运行时失败。

同一版本修复了 extension event-bus listener 在 session reload/dispose 后仍存活的问题。旧测试把“旧 listener 在关闭债务重试期间仍可答复”当作安全条件；新宿主正确移除了该 listener，安全条件应改为“债务清偿期间没有旧或新 listener 答复，清偿后只有新 listener 答复”。

更深层的问题是：Pi 0.84 会为新 extension generation 创建新的 `pi.events` facade，而旧 `ExtensionContext` 会在 reload 后失效。原 runtime 以该 facade 作为 shutdown debt lane 身份，导致新 generation 看不见旧 debt 并提前启动。重试旧 debt 时若读取旧 `ctx.sessionManager`，又会触发 stale-context 错误。

## 修复边界

- 使用 `TuiMainScreen` 和可控的 fake `Terminal`，经 `start()` 捕获真实输入回调来测试实际输入分发；不得调用私有 `handleTerminalInput`。`test/helpers/pi-tui.mjs` 保留 `TUI` fallback，以维持仍被允许的旧 Pi 版本测试。
- 将 shutdown debt 在首次有效生命周期回调时绑定到稳定的 `sessionManager` lane；reload 的新 generation 先清偿该 lane，再启动 upstream/Broker。
- debt 重试使用新 generation 的 live context，绝不读取已失效的旧 context；债务清偿期间不允许任何旧或新 RPC bridge 应答。
- 不修改 `pi/settings.json`、Goal Engine、`pi-subagents` 或 TypeBox 版本。

## 验证

修复后运行：

```bash
node --test test/custom-footer-input.integration.test.mjs \
  test/subagent-session-viewport.test.mjs \
  test/subagent-runtime-production-shutdown.test.mjs
PI_REAL_BIN="$(command -v pi)" npm run test:integration
PI_REAL_BIN="$(command -v pi)" npm run test:subagents
```

预期：三组宿主兼容测试通过，真实 Pi RPC 与子代理运行时仍通过；与 Goal fixture、用户本机配置或历史测试契约有关的基线失败不在本问题修复范围内。
