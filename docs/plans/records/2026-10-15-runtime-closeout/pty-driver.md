# P0：tests-only 受控 PTY 驱动与安全生命周期

任务：`docs/plans/2026-10-15-runtime-closeout.md` §5 P0。
前置执行者 `df655ce6` 未落盘任何代码（4 个 WritePaths 全部 `ABSENT`），本次从零实现，未覆盖未知现场。

## 1. 交付文件

| 文件 | 职责 |
| --- | --- |
| `test/helpers/controlled-pty-driver.py` | Python 3 标准库 driver：`pty.fork()` 直接 child、JSONL 控制协议、raw 输出 base64 事件、身份采样、一次性授权 SIGKILL、残留 artifact |
| `test/helpers/controlled-pty.mjs` | Node 侧 `startControlledPty()` 包装：请求 id 关联、UTF-8 增量解码、有界等待、幂等 close、拒绝外部 PID/group kill |
| `test/controlled-pty-contract.test.mjs` | 合同测试：只用自生成短命 Python fixture，不启动 Pi |
| 本文件 | P0 证据账本 |

不使用 `test/helpers/pi-process-group.mjs`（其负 PGID 强杀合同不适用）；未改动 `createTestRuntime` 的自动删除行为。

## 2. 冻结 API

```text
startControlledPty({command,args,cwd,env,cols,rows,artifactDir,deadlineMs})
  -> {pid, driverPid, leaseId, write(text), resize(cols,rows),
      waitForText(text|RegExp,timeoutMs), waitForExit(timeoutMs),
      signalFixtureKill(authorization), close(),
      sampleIdentity(timeoutMs), snapshot()}
```

`sampleIdentity()` 与 `snapshot()` 是冻结面之外的两个只读补充：P1 需要「即刻身份重核」与残留上报，二者都不触发信号、不改变生命周期。其余方法与合同一致；`write/resize/waitForText/waitForExit/close` 全部返回 Promise，`close()` 幂等。

请求校验（构造 lease 前即抛 `TypeError`）：`command` 非空字符串、`args` 字符串数组、`cwd`/`artifactDir` 非空、`env` 值全为字符串、`cols/rows/deadlineMs` 正数；出现 `pid/attachPid/attach/existingPid/pgid/processGroup/killGroup/descendants` 任一键即拒绝，因此不存在 attach 外部 PID 的入口。

## 3. 控制协议（Node ⇄ driver，JSONL）

- 请求：`start`、`write`、`resize`、`identity`、`signal`、`shutdown`；每个请求带自增 `id`。
- 响应：`{type:"response",id,ok,...}`；事件：`hello`、`data`(base64 raw PTY)、`eof`、`exit`、`residual`、`driver-exit`、`error`。
- Node 侧「先注册监听，再发动作」：`request()` 先写入 `pending` 表并挂有界定时器，再写 stdin；`waitForText` 在 Promise 构造体内同步注册 waiter 并立即回放已缓冲输出，调用方随后才 `write`。
- PTY raw 输出以 base64 事件传输，Node 用同一个 `StringDecoder('utf8')` 顺序解码，保证多字节字符跨 chunk 不丢；raw 字节同时由 driver 追加到 `<artifactDir>/pty-output.log`。

## 4. 安全生命周期门禁（实现事实）

