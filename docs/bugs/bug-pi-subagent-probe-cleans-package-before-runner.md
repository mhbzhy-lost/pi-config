# Bug：兼容性测试在 detached runner 启动前删除临时 package

## 1. 现象

stable RPC `spawn` 已返回真实 `runId` 和 `asyncDir`，但测试读取 `status.json` 得到 `ENOENT`；asyncDir 中只有 runner stdout/stderr 日志。

## 2. 影响

任何 async lifecycle 验证都会在首个 artifact 前失败，无法区分 runtime incompatibility、child 启动失败和测试清理竞态，也无法继续 status/interrupt/stop/nested safety。

## 3. 稳定复现

运行 `PI_REAL_BIN="$(command -v pi)" node --test test/pi-subagents-runtime.integration.mjs`。spawn reply 成功，随后 `status.json` 不存在。读取对应 `runner.stderr.log` 稳定显示临时 package 内 `node_modules/jiti/lib/jiti-cli.mjs` 不存在。

## 4. 证据

runner stderr 明确为 `MODULE_NOT_FOUND`，路径位于本次测试的 `mkdtemp()` package root。RPC spawn 是 detached async；外层 Pi command 返回并因 stdin EOF 退出后，测试可能进入失败/finally，当前 finally 无条件删除 packageRoot 和 projectRoot。runner 的入口和 jiti 依赖仍引用该 packageRoot，因此删除后无法启动，也不会写 status。

## 5. 根因

测试把临时 Extension package 当作父进程资源管理，但 detached child 的运行生命周期超过父 Pi RPC 进程。资源 cleanup 没有绑定 child terminal artifact，导致依赖目录被提前回收。立即读取 `status.json` 只是最先暴露该生命周期错误的位置。

## 6. 修复与验证策略

增加有界条件等待 helper：spawn 后保留 packageRoot/projectRoot，轮询 `status.json` 或 runner stderr；若 stderr 先出现则以有界 tail 报告真实启动错误。只有 child 进入 terminal artifact 或测试显式 stop 并确认终态后才执行 finally cleanup。禁止固定 sleep；超时信息必须包含 asyncDir 和脱敏后的 runner stderr。
