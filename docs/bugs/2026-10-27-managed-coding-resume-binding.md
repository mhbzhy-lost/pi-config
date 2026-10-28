# Managed coding child resume 缺少新进程授权与 workspace 绑定

日期：2026-10-27。状态：已确认生产缺陷，尚未修复；原 footer 补丁已独立保存，未重新运行失败请求。

**归类：合法 public/typed 入口触发的 production bug，归属 enhanced 层的 resume 生命周期接线。** completed child 的 resume 被公开合同明确支持；本次参数没有调用错误。新 run 保留了 locator、required extensions 和原持久会话，但没有经过首次 coding start 的新进程授权注册路径，随后在 required extension factory 阶段等待身份超时。不能按 provider 暂时故障自动重试。

本轮只读，未修改文件、运行测试、启动 Host/provider、重放请求，未控制任何 run/workspace；未读取私有 authority/grant/token、auth/models、证书或整份环境。原 workspace 未访问或处置。

**现场证据与身份**

以下原始文件均位于 `/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/pi-subagents-uid-501/async-subagent-runs/` 下两个指定 run 目录，仅提取公开状态、恢复描述中的身份/扩展字段及必要事件。

| 事实 | 原 run `09ef9c1b…` | revived run `c0e9fdb8…` |
|---|---|---|
| runner PID | 19105 | 24274 |
| started | 07:08:04.734Z | 08:11:40.552Z |
| 结束事件 | 08:07:14.694Z，complete | 08:11:46.541Z，failed |
| required extensions | root-session-owner、integration-queue、agents-shared | 同三项，omitted.required=0 |
| runtime ACK | 三项全部 ACK | 无 |
| 模型/工具执行 | 已进入执行 | `agent_start=0`、`tool_execution_start=0` |
| acceptance | checked | rejected，未生成 report |
| process terminal | observed | observed，08:11:46.553Z；runner exit 0、signal null |

新 run 的 `revivedFrom` 精确指向原 run。两者的权威身份关系如下：

- root locator 都是 `01a17bf3-ba5a-71a2-bcb9-d3ee233671d7`。
- lifecycle `sessionId` 都是父会话文件 `var/sessions/2026-10-27T06-02-12-954Z_01a17bf3-ba5a-71a2-bcb9-d3ee233671d7.jsonl`。
- child `sessionFile` 都指向原 run 的 `…/09ef9c1b-4e39-4d24-98dc-a6a21b8a16d1/run-0/session.jsonl`。
- cwd 都是 workspace `183f86ee-d4b9-482d-a5fc-1038e42d9623`，没有分配第二个工作目录。

因此，新 run 复用了原持久对话文件，同时产生新 runner 进程；“新 run（新子会话）”的工具文案不能理解为必定新建 session 文件。

直接现场引用：原 run `status.json:1052` 记录三项 ACK；原 `runner.stderr.log:1` 记录 `integration-gate-passed`。新 run `status.json:57` 记录来源，`:323` 记录复用 session，`:324` 记录完整加载错误；新 `events.jsonl:1`、`:2`、`:3`、`:4`、`:5` 依次是 run started、step started、step failed、run completed、process terminal。新 stderr 为 0 字节，错误由 status 保留。

**调用与启动链**

1. 公开入口合法。[operation-tools.ts](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/operation-tools.ts:275) 明确允许 paused/completed/failed resume，并将固定 action 委托同一 typed control 闭包。用户提供的完整 runId、`index:0`、非空 message 满足合同；未传 dir 不构成问题。

2. **首个偏离点在 enhanced control 分支。** [extension.ts](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1541) 的 resume 直接执行 `rpc[action](params)`；成功后只处理 title 映射，没有新 run 的授权登记或 workspace 绑定步骤。对照首次 coding start，同文件 `:1151` 的 onBinding 获取真实 runId/asyncDir/sessionId/PID，`:1181` 调用 `registerAuthorizedRun(codingRunAuthorization(...))`，`:1205` 等待注册，`:1218` 才绑定 workspace。resume 没有经过这条链。

3. typed RPC 仍走合法上游入口。[rpc-client.ts:299](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/rpc-client.ts:299) 发出 resume；上游 [rpc.js:640](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/rpc.js:640) 校验后交给原执行器。当前安装 manifest 实测为 Pi **1.4.0**、pi-subagents **0.80.0**；package AGENTS 中的 0.79.2 表述已过时，不作为运行版本证据。

4. 上游正确恢复了启动材料。[async-resume.js:588](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-resume.js:588) 验证目标 child、持久 session 与 cwd，返回 `kind:"revive"`；[subagent-executor.js:1871](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/foreground/subagent-executor.js:1871) 产生新 runId，`:1950` 传入原 sessionFile/revivalLease，`:1965`、`:1966` 恢复 extensionBindings/requiredExtensions。现场两份恢复描述和新 status 与此一致，排除了本次 required 扩展或 root locator 传播丢失。

5. revived runner 先取得原 session 的写入 lease，再完成 ready→ack→acknowledged→confirm→confirmed→proceed 握手，然后加载 execution，见 [subagent-runner-bootstrap.js:135](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner-bootstrap.js:135)。上游随后发布 async-started，见 [async-execution.js:2091](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-execution.js:2091)。这套 **session 写入 lease** 与 Root Broker 的 **execution lease** 是不同资源；前者成功不代表后者存在。

