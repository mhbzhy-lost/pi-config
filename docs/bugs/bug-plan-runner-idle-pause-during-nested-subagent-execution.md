# Plan Runner 等待嵌套 executor 时被暂停

## 1. 现象

plan-runner 调用 `subagent({ async: true })` 后，executor 正常执行，但调用方一直阻塞。
60 秒后触发 `needs_attention`，steer 无法进入正在执行的 tool call，最终 plan-runner
和 executor 一起进入 paused，计划停在 active attempt。

## 2. 稳定复现

通过 `plan_run` 启动含一个耗时超过 60 秒的任务：

1. plan-runner 执行 `plan_continue`；
2. LLM 调用嵌套 `subagent`；
3. executor 持续执行，plan-runner 无新事件；
4. runtime 报 `no observed activity for 60s`；
5. plan-runner 被暂停，executor 未提交最终结果。

## 3. 证据

失败 run `51a614d9-ec88-4502-b6a5-e0ef9414890e` 的日志显示：

- executor run `d2720dad-fbaf-4dbd-92f5-cda40f4ad13b` 已执行 34 次 tool call；
- plan-runner 一直停在 `currentTool=subagent`，没有 `tool_execution_end`；
- 两个 run 在同一时刻被 pause；
- acceptance failure 是中断后的结果，不是首要原因。

## 4. 根因

嵌套 child 的 `async: true` 只改变运行目录和生命周期记录，不保证调用方 tool call
立即返回。plan-runner 仍同步等待 child 完成，无法处理 followUp 或 steer。调大 idle
阈值只能延迟失败，不能解除同步阻塞。

修复后的 smoke 又发现两个独立契约问题：

- subprocess handle 的 `pid` 是 number，但 launcher 把所有 handle 字段都按 string 校验，
  导致启动成功后被误判为 incomplete，rollback 删除 runtime wrapper；
- 并行 executor 回调调用 `settleBoundAttempt(outcome)` 时总是结算第一个 active attempt，
  没有按实际退出的 attemptId 结算，导致 succeeded attempt 与 accepted task 错配。

## 5. 影响范围

- 单任务执行超过 idle 阈值时会被误暂停；
- 并行 frontier 可能只有部分 task accepted，`final-completeness` 失败；
- 非交互 smoke 若主 Pi 进程退出，会按设计停止其拥有的 plan-runner，因此测试 harness
  必须保持 parent RPC process 存活。

## 6. 修复

- plan-runner 不再持有 `subagent` tool；`plan_continue` 内部通过 `spawnPiAgent` 启动
  独立 `pi --mode json` 子进程；
- `spawnPiAgent` 返回原生 process `exit` 事件对应的 `exited` promise；
- executor 退出后主动执行 settle、review/accept、写 status，并发送 followUp 唤醒
  plan-runner；正常路径不轮询；
- `validHandle` 单独校验 numeric `pid`；
- `settleBoundAttempt` 接收 attemptId，按退出进程对应的 attempt 精确结算；
- `collectExecutorResults` 保留为恢复路径，与主动回调共用 `settleExecutorRun`。

## 防回归验证

单元测试：

- subprocess exit 触发 attempt settled、task accepted 和 followUp；
- task-2 先于 task-1 退出时，两项仍全部 accepted；
- launcher 接受 numeric pid handle；
- runtime spawn 返回可用的 process handle。

真实 `pi --mode rpc` smoke：

- 单任务：validated；
- 两个独立并行任务：均 accepted，validated；
- 两层依赖 DAG：按层派发，validated；
- verification 故意失败：任务 accepted，计划明确进入 blocked。
