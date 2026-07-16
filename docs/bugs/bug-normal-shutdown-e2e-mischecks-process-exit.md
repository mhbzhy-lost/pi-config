# Normal Shutdown E2E 错误检查进程退出

## 现象

真实 Parent normal shutdown E2E 已观察到 runner terminal，但测试仍失败，并由 finally 报 `fallback cleanup must not perform the asserted shutdown`，看不到最初的进程检查异常。

## 影响范围

仅影响新增 normal shutdown E2E 的退出断言与诊断；生产 Parent stop、terminal artifact 和 lease cleanup 已执行到断言位置。

## 复现步骤

在 runner terminal 后执行 `process.kill(pid, 0)` 并断言返回 `false`。当 PID 已退出时 Node 不返回布尔值，而是抛出 `ESRCH`；随后 finally 中的 flag 断言再次失败并覆盖原始错误。

## 根因

测试误解了 Node 的 signal 0 API 合同，并在 finally 中放置成功断言。测试还通过等待读取超时来间接证明 lease 缺失，诊断不够直接。

## 修复方案

新增有界条件 helper：轮询 signal 0，遇到 `ESRCH` 才判定退出；新增直接等待路径 `ENOENT` 的 helper。成功断言放在 cleanup 前，finally 只做无条件兜底清理，不覆盖原始失败。

## 验证方式

重跑 normal shutdown E2E，确认 Parent 正常退出、runner terminal、lease 缺失且 runner PID 在调用 `terminateDetachedRun` 前已不可达；再检查无临时进程残留。
