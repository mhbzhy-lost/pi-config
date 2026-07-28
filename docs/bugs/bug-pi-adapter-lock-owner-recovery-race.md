# Pi Adapter 安装锁所有权与恢复竞争

## 1. 现象

多个 install/remove 进程竞争同一 r2cRoot 时，旧实现可能在释放或 stale 回收时删除后来进程持有的主锁；lock 文件打开后元数据写入失败也可能留下无法安全判断所有权的文件。

## 2. 触发条件

主锁持有者在 action 期间被另一进程观察，或两个等待者同时判断同一个 lock 已失效；以及 `open('wx')` 成功后 write/close 发生 I/O 异常。

## 3. 根因

主锁没有随机 owner token，release 直接删除路径；stale 读取与删除不在独立临界区，导致比较和删除之间可被其他 acquire 穿插。

已集成 owner token 与 recovery guard 后，仍有两个遗漏：可解析锁只根据 PID 是否存在判断存活，操作系统复用 PID 时会把无关进程误认为原持有者；`createdAt` 无效时也没有以文件 mtime 作为最大存活期的回退。另一个测试以 `chmod integrations` 制造 state 原子写失败，但特权用户可绕过目录权限，测试可能没有真正覆盖 `rename` 失败路径。

最终 review 发现此前的最大存活期仍错误地使用 `createdAt`。长时间 install/remove action 的 owner 即使 PID 存活，也会在创建五分钟后被等待者按 stale 回收，破坏互斥。主锁的 mtime 应表示最后一次 owner heartbeat；`createdAt` 只保留诊断元数据，不能参与活跃 owner 的 stale 判定。

另一个最终 review 发现默认 `spawnSync('pi', ...)` 在同一持锁 action 内逐个 agentDir 调用时会阻塞 Node.js 事件循环。多个 agentDir 的总耗时可累计超过 heartbeat TTL，定时器无法刷新主锁 mtime，等待者会把仍在运行的 owner 误判为 stale 并回收锁。

## 4. 影响范围

互斥保证会失效，安装状态可能被并发覆盖；正常持锁进程还可能在结束时误删其他进程的新锁，造成并行执行。PID 复用后，安装或卸载最多会被已不存在的持有者阻塞至人工清理；伪原子测试则可能让 state 写入回归无法被发现。同步 Pi 调用还会使多个 agentDir 的累计运行时间越过 TTL，触发活跃锁被错误回收。

## 5. 修复方案

主锁记录随机 token，删除前必须在 recovery guard 内验证 token。所有主锁 acquire、stale 清理与 release 都先持有短时 guard；guard 使用 `wx`、严格 deadline，且不进入 install/remove action 或执行自动 stale 抢占。

可解析主锁先采用 PID 探测：PID 已死立即 stale；PID 存活时仅在主锁 heartbeat mtime 超过五分钟后 stale，以处理 PID 复用或 owner 失联。持锁 action 期间以固定且显著小于五分钟的周期刷新 mtime；每次刷新均在 recovery guard 内重新验证 token。停止时先清除定时器并等待已开始的刷新完成，再在 guard 内按 token release。默认 Pi 调用改为不经 shell 的异步 `spawn` Promise；每个 child 60 秒超时，先 `SIGTERM`，短暂宽限后 `SIGKILL`。此前宽限期回调在发送 `SIGKILL` 后直接完成 Promise，但信号发送成功不代表子进程已关闭；安装锁会随 action 的 `finally` 提前释放，仍可能让下一次 install/remove 与残留 child 并发。timeout 只能标记超时和发送信号，成功启动后的 Promise 必须只由 `close` 完成，并在超时时返回 `null`；`error` 仅在尚未获得 child PID 的启动失败（含 ENOENT）时完成，已启动 child 的 error 不得提前释放锁。完成时统一清理定时器和监听器。无法启动（包括 ENOENT）仍为 nonblocking skipped，正常退出但非零仍为 failed。install/remove 均 await 每个调用，因此同步 fake 仍兼容，且等待 child 时 heartbeat 可继续运行。导出 state 原子写函数，并只接收可替换的 `rename` 操作以在测试中真实写入临时文件后注入失败，确认旧 JSON 不变且临时文件被 finally 清理。

## 6. 验证方案

覆盖错误 token 释放不能删除当前锁、guard 持有时超时且 action 不执行、stale recovery 在 guard 下串行、并发 state 始终可解析且无临时文件；覆盖旧 `createdAt` 加存活 PID 与新鲜 mtime 不 stale、存活复用 PID 加过期 mtime stale，以及错误/正确 token heartbeat 的行为。使用真实延迟可执行文件验证默认 Pi 调用等待期间事件循环定时器和 heartbeat 均可运行；使用短测试 heartbeat 间隔验证多个异步 spawnPi 串行总时长跨越多个间隔时 token 和 mutex 仍保持。覆盖真实 Node child 忽略 `SIGTERM` 时，短 timeout/grace 的命令 Promise 至少等待宽限期后的实际 `close` 才以 `null` 完成；覆盖 missing 与正常非零退出的分类不回归。直接调用原子 state 写入函数，先保留旧 JSON，再让真实临时文件写入后的 `rename` 抛错，验证旧 JSON 未变且不存在 tmp；删除依赖 `chmod integrations` 的伪原子测试。
