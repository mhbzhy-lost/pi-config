# Bug：Spark provider 持续返回 upstream HTTP 502

## 1. 现象

通过项目 `subagent` facade 派发 `spark` 后，run 在执行任务步骤前失败，状态为 `failed`、acceptance 为 `rejected`，错误为 `OpenAI API error (502): {"message":"Upstream request failed","type":"upstream_error"}`。本轮性能验证未产生文件修改或测试结果。

## 2. 影响

适合单文件、低风险任务的 Spark 并行通道不可用，阶段计划失去一个执行槽位；若无证据直接重试，会反复消耗时间且无法判断仓库任务本身是否有问题。

## 3. 稳定复现

本轮 run `620a6aef-87b7-4704-838c-712bf8b7d6e5` 在约 18 秒后失败。此前同一会话已有两次 Spark assertion-only 派发在任何编辑前返回相同 upstream HTTP 502，Executor 通道同期可正常完成任务。

## 4. 证据

`subagent status` 明确报告 step `spark`、模型 `gpt-5.3-codex-spark`、错误类型 `upstream_error` 和 HTTP 502；没有合同校验错误、测试失败或 workspace 写入。同期 Footer executor run 已正常启动。

## 5. 根因

失败发生在 OpenAI Spark provider 上游请求边界，早于 child 任务执行。现有证据排除本地 dispatch IR、写路径、测试 fixture 和仓库实现；无法从本地状态进一步确定 provider 内部故障原因。

## 6. 处理与验证策略

不修改生产代码或 provider 配置，不在本轮持续重试 Spark。将相同完整 dispatch IR 交给可用的 Executor 通道，并保留原 run/session 作为外部服务证据。后续仅在独立 healthcheck 证明 Spark 恢复后重新启用；Executor 必须运行原 acceptance commands，避免把通道切换误当作任务成功。
