# Bug：异常 Root EOF Harness 未证明 SIGKILL 退出

## 1. 现象

在 `874b59c`，focused 异常 Root Harness 当前 `1/1 GREEN`，但其结果不能证明 Root 是由
`SIGKILL` 终止。测试调用 `rootChild.kill('SIGKILL')` 后仅等待 EOF 结果：没有检查 `kill()` 的
boolean 返回值，没有在 kill 前安装 Root 的 exit waiter，也没有断言退出结果为
`{ code: null, signal: 'SIGKILL' }`。因此 Root 自行退出同样可能产生 EOF，并被误当作强杀证据。

失败路径的 `t.after` 也只对仍存活的 child 调用 kill，不 await child 的 exit；cleanup 返回时不能证明
本测试启动的子进程均已退出。

## 2. 影响

该 Harness 会把 transport EOF 与进程终止来源混为一谈，不能覆盖异常 Root 被强制终止的关键契约。若
Root 已自然退出、kill 未实际发出或 signal 送达了错误的生命周期阶段，测试仍可能 GREEN。失败断言后，
未等待的子进程还可能残留并污染后续测试、占用句柄，或在测试完成后继续输出。

## 3. 触发条件

1. 异常 Root Harness 启动 `rootChild`，并通过关闭 EOF 作为结果观察。
2. Root 在调用 `rootChild.kill('SIGKILL')` 前或并发地自行退出，或者 `kill()` 返回 `false`。
3. Harness 仍收到预期 EOF，且没有 Root exit waiter 比对 code 与 signal。
4. 任一断言或异步步骤失败时进入 `t.after`；cleanup 对活进程 kill 后不等待其 `exit`，测试进程的
   cleanup 因而不能证明已无本测试子进程。

## 4. 根因

测试把 EOF 当成 `SIGKILL` 的替代证明，而 EOF 只说明管道端关闭，不能说明谁导致 Root 退出。当前顺序
在 kill 后才继续观察，没有保留可覆盖快速退出的 bounded exit waiter；同时忽略 `ChildProcess.kill()`
是否成功发信号的返回值，遗漏了 signal 发出与 Root 以指定 signal 退出两项独立证据。

`t.after` 仅尽力停止当时仍活着的 child，未把 cleanup 的完成与全部 child 的 exit promise 绑定；因此
失败路径缺少子进程收敛证明。

## 5. 修复方案

1. 在调用 kill 前安装 bounded Root exit waiter，且 waiter 必须处理 child 已经退出的情况，避免漏掉
   早于监听安装的 exit。
2. 调用 `rootChild.kill('SIGKILL')` 后断言返回 `true`，再 await exit waiter，并断言结果严格为
   `{ code: null, signal: 'SIGKILL' }`；EOF 仅保留为 transport 行为证据，不作为强杀证明。
3. `t.after` 对本测试创建的所有 child 执行必要的 kill，并 await 所有 exit promise 的
   `Promise.allSettled()`，使 cleanup 完成表示这些子进程已收敛。
4. watchdog 在正常、失败和 cleanup 路径均清除 timer，避免 timer 或未完成 waiter 保持测试进程。

## 6. 验证方案

1. 增加或校准异常 Root Harness：在 kill 前安装 bounded exit waiter，断言 kill 返回 `true`，并断言
   Root exit 为 `{ code: null, signal: 'SIGKILL' }`；仅 EOF 不得通过该用例。
2. 构造 Root 自行退出并产生相同 EOF 的情形，确认无法被误判为 SIGKILL 成功。
3. 构造 kill 返回 `false`、Root 已退出和断言失败路径，确认 waiter 不漏事件，且 cleanup 仍 await
   所有测试 child 的 settled exit。
4. 对 `test/root-subagent-broker.test.mjs` 及
   `test/fixtures/root-session-owner-child.ts` 的相关 Harness 运行 focused 与完整回归，确认 watchdog timer
   已清除且测试结束后无残留子进程。

本记录遵循先文档、再 tests-only 校准、最后修复 legacy v3 production 的既定顺序；本次不修改 tests 或
production。
