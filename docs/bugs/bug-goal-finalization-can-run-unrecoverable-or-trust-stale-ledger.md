# Bug：终审可运行不可恢复 Oracle 或信任过期账本

- **任务**：r11-finalization-bug-contract
- **合同版本**：`dispatch-ir.v1` / `goal-runtime.v1`
- **严重性**：Critical（完成语义、外部副作用与账本一致性）
- **范围**：R11 Obligation Finalization 与可恢复外源 review
- **前置**：R10B suspension closure、pending amendment、task applicability 与 evidence authority 必须已冻结并可审计

## 复现

当前 `scripts/lib/goal-engine/finalization.mjs` 仍是 unsupported stub，尚无成功的终审路径；`final-review.mjs` 只按 `reviewId` 简单覆盖写 JSON。若未来把业务 Oracle/managed validation 直接放进 `goal_finalize`，或在 writer lock 内调用外源 provider，可复现以下失败：

1. finalize 先消费 token/锁住 writer，再启动不可恢复的 Oracle；进程崩溃、网络超时或 provider 永不返回时，意图、资源和锁无法从 durable 状态准确恢复。
2. finalize 读取一次 projection 后进行 review；review 期间 HEAD、事件账本、evidence、资源或 approval 变化，仍以旧 manifest 写入 `completed`，形成“完成但不是当前世界”的陈旧账本。
3. review provider 返回结果后在写 result 与追加 `goal.completed` 之间崩溃，reload 既可能重复调用网络，也可能只看到半条记录。
4. 直接把 `planned.v1` 的最后一个 Task `accept` 改为等待终审，或让 accept-auto 走 runtime 分支，破坏历史完成协议。

## 影响

- 不可证明的业务结果可能被标为完成，污染后续 status、审计和恢复判断。
- 外部网络调用持 writer lock 会放大锁占用、死锁和重复副作用风险；token 可能已消费而本地没有可重放的 intent。
- stale evidence、open Finding、未闭合 suspension 或 resource debt 可能被掩盖，导致旧结果 integrate 或再次 dispatch。
- provider 的 prompt、响应、凭据或错误文本可能泄漏进账本；Critical/Important review 可能错误地完成 Goal。

## 根因合同

### 1. 终审是纯账本操作

`goal_finalize` **只**构造并校验 manifest、Current World Snapshot、资源状态和已存在的 fresh evidence；它不得调用 Oracle、adapter、managed validation，不得启动 Observation，不得重跑业务流程。最后一次业务复验必须先通过普通 Condition action 完成。外源 review 是独立的、可恢复的 provider 调用，且始终在 writer lock **外**。

`planned.v1` 的 `accept-auto` 永不改变：最后一个 Task `accept` 仍按原语义完成，绝不需要 `goal_finalize`。仅 `goal-runtime.v1` 使用 `goal_finalize`；`ready_for_finalization` 是依据当前投影动态派生的状态，禁止新增权威 ready 事件。

### 2. 当前世界和身份必须同一代、同一指针

manifest 必须冻结并互相校验以下身份：

- `goalId`、`executionRevision`、`contractHash`；
- manifest hash、事件 replay/store projection 的 `stateHash`；
- Current World Snapshot 的 `worldHash`，其中包含 repo root、HEAD、branch、tracked/untracked dirty、sequencer、adapter/environment/fixture/resource/active-run 状态；
- `baseHead` 与 review 时的真实 HEAD（要求 HEAD CAS，且 ancestry/dirty/sequencer 均可证明）；
- 真实用户 `approval` 引用（proposal/hash、session、userEntry、单次 capability 消费状态）；
- 外源 `reviewId`、`resultHash`、result severity/status；
- 每个 supporting evidence ID、terminal proof、condition/revision/contract/HEAD/environment 身份及 task settlement hash。

任何 hash、HEAD、approval、reviewId、resultHash、severity 身份不匹配，或 snapshot 不可捕获、资源/active run 身份不明，均 **fail closed**。结果写回必须采用 CAS：`goalId + executionRevision + contractHash + stateHash + worldHash + baseHead + approval identity + reviewId` 全部仍匹配才可追加账本；不匹配只能返回需要重新 status/review，不能完成。

manifest 不是调用者提交的 verdict；Condition verdict、Finding 和 evidence authority 必须来自 Host adapter 已记录的 evidence，finalize 只核验引用与新鲜度。