- driver 只 `pty.fork()` 自己创建的 child，child 分支执行 `TIOCSWINSZ(初始几何) → chdir → execve(command, [command, ...args], env)`，失败 `os._exit(127)`，不回到控制循环。
- **不安装异步 SIGCHLD reaper**，主循环不收割：child 退出后仍是 driver 的未 reap zombie，PID 不可能被复用给别的进程。收割只发生在三个明确时点：master EOF、`shutdown`、`signal` 前置校验。
- 身份采样用 `ps -o lstart=,ppid=,comm= -p <pid>`，并仅在该子进程环境中固定 `LANG=C LC_ALL=C`（不改 child 环境、不改全局 locale）。首次采样发生在 exec 稳定/ready 之后（由调用方在 `waitForText(ready)` 后显式请求），记录为参考样本；**不拿 exec 前的 command hash 比对 exec 后**。后续采样为 birth + PPID 重核。
- `signal` 分支的拒绝顺序：无显式一次性许可 → group/后代键 → 无 child → leaseId 不匹配 → pid 不匹配 → 非 `SIGKILL` 字符串 → lease 已消耗 → `waitpid(pid,WNOHANG)` 显示已终止（立即记 terminal 并拒发） → ps 身份未知 → 未采样参考身份 → birth/PPID 不匹配。全部通过才 `os.kill(child_pid, SIGKILL)` 一次，并置 `kill_delivered`，随后有界 `await_reap` 取真实退出状态；响应中显式声明「SIGKILL 返回不等于退出证明」。
- Node 侧在 `leaseId/pid/signal/group` 任一不匹配时**根本不发送请求**（`sent:false`），避免把不匹配身份送到 driver。
- `resize` 只对本 PTY master 调 `TIOCSWINSZ`，并回读 `TIOCGWINSZ` 作为 `appliedCols/appliedRows` 证据；SIGWINCH 由内核投递给该 PTY 前台进程组，driver **不显式补发**，因此不存在双发。不触碰用户终端。
- 正常退出序列：上层若需先关 overlay / 清 fixture 草稿，自行 `write`；`close()` 发 Ctrl+D（`\x04`）→ 有界 `waitForExit` 等 reap → `shutdown` 让 driver 关 master 并退出。
- deadline 失败：driver 写 `<artifactDir>/residual-driver-<pid>.json`（含 reason、driverPid、childPid、leaseId、command/args/cwd、live 身份、参考身份、exit=null、outputBytes、outputLog、killDelivered），Node 另写 `residual-node-<pid>.json`；两者都**不杀 wrapper、不删临时根、不做 group kill**，只把 stdio/driver `unref()` 以免卡死测试进程，随后如实上报残留身份。
- control EOF（Node 侧关闭 stdin）时 driver 不擅自杀进程：若 child 仍存活则写 `control-eof` 残留证据后退出。

## 5. 合同测试范围

`test/controlled-pty-contract.test.mjs` 共 8 个 test，全部使用本测试写盘生成的短命 Python fixture（`tty-probe.py`、`resize-probe.py`、`stdin-exit.py`、`linger.py`），不启动 Pi、不接 provider/网络：

1. TTY(`isatty=true`)、child PID ≠ driver PID ≠ 测试进程、PPID == driverPid、birth 非空、身份重核 `matches`、约 144 KB CJK 输出跨多次 master 读取后完整且无 U+FFFD、自然 `exit code 0`、`pty-output.log` 保留且内容完整、干净退出无残留。
2. 初始几何 80x24 → `resize(100,40)` → `WINCH n=1 cols=100 rows=40`，再 `resize(60,20)` → `n=2`，静置 400 ms 后仍无 `n=3`，证明 SIGWINCH 单次由内核投递。
3. Ctrl+D 优雅退出（fixture `stdin.read()` 收到 EOF）+ 并发两次 `close()` 返回同一事实对象 + 第三次仍幂等。
4. `deadlineMs=400` 对 `sleep(2)` fixture：`close()` 有界返回 `exited:false`，残留 artifact 存在且 `childPid/driverPid` 正确、`killDelivered:false`、`exit:null`、`liveIdentity.present:true`；随后**不 kill**、等 fixture 自然退出（`code 0`）再 `close()` 成功，且先前 artifact 未被删除。
5. `startControlledPty` 对 `pid/attachPid/attach/processGroup/pgid` 入参一律 `TypeError`；非法 `command/args/cols/env` 亦拒绝。
6. 活着的 lease 上：`undefined`/非显式许可 → `unauthorized-missing-permission`；`pid+1` → `pid-mismatch`；错误 leaseId → `lease-mismatch`；`SIGTERM` → `unsupported-signal`；`group:true` → 本地 `TypeError`。全部 `sent:false`，之后 fixture 仍存活、身份重核仍 `matches`。
7. child 已终止后即使授权齐全也 `already-terminal-local`、`delivered:false`、`killConsumed:false`。
8. 账本 test：打印本测试自生的每个 childPid/driverPid 与真实 exit（code/signal/status）、残留计数与保留根；断言不存在「无退出事实的 lease」和「被信号终止的 child」。

合同测试**从不投递任何信号**：SIGKILL 分支只覆盖拒绝路径，`fixture-sigkill` 门禁留给 P3。

