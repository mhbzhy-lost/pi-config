# Standalone Plan Host 泄漏 detached keeper 进程组

## 1. 现象

`test/plan-host-runtime.test.mjs` 的 14 个断言约 2 秒内全部通过，但 Node 测试进程超过
300 秒仍不退出。重复执行后，系统中持续累积 `pi-plan-host-*/fake-pi` 与 `sleep 3600` 进程。

## 2. 影响

完整 `npm test` 永久停在 `plan-host-runtime`，需要外部超时终止；真实 Root 进程关闭后也可能
遗留 keeper 子进程和打开的管道，违反 Standalone Host 可控停止与进程资源回收契约。

## 3. 触发条件

通过 `spawnStandaloneHost()` 启动 detached Host 后，调用 `stopStandaloneHost()`、
`interruptStandaloneHost()` 或测试直接向返回的 PID 发送信号。

## 4. 证据

- 单文件测试 14/14 通过后仍被 300 秒超时终止。
- `ps` 显示 29 个测试进程组残留，进程已由 PID 1 接管，命令仍包含临时 `fake-pi` 路径。
- `spawn()` 使用 `detached: true`，但默认 signal 调用 `process.kill(processId, signal)`，只处理 leader。
- keeper 左侧循环仍运行 `sleep 3600`，并继承 parent stderr pipe，因此 Node 无法观察 EOF。

## 5. 根因

Host 是 detached 进程组，但生命周期 API 把返回 PID 当成单进程处理。keeper shell 使用管道并在
左侧维持永久 stdin 生产者；leader 退出后，该生产者及其 sleep 子进程仍在同一进程组存活。
`child.unref()` 只解除 ChildProcess 引用，不会解除仍被后代持有的 stdio pipe。

## 6. 修复与防复发

默认 stop/interrupt 必须向已验证身份的 detached 进程组发送信号，并等待进程组而非 leader
收敛；keeper 改为单个 `exec sleep`，不再用可在 signal 竞态中重复 fork 的循环。Host stdout/stderr
直接继承 `0600` 日志文件描述符，readiness 从日志与精确 session 文件有界解析，Root 不再被 pipe
引用。测试清理统一按 PGID 兜底并断言组消失。

## 验证结果

- Plan Host 单文件 `17/17`，约 4 秒自然退出。
- 默认并发完整 suite 从超过 600 秒挂起降为 62 到 87 秒自然退出。
- 完成后 `fake-pi`、`sleep 3600` 与 keeper 测试进程残留均为 0。
