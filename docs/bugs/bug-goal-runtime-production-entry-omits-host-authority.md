# Bug：production 入口遗漏 Host authority

## 状态

R10B production runtimeHost 发布阻断（`dispatch-ir.v1`）。本文档对应
`r10b-production-runtime-host-red`：先冻结 RED 合同，再由后续实现提交
GREEN；本变更不修改 production。

## 现状与影响

`pi/extensions/goal-engine.ts` 的 enabled 路径只执行
`createGoalEngineExtension(pi)`。真实 Pi 运行时没有把 Host-owned 的
world、root broker、workspace、resource 和 Observation authority 接到
Goal Engine。因此 init、calibration、suspend、amendment 在真实 Pi 中
可能在缺少 Host 的情况下继续，既不能可靠观察事实，也不能安全停止或
收束资源。

威胁模型包括：tool caller 伪造 workspace/process/artifact proof；把
caller 提供的 text/path 当作 artifact；把 unknown process 当作 owned
process 并 kill；workspace integrate 被误当成 resource closure；以及
身份漂移、重复 lease 冲突和 root broker 不可用时静默降级。任何未知、
unsafe 或 ownership 无法证明的状态都必须 fail closed；unknown process
绝不 kill，也不能制造伪 terminal/proof。

## 根因

入口没有构造 production runtimeHost，也没有以
`createGoalEngineExtension(pi, { runtimeHost })` 传递 Host capability。
当前 extension ABI 因而只拿到 Pi，而不是由 Host 派生的 authority。Host
必须拥有 registries/adapterRegistry、canonical world capture、artifact
引用、managed workspace/validation 生命周期、root-broker stop 和
quarantine 结果；Projection、Git/process proof、nonce 等内部事实不可
开放给 tool caller。

## RED / GREEN 边界

本次只增加中文 bug 合同和 tests-only RED：

* `createGoalEngineEntry` disabled 时不得 load 或构造 Host；enabled 时必须
  先用默认真实 factory 构造 production runtimeHost，再传入 extension；
  factory 失败必须 fail closed，不回退到 `null`。可注入 factory 仅用于
  测试。
* 预期模块 `createProductionGoalRuntimeHost(pi, options?)` 的 capability
  必须精确覆盖 Host-owned registries、`captureCurrentWorld`、
  `artifactRefForRun`、managed prepare/start/recover/inspect/release、
  `stopOwnedRun`、`quarantineWorkspace`、`quarantineResource` 和
  `stopManagedValidation`，且不暴露 caller authority。
* `captureCurrentWorld` 每次按传入 canonical cwd 读取 adapter/environment/
  fixture/resource/run inventory，不缓存；unsafe/unknown 返回 fail-closed。
* `stopOwnedRun` 只能委托
  `stopRootBrokerGoalOwnedRun(pi, { runId, asyncDir, sessionId })`；broker
  unavailable 或 unknown 保持 unknown，不 kill、不伪造 proof。
* workspace quarantine 必须按 Goal-owned lease identity 加载并 typed
  preserve，校验 taskId/attempt/lease/path/head/revision/contract/session；
  返回 `{ taskId, attempt, proofHash, state: "quarantined", disposition:
  "preserved" }`。proofHash 由 Host 派生，身份漂移和重复冲突 fail closed，
  相同 preserved 结果重试幂等。
* resource quarantine 必须返回精确
  `{ ownerId, proofHash, state: "quarantined", debt: true }`，由 managed/
  registry authority 派生；workspace integrate 不是 closure。
* `stopManagedValidation` 只接受 exact owned process identity。unknown
  process 绝不 kill，返回 attention/unknown；只有可证明 terminal/quarantine
  才返回 terminal/resource hashes。
* Observation 复用现有 managed-validation/observation runner production
  facade；`artifactRefForRun` 只读 Host-owned content-addressed 引用，拒绝
  caller text、path traversal 和伪成功。

GREEN 的边界是后续 production 实现满足这些行为并使 RED 全部通过；不得
通过启动真实外部进程来满足 canary。entry-level canary 必须证明默认
factory 非 null、steer hook 能抵达注入的 official stop facade，并在无
Host 时不得静默继续。

## 修复验收

运行新 runtime-host integration test，应明确因 entry/options/module 缺失
而 RED；既有 settings gate 应保持 GREEN（disabled 不 load、不构造 Host，
settings malformed/false 仍 fail closed）。完成后执行 node check、diff
check，并以中文 conventional commit 提交 bug+tests-only；workspace 必须
clean。禁止 Goal Engine 自举、raw worktree mutation、unknown kill、fake
proof、caller authority 和新增 tool ABI。
