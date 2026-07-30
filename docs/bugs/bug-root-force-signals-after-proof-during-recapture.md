# Root force 在 recapture 期间已有 proof 后仍 signal

## 1. 现象

首次 deadline 后，`forceCleanup()` 重新捕获 birth identity。recapture await 期间可能与自然 terminal event 竞速，matching 的 valid observed proof 可在 recapture 尚未返回时到达。当前实现即使 recapture 返回 exact，也不重新检查 `terminalProofs`，而是继续安装 force waiter 并调用 `SIGKILL`。

## 2. 影响

已获得 official completion 的 run 会被不必要地强制 signal，并被标记为 `forcePending`，随后还会进入 post-force death probe。这既违背 official proof 优先于 signal 的边界，也可能对本已自然结束或正在完成清理的进程组施加额外终止动作。

## 3. 触发条件与证据

- graceful 首次 deadline 已到期，run 具备 verified initial birth identity。
- `captureProcessBirthIdentity()` 的 recapture callback 在 await 期间 emit matching valid observed proof，随后返回与初始值 exact 相同的 identity。
- 独立 RED 期望：close resolve、`signals === 0`、capture 调用两次（initial 与 recapture）。当前行为会调用 signal 一次。
- 当前 `forceCleanup()` 的顺序为 recapture exact 校验后直接 `waitForTerminal()`、`killProcess()` 与 `forcePendingRuns.add()`；recapture 返回后没有在安装 force waiter/signal 前检查 `terminalProofs`。

## 4. 根因

代码只在 force 入口前和 signal 后的等待分支检查 proof，遗漏了异步 recapture 形成的时间窗口。单线程事件循环不会阻止 await 期间 terminal event 更新 `terminalProofs`；因此“recapture exact”不等价于“仍无 official proof”。即使首次 recheck 通过，安装 waiter 也可能触发同步事件或其他微任务，故 signal 前仍存在一个需要关闭的窗口。

## 5. 处理决策

- recapture 完成且 identity exact 后、安装 force waiter 或 signal 前，必须重查 `terminalProofs`。若 proof 已存在，直接按 ordinary official completion 返回：不设置 `forcePending`、不 signal、也不做 post-force death probe。
- 若 proof 在首次 recheck 后但 signal 前到达，先安装 force waiter 后仍须在调用 signal 前同步再次检查 `terminalProofs`，以关闭该单线程窗口。
- 两次 recheck 都没有 proof 时才可 signal、设置 `forcePending` 并进入 force proof observation；signal 调用前 official proof 始终优先。

## 6. 验证

本文件为 docs-only 缺陷记录，不修改 production 或 tests。future GREEN 添加独立 RED：recapture callback emit matching valid observed proof 后返回 exact identity，`closeRootSession()` resolve，signal 数为 `0`，capture 数为 `2`。该用例当前 signal 一次；修复后不安装 force ownership、不进行 post-force death probe，并保持未获得 proof 的 exact force 路径仍可正常 signal。
