# Bug：动态 startup barrier 延迟立即 drain

## 1. 现象

candidate 的动态 startup collector 在 `startupBarrier` 初始为空时仍执行
`await Promise.resolve()`。因此 `closeRootSession()` 在该 microtask 返回前不会进入
Executor ordered drain；在同一调用栈中观察时，`stops` 仍为空。

既有 `Root session ordered drain retains cleanup debt after unknown terminal without birth identity`
立即断言期望两个 Executor stop，实际得到 `[]`。该测试此前为 GREEN，在 candidate 上为 RED。

## 2. 影响

当没有真实 pending startup 时，这一额外 await 违反 Executor drain 必须在同一调用栈 kickoff
的硬约束。late event 因而获得了延迟已知 Executor stop 的权限，并改变 root close 的关闭时序。

## 3. 触发条件与证据

- `closeRootSession()` 进入动态 collector，首次 `collectStartupBarrier()` 返回空集合。
- collector 未曾观察到任何 startup work，却仍在空分支 `await Promise.resolve()`。
- 调用方在不让出当前调用栈的情况下检查 ordered drain，两个已知 Executor 的 `stop` 尚未开始，
  所以 `stops=[]`。
- full 测试当前唯一失败为该 ordered same-stack 断言（line 1680）：预期两个 stop，实际 `[]`。

## 4. 根因

动态 collector 将两种空集合混为一谈：初始从未有 startup work 的空集合，以及已等待真实
barrier settlement 后的暂时空集合。为捕捉 settlement 尾部 microtask 新注册的 observation，
candidate 无条件在空集合时 yield；但初始空集合没有任何已知 settlement 可产生这种尾部注册。
无条件 yield 使 `closeRootSession()` 延后启动 known Executor drain，破坏 same-stack kickoff。

## 5. 处理决策

collector 记录 `observedStartupWork`。首次 collect 为空且从未看到 startup work 时立即 `break`，
不执行 await，让 ordered Executor drain 在当前调用栈启动。

只有至少等待过一轮真实 barrier 后，才允许一次空集合 microtask recheck，用于捕捉 settlement
尾部 microtask 注册的新 observation。继续保留 single fixed deadline：timer 可以在循环前创建，
但初始空集合立即 break 并在 `finally` 中 clear；不得为此引入 async yield 或续期 deadline。

## 6. 验证

- 不新增 RED：已有 ordered same-stack 测试在 candidate 上 RED、此前 GREEN，已覆盖初始空集合
  延迟 drain 的回归。
- 修复后 late-start 测试为 `2/2`，证明等待过真实 barrier 时仍能收集 settlement 尾部的 late
  observation。
- 修复后 ordered drain 测试为 `5/5`，证明无 pending startup 时两个已知 Executor stop 在同一
  调用栈 kickoff，且 unknown terminal 的 cleanup debt 仍被尝试。
