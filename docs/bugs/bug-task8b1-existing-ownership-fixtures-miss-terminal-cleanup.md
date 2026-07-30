# Bug：Task 8B1 使旧 ownership fixture 缺少 terminal cleanup proof

## 1. 现象

Task 8B1 production 开始要求 Root close 只在 official observed process-terminal 后 teardown。既有 `started ownership` 测试会创建 owned Executor 或 Plan Runner，但其 `t.after(() => broker.closeRootSession())` 不发送 terminal proof。单独运行 `started ownership records an exact verified executor entry from id-only event` 时，测试在 5006ms 后失败，进程继续保持监听，必须由外部 watchdog 终止。

## 2. 影响

即使新增 5 项 ordered-drain 行为全部 GREEN，完整 `root-subagent-broker.test.mjs` 仍会被旧 fixture 的 cleanup debt 阻断，无法证明原 82 项回归。若在 production 中对测试缺失 proof 做特殊降级，会破坏“stop ACK、async-complete 和 status stopped 都不是 terminal proof”的安全边界。

## 3. 触发条件与证据

- 旧 ownership 测试通过 `subagent:async-started` 建立 `ownedRuns`。
- fixture 的 fake upstream `stop()` 不产生 `subagent:process-terminal`。
- cleanup hook 直接调用 `closeRootSession()`，没有为已验证的测试假进程发送 matching runner instance、finite `observedAt` 的 observed proof。
- 父级严格串行运行单项测试，约 5006ms 后测试失败且 Node 不退出；这与 production 默认 `terminalTimeoutMs=5000` 精确对应。
- 新增 ordered-drain 五项已有自己的真实顺序与 debt fixture，不依赖这些旧 cleanup hooks。

## 4. 根因

旧测试建立于 Task 8B1 之前，当时 Root close 会无条件 teardown，因此 cleanup hook 无需表达进程终止。Task 8B1 将 official terminal proof 提升为关闭前置条件后，旧 fixture 仍把“测试函数返回”等同于“假进程已退出”，造成 fixture 合同过期。production 正确保留 server 和 listeners，反而让测试进程持续运行。

## 5. 处理决策

- 只修改 `test/root-subagent-broker.test.mjs` 的旧 ownership/lifecycle cleanup fixture，不修改 production。
- 提供测试专用 helper：对当前 `broker.ownedRuns` 逐项发送 schema-valid observed proof，包含 matching `runnerProcessInstanceId`、finite `observedAt` 和合法 runner `instances`，再调用 close。
- 仅在不验证 shutdown/debt/ordering的旧测试 cleanup 中使用该 helper；新增 5 项 `Root session ordered drain` 保持原样。
- 不使用 async-complete、stop ACK、status stopped 或 unknown proof 代替 observed proof。
- 校准后完整 suite 应快速 RED 于当前 production 的真实 socket union/kickoff缺口，而不是 5 秒 fixture timeout、cancel 或 open handle。

## 6. 验证

1. 严格串行运行 started ownership 与 lifecycle 相关旧测试，确认 cleanup 自然退出。
2. 严格串行运行 5 项 ordered-drain，确认仍由当前 production 的 3 个真实行为缺口失败，不出现测试进程挂起。
3. 严格串行运行完整 Root Broker suite，确认不再出现 5000ms ownership cleanup timeout；production GREEN 仍留给后续提交。
4. tests-only 提交只包含 `test/root-subagent-broker.test.mjs`，不暂存当前 `root-broker-server.ts` diff或用户其他改动。
