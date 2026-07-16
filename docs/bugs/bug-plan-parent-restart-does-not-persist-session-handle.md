# Plan Parent 重启后未能恢复已持久化的 Handle

## 现象

真实 Pi Parent 使用持久 session 启动 `/plan-run` 并正常退出后，session 目录仍为空；第二个 Parent 无法从 session branch 恢复 handle。

## 影响范围

运行中的 detached Plan child 失去 Parent 可见性；重启 Parent 会使恢复流程退化为未知计划，且不能证明原 run 继续存活。

## 复现步骤

使用 Pi 0.80.6、pi-subagents 0.34.0 与 deterministic provider，以 `--session-dir <dir> --session-id <id>` 启动 Parent，只执行 `/plan-run` 并在获得 handle 后退出。检查 session 目录为空；新 Parent 无法查询该计划。

## 根因

Pi 0.80.6 的 `SessionManager` 在 session 尚无 assistant message 时延迟首次落盘。`/plan-run` 是 slash command，Launcher 只通过 `appendEntry` 写 custom handle，不产生 assistant message；Parent 随后退出时既没有 JSONL，也没有其他 durable handle。依赖用户再发一次普通对话才能 flush 属于不可靠时序。

## 修复方案

Launcher 在 append session entry 的同时，将同一七字段 handle 原子写入可信 `var/plan-runs/<planId>/parent-handle.json`。查询优先使用当前 session branch，缺失时按 planId 读取并严格校验 sidecar；不得复制 tasks、Gate、attempt 或 validation 决策，也不得在 recover 时 spawn。

## 验证方式

新增 restart E2E：断言 session custom handle 唯一、recover response 对应原 runId、runner PID 在两 Parent 之间存活，释放 latch 后原 child validated；finally 清理所有 handle 进程树和临时目录。
