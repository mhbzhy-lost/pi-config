# Plan Runtime SIGTERM trap 初始化竞态

## 现象
`force kills a process that ignores SIGTERM` 用例偶发得到 `stopped`，而不是 `killed`。

## 影响
测试无法稳定验证 `stopAgent` 在宽限期结束后发送 `SIGKILL` 的分支。

## 根因
测试启动 shell 后立即发送 `SIGTERM`，此时 shell 可能尚未执行 `trap '' TERM`，因此会按默认行为退出。

## 触发条件
子进程调度延后，使父进程在 shell 初始化信号处理前调用 `stopAgent`。

## 修复方案
在测试中等待 shell 完成初始化后再发送终止信号。

## 验证
执行 `node --test test/plan-runtime-control.test.mjs`，确认强制终止用例稳定通过。