### 3. R10B 与阻断前置

R10B suspension closure、pending amendment/applicability/evidence authority 是 R11 的硬前置：

- suspension 必须有 durable closure、受影响 run 的 official terminal proof、workspace quarantine/preserve/discard proof 和 resource closure proof；
- 不得有 pending amendment、未消费/已撤销 capability 或待人工决定；
- task applicability 必须在当前 execution revision 显式为 applicable 或 superseded，不能有 applicability debt；
- evidence 必须由 Host authority 记录并绑定当前 contract/revision/HEAD/world/environment，不能接受 caller verdict 或孤立 hash。

以下任一存在，立即 fail closed：任意 suspension、resource debt、finding（open/repairing/reverification 等未解决）、episode（active/blocked/cancel_pending，或 cancelled 且 `resourceDebt`）、active run（executor/observation）、active workspace/process/resource、cleanup debt、pending amendment/decision、未分诊 discovery，或任何无法证明的世界状态。不能以“这次不相关”绕过阻断。

## R11 修复边界（A/B/C/D）

- **R11-A：纯账本与 manifest**：实现 `buildObligationFinalizationManifest` / 校验；只读 replay、projection、evidence、settlement、Current World Snapshot 与 resource inventory。不得运行 Oracle 或外源 review。
- **R11-B：可恢复 review**：intent 先 durable，再在 writer lock 外调用 provider；按 `reviewId` reload/recover，脱敏保存结果，provider 失败只保存稳定错误码。
- **R11-C：CAS 与完成原子性**：review 结果必须与 state/world/HEAD/approval 等身份比较；pass 以 `record + complete` 原子批次追加。Critical/Important 只记录 review 结果并返回 `changes_required`，不得 complete；Minor 为 residual，不阻断（仍需记录）。
- **R11-D：crash/reload 验证**：覆盖所有 durable 边界、双 session/reload、world 变化和 provider 崩溃；验证无重复网络副作用、无 stale completion、无锁内网络调用。R11 不修改旧计划、生产/测试以外的文件；本合同文档之后 R11-A/B 可并行实现。

## 外源 review 崩溃矩阵

| 边界 | durable authority | reload/恢复 | 结果与阻断 |
|---|---|---|---|
| intent-before-call | `reviewId`、manifest/state/world/HEAD、approval identity 已 durable | 同 reviewId 读取 intent；未有 intent 不得调用 provider | 可安全重试同一 intent；不得消费未记录的外部副作用 |
| provider in-flight | intent 存在，provider 可能已在网络中 | inspect/recover；不得持 writer lock；无法判定则保留 intent，等待可恢复处置 | 不得猜 pass，不得重复启动未知调用 |
| result-before-ledger | result 含 `reviewId`、manifest/state/world/HEAD CAS 身份与 `resultHash`/severity | reload 校验 result；若当前身份变化则标 stale，重新 status/review | 结果未能证明时不追加 completed |
| record+complete durable-throw/reload | 单一原子 append batch：`final_review_recorded` + `goal.completed`（仅 pass） | reload 重放得到两者皆有或皆无；若仅有 intent/result，继续 CAS 检查 | Critical/Important 仅 record+`changes_required`；Minor residual；任何 CAS 失败 fail closed |

## 完成谓词与验证

只有当所有 applicable planned/remediation Task 已 accepted 或显式 superseded，所有 required Condition 在当前 Snapshot 有 fresh supporting evidence 且 stability history 完整，无上述任何阻断项，并且 recoverable external review 无 Critical/Important，`goal-runtime.v1` 才可完成。`ready_for_finalization` 必须每次由最新投影与 Snapshot 动态计算。

Crash 验证必须注入并断言：intent durable 后崩溃可 reload；provider in-flight 不持 writer lock；result-before-ledger 崩溃不会完成；record+complete durable throw 后原子恢复；HEAD/world/stateHash 任一变化触发 CAS 失败；provider 凭据/全文不落盘；重复 recovery 幂等。验证只针对 R11 新接口，不回写旧 superseded 计划、不改变 `planned.v1`、不添加 Goal 自举流程。

## 预期修复与非目标

预期修复是最小化地建立上述纯账本、外源 review、CAS 和 crash recovery 合同；不在 finalize 中增加业务执行、不放宽 evidence authority、不把 readiness 变成事件、不引入 auto-continuation，也不改写旧计划或 R10B 候选。