## 6. 验证状态

- 静态检查（实现阶段，未占用 unit-runner）：`node --check test/helpers/controlled-pty.mjs`、`node --check test/controlled-pty-contract.test.mjs` 通过；`python3 -c "ast.parse(...)"` 解析 driver 通过（无字节码写入）。
- 历史阶段曾因等待 unit-runner 未执行；恢复后的首次运行实际失败并超时，不构成通过。用户改为 Inline 后完成来源分类及最小 tests-only 修复，结果见下方回填。
- 待独占 unit-runner 后执行并回填真实 exit/计数：
  - `node --test test/controlled-pty-contract.test.mjs`
  - `PYTHONPYCACHEPREFIX=<本任务临时目录> python3 -m py_compile test/helpers/controlled-pty-driver.py`
  - `git diff --check`（含 untracked 现状）
- 父层附加约束（已遵守）：`sampleIdentity`/`snapshot` 只作 tests-only 只读辅助，不扩 attach 或 signal 权限；默认无 kill，8 个 fixture 全部自然退出、不投递任何信号；失败保留 artifact 与确切 owned PID，不删根。

### Inline 实测回填

- 首次失败来源：自生成 Python fixture 的 `os.isatty` 输出为 `True`，断言错误匹配 `true`；Node helper 将构造时禁止 attach 的 `pid` 检查错误复用到合法 signal 授权对象，导致拒绝路径提前抛异常。调用链为本测试→startControlledPty→本地 Python driver→自生成 fixture。均为 tests-only harness 缺陷，不改变 production。
- 最小修复：TTY 断言接受 Python 布尔值；授权只禁 group/descendant 字段，仍独立核对本 lease 的 pid/leaseId；账本放入 `test.after(async () => ...)`，失败路径仅对本测试自己的 lease 做 Ctrl+D 收口，不投递 kill。
- `node --test --test-reporter=tap test/controlled-pty-contract.test.mjs`：exit 0，**7 tests / 7 pass / 0 fail**，另一个 after 账本钩子完成。原记录的“8 个 test”是把账本也计为 test 的旧描述，以真实 runner 数字为准。
- `PYTHONPYCACHEPREFIX=<自生成临时目录> python3 -m py_compile test/helpers/controlled-pty-driver.py`：exit 0；字节码仅写临时目录，未写仓库。
- `git diff --check`：exit 0。
- 自生 child/driver PID：30088/30087、30106/30105、30126/30125、30144/30142、30167/30166、30185/30184；child 全部 code=0、signal=null、status=0。账本不将 driver 退出当 child 退出证明。
- deadline 场景保留根：`/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/controlled-pty-bounded-timeout-EhgQi9`，保留两份 residual artifact，child 随后自然退出。历史失败根继续保留，未因本次通过删除。
- 当前窄范围进程检查未发现 controlled-pty、driver 或 node --test 残留；该检查不是对历史未观测退出状态的补造。未发送任何 kill、未联网、未启动 Pi。

## 7. 残留风险与未验边界

- `ps -o lstart=` 为秒级精度：同一秒内两次 fork 的 birth 字符串可能相同，因此身份门禁始终叠加 PPID + 本 driver 未 reap 的直接 child 关系；不宣称 birth 单独可区分同秒进程。
- driver 进程退出时内核可能向该 PTY 前台进程组投递 SIGHUP。计划已裁定「wrapper 死后 SIGHUP 应能收子进程」不能当安全证明，故残留 artifact 中显式记录该事实，由父层决策，driver 自身不发任何信号。
- macOS 上 child 退出后读 master 抛 `EIO`，driver 按 EOF 处理；其它平台的差异未实测。
- `close()` 的优雅序列只有 Ctrl+D；Esc 关 overlay、Ctrl+U 清草稿属于上层 fixture 语义，由调用方在 `close()` 前自行 `write`，本 driver 不内置 Pi 专用按键序列。
- driver 单线程：`identity`/`shutdown` 等请求期间不排空 master（`shutdown` 与 `await_reap` 内部会排空），若 fixture 在 `identity` 采样窗口内写满 PTY 缓冲会短暂阻塞，不产生死锁但会拉长等待。
- 本 helper 不自动删除临时根；失败或产生残留时保留现场，路径由账本 test 打印。
