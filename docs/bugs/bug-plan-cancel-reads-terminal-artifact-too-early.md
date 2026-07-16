# Plan Cancel 在 Stop 后过早读取终态 Artifact

## 现象

真实 `/plan-cancel` 已收到 Plan child 的 matching acknowledgement，也成功调用 stable `stop`，但 Parent 立即报错 `Plan cancellation is not confirmed by a terminal artifact`。随后 artifact 才异步进入终态。

## 影响范围

所有真实运行中的 Plan Session 取消都可能失败；仅 mock 中让 `readRuntimeStatus` 立即返回终态的单元测试不会暴露问题。

## 复现步骤

启动一个保持 running 的真实 Plan child，发送 `/plan-cancel <planId>`。观察 child 写入 `plan.cancelled` 与 ack，stable stop 返回 `stopping`；Parent 紧接着只读一次 status，读到非终态并抛错。

## 根因

`pi-subagents@0.34.0` 的 stable stop 是异步控制请求，返回值只表示已进入 `stopping`，不保证 runner artifact 已终态。Launcher 将一次 status 读取误当作 stop 完成屏障；既有测试没有模拟 `running/stopping → terminal` 状态转换。

## 修复方案

保持“ack 后才能 stop”的顺序不变；stop 成功后按条件轮询同一可信 `asyncDir/status.json`，直到出现允许的 upstream 终态或超时。超时仍 fail-closed，并在返回文案中保留实际 upstream 终态。

## 验证方式

新增单元测试令 status 先返回 running/stopping、后返回 failed，确认 Parent 等待后返回领域 cancelled；真实 E2E 断言 request/ack 匹配、领域状态为 cancelled、upstream artifact 终态且无 command extension error。
