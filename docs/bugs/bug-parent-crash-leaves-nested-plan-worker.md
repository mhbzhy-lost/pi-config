# Parent Crash 后遗留 Nested Plan Worker

## 现象

Parent Pi 被 `SIGKILL` 后，lease watchdog 正确写入 `parent-lost.json`，顶层 Plan Runner 进入终态并退出，但本次 Plan 派发的 executor runner/child 仍在运行，成为孤儿进程。

## 影响范围

Parent 异常崩溃且 Plan Runner 当时存在 active nested `pi-subagents` worker 的场景。无 active worker 的 Plan 和正常 Parent shutdown 不受该残留影响。

## 复现步骤

用 latch 保持 executor running，获得顶层 handle 后 `SIGKILL` Parent。等待 lease timeout：marker 出现、顶层 async status terminal、顶层 PID 退出；随后按 origin/package 路径扫描进程，仍能看到 nested executor runner 与 child Pi。

## 根因

`pi-subagents` 的每层 async runner 都使用 `detached: true` 与 `unref()`。watchdog 当前只向 Plan child Pi 自身发送 `SIGTERM`；顶层 runner会随该 child 退出，但 nested executor 已拥有独立进程组。Plan Capsule 的 `session_shutdown` 仅停止 Plan control，没有把 shutdown 传播给已绑定的 nested run。

## 修复方案

采用结构化取消而非扫描系统进程：Plan Runner dependencies 跟踪已绑定且未终态的 nested run ID；Plan Capsule 在 `session_shutdown` 时通过 stable RPC 对这些 owned runs 调用 `stop`，等待请求完成后再结束自身。只处理当前 Plan 明确持有的 run ID，不触碰无关 PID。

## 验证方式

先用单元测试证明 active nested run 在 session shutdown 时收到一次 stop，终态 run不重复；再重跑真实 Parent crash E2E，确认 marker、顶层 terminal、runner PID退出，且 origin/package 无任何 nested runner/child 残留。
