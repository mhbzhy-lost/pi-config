# Bug: Host runtime 测试短时限与 PID 复用导致全量回归抖动

## 症状
`npm test` 在 production Host 合同均未变化时随机失败两个用例：parent-exit helper 在 2 秒内未写出 Host pid；identity fencing 用例 cleanup 对进程组发送 `SIGKILL` 返回 `EPERM`。在高负载下组合运行可重复，单独运行有时通过。

## 影响
全量回归不能稳定区分 Host 行为回归与测试基础设施时序。IR Task 9 无法形成可信绿色门禁；cleanup 还可能把已经退出并被系统复用的 PID/进程组误当成当前测试拥有的 Host。

## 复现
运行 `npm test` 或组合运行两个Host测试。Node helper需要启动第二个进程、创建RPC Host、等待session ready后才写pid，固定2秒预算在慢机器不足。identity测试向Host发SIGINT后立即cleanup；原进程退出时PID/进程组可被复用，probe返回`EPERM`，cleanup仍尝试SIGKILL并抛错。

## 根因
测试helper把性能假设当协议：`waitForPidFile`默认2秒，低于真实多进程启动尾延迟。`forceKillProcessGroup`只把`ESRCH`视为无需清理，没有把`EPERM`解释为“当前测试无权且不得清理的进程组”，违反PID复用下的所有权边界。

## 修复
仅修改测试：把pid-file等待提升到有界10秒；`forceKillProcessGroup`发送kill遇`EPERM`时直接返回，禁止操作非当前测试拥有的复用进程组。production Host timeout、identity fencing与进程控制实现不变；其它断言不放宽。

## 验证
先保留组合RED；修复后组合用例连续运行通过，完整`plan-host-runtime.test.mjs`通过，随后复跑`npm test`。确认真实Host stop/identity mismatch测试仍覆盖同所有者进程组的终止和fence。
