# Bug：兼容性测试在异步 Extension command 完成前关闭 Pi RPC stdin

## 1. 现象

`/status-probe` 在 spawn 后轮询 stable status，外层 Pi 进程约 3 秒退出；stdout 只有 async widget 事件，没有 prompt response、目标 notify 或 extension_error。

## 2. 影响

任何需要等待 artifact、调用 status/interrupt/stop 或观察 nested child 的 Extension command 都会被提前 teardown。只有立即 notify 的 ping/spawn 测试偶然通过，无法验证真实长生命周期控制面。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test --test-name-pattern="stable status" test/pi-subagents-runtime.integration.mjs`。输出稳定只有两个 `setWidget` request，随后进程正常退出并因缺少 `PI_SUBAGENTS_STATUS_REPORT` 失败。

## 4. 证据

测试通过 `spawnSync(..., {input: oneJsonLine})` 启动 RPC mode。Node 在写完 `input` 后立即关闭 child stdin。Pi RPC mode 以 stdin 作为客户端会话生命周期；EOF 触发 shutdown。`/lifecycle-probe` 在 spawn reply 后立即 notify，能抢在 shutdown 前输出；`/status-probe` 至少等待一次 50ms 轮询，期间进程已 teardown。没有 extension_error，说明不是 handler 抛错。

## 5. 根因

测试把请求/响应式 `spawnSync(input)` 用于一个以持续 JSONL stdin 表示连接存活的协议。客户端没有持有 stdin 到异步 command 的完成信号，导致 transport 生命周期短于 command 生命周期。

## 6. 修复与验证策略

保留当前真实失败作为 RED；新增异步 `runRpcUntil()` 测试 helper，使用 `spawn()` 写入请求但保持 stdin 打开，按 LF 严格解析 stdout records，收到带指定 prefix 的 notify 后才 `stdin.end()`，并设置有界 timeout/kill。先让 status 用例 GREEN，再让后续 interrupt/stop/nested 测试复用同一 helper；不得用固定 sleep 延长父进程。