6. broker 收到未授权新 run 的 started 时，只登记 facade。[root-broker-server.ts](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:675) 的 `observeStarted()` 在 `ownedRuns` 查不到时，于 `:681` 调用 `registerFacadeRun()` 后返回。facade 不生成 broker principal。真正的 `registerAuthorizedRun()` 在 `:440` 捕获新 PID 的 processBirth，`:460` 持久化 receipt/execution lease，`:463` 创建 principal，`:986` 写 grant。Host 接线仅由 [subagent-runtime.ts:463](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:463) 的授权回调调用该注册入口；普通 resume 没有调用它。

7. child 的失败发生在 `session_start` 之前。[integration-queue.ts:181](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/child-extensions/integration-queue.ts:181) 在 factory 阶段发现 child locator 存在、runId 尚未解析，立即 await `resolveChildBrokerIdentity()`。[child-broker-binding.ts:7](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/child-broker-binding.ts:7) 根据**当前 PID 的 processBirth**查询当前 receipt，再验证 execution lease 和含 `root.subscribe` 的 grant；5 秒内不就绪则在 `:31` 抛出现场同文错误。

8. 上游 [child-session.js:443](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/shared/child-session.js:443) 先执行 `loader.reload()`，紧接着拒绝 required load error；之后才有 `SessionManager.open()` 和 `session.bindExtensions()`（`:496`）。root-session-owner 的身份解析注册在其 `session_start` handler 中，见 [root-session-owner.ts:26](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts:26)，此次尚未到达，无法替前面的 factory 补齐身份。Pi 1.4 文档与 loader 实现也明确 async factory 会被等待。

**结论的精确边界**

这不是旧的 required-child 注册键错误：新 run 的三项 required 已完整注入；也没有证据支持 provider 故障。约 6 秒的启动失败与 5 秒身份 gate 加加载开销一致，零 agent/tool 事件证明新修正尚未执行。acceptance rejected 是启动失败后缺少 report 的结果；runner exit 0 只说明 runner 进程正常收尾，不能证明任务成功。

我未读取私有 authority/grant 来逐项确认当时磁盘状态。单看该超时文本，只能直接证明“未找到可返回的当前 receipt/grant 组合”；**缺少新 run 注册路径**的归因来自完整生产调用链与现场新 PID、保留 locator、无 ACK 的一致证据，不把私有记录缺失冒充实测。没有需要重放失败请求才能成立的环节。

**最小修复归属与恢复条件**

修复应由 **enhanced 的 typed resume/Host 生命周期**拥有，重点是 control 闭包与新 run 绑定回调，复用现有 broker authority 和统一 workspace service。需要让受支持的 managed coding resume 为真实新进程建立授权，并在 child 使用 coordinator 前完成合法 workspace/queue 绑定；不能凭 `revivedFrom` 或 started 事件直接授予能力。

只延长 timeout、把 factory 等待搬到 `session_start`、复用旧 runId/grant，或将加载错误静默降级，都不能补上缺失的 Host 授权。workspace 重绑还有独立门禁：[service.ts:250](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/service.ts:250) 要求授权 resume intent；[coordinator-server.ts:458](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:458) 的 activation 明确按 intent→workspace→queue 顺序执行。不能仅补 grant 就宣称恢复链完成。若某类 retained workspace 设计上不允许普通 resume，应在 spawn 前明确拒绝；当前公开合同与实现没有给本次调用这样的拒绝。

安全恢复前提是：确认旧、新 run 的 terminal proof 与 canonical session 无活跃 writer；从公开权威接口核对 workspace/queue 当前 owner、绑定和允许动作；恢复入口能够为新进程完成授权与合法绑定，或明确返回 blocked。现场新 terminal 记录了 canonical session lease 已 released、freeAtObservation=true，但这是结束时事实，不代替未来恢复前的实时核验。当前继续保留原 workspace 与两个 run 现场，不自动 fresh 重派。

**会影响 Goal 计划 T3 的 typed resume 假设。** [计划 §4.2/T3](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:303) 假定复用当前 typed control 后，可在授权与 workspace 绑定完成后返回新 PlanRunRef；本次证明当前普通 resume 不提供这组保证。T3 不能仅依据 upstream `resumeDisposition:"resumable"` 投影 `recovery:"typed-resume"`，更不能把 RPC 启动成功视为绑定完成。应将这类身份/绑定未闭合的恢复判为 unknown/blocked，并把通用 runtime 恢复合同闭合作为相关能力验收的前提；本轮未修改计划。

## 补记（2026-10-27 晚，T3 交付时修复）

Goal T3 交付时定位并修复了本缺陷家族的首派侧缺口：合法首次 coding 派发的 `bindRun` 仅记录 `{runId,asyncDir}`（`spawnWorkflowLeaf` 返回形状），而本报告修复后的 `managedCodingResume.prepare` 要求 `record.run.agentProfile` 非空，导致所有首派 run 的 typed-resume 永久 RESUME_BINDING_BLOCKED。修复未改 workspace schema（`service.ts` 的 `exactKeys(run,["runId","asyncDir"])` 硬门禁保持）：`extensions/subagent-runtime.ts` 的 prepare 改从官方 `broker.inspectExecutionProof(sourceRunId).binding.agentProfile` 取首派 profile，并在取用前交叉核对 snapshot.binding 的 root/run/asyncDir/sessionId 与 record.run/owner/current broker 全部对应；`record.run.agentProfile` 已存在时要求一致，任一不匹配或 proof 缺字段保持 fail-closed。adapter inspect 与 prepare 使用同一 canonical 来源。验证：typecheck、package 元数据、派发/证明回归 101 项、恢复重绑 9 项、Broker 通知 42 项全部通过；未新增测试。
