# Plan E2E 在 Runner 完成前关闭 Parent

## 现象

真实双 Plan E2E 获取两个 handle 后关闭 Parent RPC stdin，新的 `session_shutdown` 按设计停止 active runs；两个 Plan 均停在 `running`，90 秒内不会进入 `validated`。

## 影响范围

所有仍以“拿到 handle 即结束 Parent”作为成功条件的真实 Parent Launcher E2E。生产生命周期符合新需求，问题位于测试 harness 的 Parent 存活控制。

## 复现步骤

启动真实 Parent，连续 `/plan-run` 两个带 start gate 的 Plan；handle 到达后让 RPC helper 关闭 stdin。Parent 触发 `session_shutdown`，调用 stable stop 并释放 lease；随后等待 domain status `validated` 会超时，最后状态为 `running` 且无 gates。

## 根因

旧 E2E 将 detached runner 可跨 Parent 存活作为隐含前提，RPC helper 只支持基于输出 record 结束 Parent，没有支持“保持 Parent 存活，同时等待外部 lifecycle artifact 条件”的控制面。新 Parent-owned 语义使该前提失效。

## 修复方案

扩展 RPC test harness：保留原同步 `until` 行为以兼容其他场景，新增可异步等待 artifact 的 `closeWhen`，且只关闭一次 stdin。前置条件尚未满足而返回 `false` 时必须解除 pending，使后续 record 能启动 watcher；一旦 handle/agent-end 等前置条件满足，`closeWhen` 自身持续等待 artifact，不再依赖新的 stdout record。三个后台成功场景在 Plan `validated` 后才正常关闭 Parent；超时仍终止 Parent并执行 detached cleanup 兜底。

## 验证方式

真实运行 happy、unrelated、concurrent 三个 E2E，确认 Parent 存活期间 Plan 进入 `validated`，Parent 可处理无关 prompt，双 Plan artifact 隔离；关闭 Parent 后无 live runner/child 残留。
