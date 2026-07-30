# Bug：Root runtime 测试的 Jiti registry 分裂泄漏 socket

## 1. 现象

Root runtime fixture 通过 Jiti 加载 production extension 并成功启动 broker 后，测试侧以原生 ESM
`import` 取得的 `requireRootBroker` 却报出 `Root subagent broker is unavailable`。失败路径中的
`broker` 没有被赋值，测试的 `finally` 因而不能关闭实际启动的 server，遗留 listening server 与 socket。

## 2. 影响

该 fixture 不能可靠地取得真实 Root broker，导致 runtime cleanup、绑定保留和重试行为无法被校准。
失败测试还会把 socket 留在进程中，使后续用例受端口、句柄或异步资源污染影响，掩盖真正的 teardown
问题。

## 3. 触发条件

1. 测试使用一个 Jiti 实例加载 `pi/extensions/subagent-runtime.ts`，使 production extension 及其
   `root-broker-registry.ts` 依赖完成加载。
2. 测试同时通过原生 ESM `import` 加载 `requireRootBroker`（或 `unbindRootBroker`）。
3. 调用 runtime 的 `session_start` 后，测试从原生 ESM 模块导出的 registry 查询 broker。
4. 查询失败且尚未把真实 broker 赋给测试变量时进入 `finally`。

## 4. 根因

Jiti 加载 production extension 及其 registry 时形成独立模块图；测试原生 ESM import 的
`requireRootBroker` 不属于同一 `WeakMap`。因此 `start` 后测试从错误 registry 读取 broker 失败。
由于 broker 未赋值，`finally` 无法关闭真实 server/socket，造成资源泄漏。

## 5. 修复方案

测试必须从加载 production extension 的同一 Jiti 实例 import registry，并使用该模块图导出的
`requireRootBroker` 与 `unbindRootBroker`。fixture 同时加入 bounded watchdog 和显式关闭逻辑，确保
断言、启动或关闭任一阶段失败时仍关闭真实 broker/server/socket。此修复仅校准测试 fixture，不修改
production。

## 6. 验证方案

1. 以同一 Jiti 实例分别 import runtime extension 与 registry，`session_start` 后断言
   `requireRootBroker(pi)` 返回实际启动的 broker。
2. 人为令首次 `closeRootSession` 失败，确认同一 broker 仍可由 registry 取得；第二次 shutdown 后才
   unbind，并确认 server 已关闭。
3. 对 fixture 的正常、断言失败和超时路径运行 bounded watchdog，确认显式 close 被调用且没有遗留
   listening server/socket。
4. 运行 Root broker 与 runtime membrane 相关测试，确认 fixture 修复不改变 production 行为。
