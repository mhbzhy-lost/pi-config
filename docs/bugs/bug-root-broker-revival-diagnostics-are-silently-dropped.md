# Bug: Root Broker revival 诊断被静默丢失

## 现象

在 `4722b37` 后的真实 Harness 中，首代 Plan Runner 已产生官方 terminal proof：`process-terminal.json` 记录其为 `observed`，并且 `resumeDisposition: "resumable"`；但始终没有第二代 runner。诊断报告 `.pi-subagents/artifacts/diagnostics/task63h-post-wake-flat-revival-diagnosis.md` 只能确认首代 proof 已在 async-runtime 工件边界观察到，无法确认 Broker 内部的 `caller.followup` ACK、proof acceptance、resume 调用及其结果。这四个节点均为 **unknown**，不能由根 session 的静默推断为成功、拒绝或提前关闭。

## 影响

真实 Harness 在等待后续 generation 时超时，根 session 没有足以定位 wake、proof 或 resume 阶段的持久化证据。维护者无法区分 followup 未被 Broker 接收、proof 未被接受、revival gate 阻断、上游 resume 未调用、调用失败，或已恢复但 grant 未发放等路径；因此当前 revival 业务根因仍是未知，不能据此直接修改授权、single-flight、wake debt 或 cleanup 逻辑。

## 复现

以 `4722b37` 运行真实 server Harness：首代 runner 执行一次 `plan_open` 并正常结束；官方 terminal artifact 记录 `state: "observed"` 和 `resumeDisposition: "resumable"`，随后 Harness 等待约 32 秒仍未出现第二代。根 session 中没有 `caller.followup` wire ACK、Broker proof acceptance、resume 调用/结果、revived grant 或 Broker marker/ledger；标准输出和错误输出也为空。该结果只能复现诊断缺口，不能证明任何一个私有 Broker 节点的实际业务结论。

## 根因

`acceptTerminalProof` 与 `registerCallerFollowUp` 都以 `reviveCallerAfterProof(...).catch(() => undefined)` 吞掉异步 revival 错误；同时 `reviveCallerAfterProof` 在前置条件不满足时直接 resolved no-op。Root session 没有结构化的 revival 诊断，因而调用失败和 gate no-op 都不会留下可审计记录。现有证据不足以判定哪项前置条件或哪次业务调用导致本次真实 Harness 没有第二代。

## 修复

为 `RootBroker` 注入窄的、仅用于观测的 diagnostic sink，由 Root extension 将记录持久化为 `pi-root-broker-revival-v1` custom entries。每条记录仅包含可审计的逻辑 caller/run/generation/wake 标识、受限 reason、时间及必要状态；不得写入 token 或 raw params，错误仅保存截断后的 message。

至少覆盖 `caller.followup` accepted、proof accepted/rejected、revival gate blocked（reason 必须来自有限集合）、resume invoked/succeeded/failed、revived grant issued、close begin/end。sink 自身的异常必须隔离和吞没，且不得改变授权判断、single-flight、wake debt 或 cleanup 的时序和结果。

## 验证

先增加独立 RED，覆盖真实 server 路径的事件顺序和字段约束、diagnostic sink failure isolation，以及 Root extension 对 `pi-root-broker-revival-v1` 的持久化。GREEN 后以真实 Harness 验证：从 Root session 的 custom entries 能确定失败发生在 followup、proof、gate、resume、grant 或 close 的哪一节点；记录中不含 token/raw params，错误 message 已截断。业务修复必须在这些持久化节点确立后另行判断，不能将本缺陷文档视为当前 revival 业务根因已知的证明。
