# Bug：Plan Runner 使用错误字段读取 Supervisor 请求身份

## 1. 现象

真实 Plan Runner 运行`15ecd68a-f79c-419c-bf6c-6fb8dfa3e679`已完成 v3 Host 启动、RPC 绑定和 Executor 派发。Executor 因 iOS 物料不可用调用`contact_supervisor`后，Host 收到`subagent_supervisor_request`，但`recordSupervisorRequest()`抛出`Invalid native Supervisor request identity`。Plan 未生成 durable Attention，reply 也因不存在 waiting Attention 而被拒绝。

## 2. 影响范围

影响`pi-subagents@0.37.0`原生 Supervisor channel 进入 Plan Capsule 的全部请求，包括`need_decision`、`interview_request`和`progress_update`。阻塞请求会停留在原生临时channel中，Plan projection仍显示Attempt为`active`，无法形成权威的`waiting-attention`或结构化`blocked`状态。

## 3. 复现条件

1. Standalone Plan Runner通过`pi-subagents@0.37.0`派发Executor。
2. Executor调用`contact_supervisor`产生原生请求。
3. 原生channel向父Session发送`customType=subagent_supervisor_request`消息。
4. 消息`details`包含`id`、`runId`、`agent`和`childIndex`。
5. Plan依赖校验不存在的`details.requestId`，稳定抛出身份错误。

## 4. 根因

`pi-subagents`的`SupervisorRequest`在文件与父Session消息中都使用`id`保存请求身份；其`requestVisibleText()`也把该值作为reply target。Plan依赖却自定义为`details.requestId`。现有单元测试手写了错误的`requestId`fixture，没有使用上游真实消息结构，因此测试通过但未覆盖生产契约。

## 5. 修复策略

以锁定版本的原生消息结构为边界：`recordSupervisorRequest()`从`details.id`读取并归一化本地`requestId`，后续Attention文件名、事件和返回值继续使用Plan领域名`requestId`。同步把Capsule和依赖测试fixture改为真实`details.id`结构；不放宽runId、agent、childIndex、active Attempt或消息大小校验。

## 6. 回归与预防

- RED：使用真实`details.id`调用`recordSupervisorRequest()`时，旧实现必须因身份校验失败。
- GREEN：同一消息生成`0600` Attention正文及`attempt.attention-requested`、`attempt.attention-escalated`事件。
- 契约：测试fixture必须逐字段匹配`pi-subagents@0.37.0`父Session消息，禁止重新引入`details.requestId`。
- 完整回归：运行定向Plan依赖/Capsule测试、完整`npm test`和真实`plan_run`，确认请求进入durable Attention并形成预期structured blocked。

## 7. 验证证据

- RED：Plan依赖/Capsule定向测试`34/35`，唯一失败为`Invalid native Supervisor request identity`。
- GREEN：定向测试`35/35`，完整单测`432/432`；Subagents`3/3`、Plan Capsule`2/2`、真实Harness`1/1`、Pi runtime`1/1`。
- 独立只读review结论为`ACCEPT`，未发现Critical或Important问题；fixture已补齐`display`和`expectsReply`以匹配真实消息。
- 真实运行`e9614c79-29a9-41b0-8008-259c853f32cb`生成请求`feaa8cb0-1ceb-4a82-a9b2-4af8b737b1d2`；Attention正文权限为`0600`，SHA-256为`914bc248824a2f62dbcc1399925aaab585823f1ecef951e53cf83ba14bc6c9b8`。
- Plan终态为`blocked`、projection version `9`、`validatedHead=null`；结构化结果明确缺少`readiness.json`和`main-plan-input.json`，未创建commit或实现变更。Host exit code为`0`，无残留Host/Executor进程，也未再出现身份校验错误。
