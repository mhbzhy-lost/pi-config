# Bug：Plan Runner 子任务完成后被父租约 watchdog 终止

## 1. 现象

Plan Runner 能成功绑定计划并派发一级 executor。Executor 完成实现、测试和提交后，Plan Runner 在读取 nested run 状态期间被 SIGTERM 终止，退出码为 143；计划只完成首个任务，未生成最终 `status.json`。

## 2. 影响

- 已完成的 executor 产出保留在 plan worktree，但后续任务不再调度。
- Plan Runner 被错误标记为 failed，父会话只能人工检查 worktree 和子任务产物。
- nested event 临时目录持续膨胀，状态查询和恢复操作越来越慢。

## 3. 触发条件

1. 主 Pi 会话启动 Plan Runner。
2. Plan Runner 按允许的层级派发一个 async executor；executor 未再派发子任务。
3. Executor 产生较多模型流式事件并运行数分钟。
4. Plan Runner 或父会话查询 nested run 状态/处理完成结果。

## 4. 证据

- Plan：`33855c03-c703-4148-820a-4e5e83b918e6`；Plan Runner：`741829e0-fb49-460f-b768-6d3b0a61a9e5`；executor：`34325367-a5b3-48ca-878a-517d10adb3ce`。
- Executor 退出码为 0，并提交 `d386324`；没有调用 `subagent`，仅调用 `contact_supervisor` 上报进度。
- Runtime wrapper 已使用 30 秒租约超时，不是旧的 5 秒配置。
- `parent-lost.json` 写于 `2026-07-21T13:51:10.952Z`，随后 Plan Runner 退出 143。
- Executor 的 `events.jsonl` 只有 369 行；对应 nested route 却生成 8,333 个文件，其中 8,330 个是 `subagent.nested.updated`。
- `subagent-runner.ts` 对每个 child stream event 调用 `writeStatusPayload()`，后者每次都写一个 nested updated 文件。
- `nested-events.ts` 仅保留最后 1,000 个 `processedEvents`；8,333 个事件下，每次投影会重新处理约 7,333 个旧文件。
- 当前临时目录共有 33,642 个 nested event 文件（132 MB）；目标 route 单次状态查询实测约 10 秒，逐文件冷读基准可达 176 秒。

## 5. 根因分析

### 已证实根因

pi-subagents 将高频模型流式事件放大为独立的 `subagent.nested.updated` 文件，同时 registry 只记住最后 1,000 个已处理文件。事件数超过 1,000 后，旧事件在每次状态投影时被重复同步读取和重放，形成随运行时间持续恶化的同步 I/O。

### 与 Plan Runner 退出的关系

Plan Runner 的父租约 heartbeat 和状态/完成处理运行在 Node 事件循环上，watchdog 在独立 Plan Runner 进程中检查租约。高开销同步投影与 nested async 调用阻塞期间，租约最终被判定为缺失、无效或过期，watchdog 写入 `parent-lost.json` 并发送 SIGTERM。

当前 `parent-lost.json` 未记录判定原因、观察到的 lease 内容和 lease age，因此“缺失 / 无效 / 过期”三者中具体是哪一种仍缺少直接证据。这是诊断信息缺口，不影响已确认的 nested event 放大问题。

## 6. 修复方向与验收

1. pi-subagents：只在状态语义变化时发 nested updated，忽略流式 delta；避免每个 stream event 都写文件。
2. pi-subagents：registry 不应通过截断 `processedEvents` 导致旧事件反复重放；改为单调游标、归档/删除已处理事件，或保留完整已处理集合。
3. Plan Runner：`parent-lost.json` 记录 reason、lease age、observed parent PID/lease，便于区分真实父进程丢失和事件循环停顿。
4. Plan Runner：租约 heartbeat 应与主事件循环隔离，或 watchdog 在父 PID 仍存活时对短暂 heartbeat 停顿采取宽限策略。
5. 验收场景：单个 executor 产生 10,000 次 stream update 时，nested route 文件数保持有界；状态查询稳定在秒级以内；Plan Runner 能继续调度后续任务并完成所有门禁。
