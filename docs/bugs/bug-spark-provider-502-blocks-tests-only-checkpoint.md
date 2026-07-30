# Bug：Spark Provider 502 阻断 tests-only 检查点

## 症状

Task 5A tests-only 修正 run `8f8a8661-f4ef-49dc-a518-c7d847e3592d` 启动后立即失败，没有返回实现或错误摘要。Supervisor 状态显示 Spark step failed，acceptance rejected。

## 影响

`test/plan-coordinator.test.mjs` 的合同校准没有执行，Task 5A happy-path RED 检查点继续阻塞。仓库文件、Git HEAD 和用户未提交状态没有变化。

## 复现

读取 session `d5d18b61/run-0/session.jsonl`：`gpt-5.3-codex-spark` 在收到任务后连续四次返回 `OpenAI API error (502): Upstream request failed`，每次 input/output/cache token 均为零，且 session 不包含任何 read、edit、bash 或 commit 工具调用。

## 根因

Spark 所使用的上游模型 provider 在请求进入模型推理前返回瞬时 502。失败发生在仓库操作之前，与 dispatch contract 内容、测试 RED 状态和本地运行环境无关；运行时内建重试四次后仍未恢复，最终把 step 标记为 failed。

## 修复

不恢复同一 Spark provider run，也不对仓库代码做补偿修改。保留现有 tests-only RED 基线，改用 Executor provider 重新派发同一单文件测试校准任务；新 run 仍受相同写入边界和故意 RED 验收约束。

## 验证

确认失败 session token 用量为零且无工具调用，`git status` 与启动前一致，HEAD 仍为 `259171d`。替代 Executor 完成后核对提交只包含 `test/plan-coordinator.test.mjs`，生产 Coordinator 与 `0061d08` 一致，聚焦测试仍精确失败于缺失 `prepareAuthorizedDispatches`。
