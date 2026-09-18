# Worktree 首段与多 Root 生命周期缺陷

## 入口与复现

合法入口是 public `subagent` typed dispatch，提交 `dispatch-ir.v1` 且 `execution.worktree: true`；该入口由
`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` 调用 `standaloneWorkspaceRequest`，再通过
workspace service 执行 allocate、run bind，完成真实 child worktree 的写入和 commit 后由 coordinator 观察生命周期。

本记录的精确 RED 由 `test/managed-workspace-multi-root-session.integration.mjs` 观察：同一 daemon/repository state root
下分别代表 Root A 与 Root B 创建 service，期望得到同一 repository-scoped service；当前两次 factory 调用返回不同对象，测试失败。

## 权威身份与顺序

权威 repository 身份是现有 durable state root 对应的 repository ledger；owner 身份是 Root Broker registration 注入的
`{ kind: "standalone-subagent", rootSessionId }`。生命周期顺序为 reserve -> allocate Git worktree -> active -> bind authoritative
run (`runId`/`asyncDir`) -> child 写入并 commit -> terminal proof/status -> committed/run-bound 观察。

## 首个偏离点

单 root 的 Git 创建、工作区 clean/commit 检查和 terminal proof 流程可以通过现有 public lifecycle 测试；首个偏离点是
root-local registry/factory 仍为每个 Root 创建独立 `ManagedWorkspaceService`，没有 repository-scoped singleton。该偏离发生在
registry/service 注入边界，早于 queue、rebase、publish，因此 T4 只修复这一首段，不扩展 queue 行为。

## Production 可达分类

这是 production 可达的高风险一致性缺陷：多个 Root session 通过同一 daemon 操作同一 repository 时可能获得不同 service
实例，导致 inventory 聚合和 owner-scoped lifecycle 的 service identity 不稳定。不得通过手工 append ledger/event 或 projection
证明缺陷；以上 RED 仅由合法 public lifecycle contract 和真实 service factory 观察。

## 第五次 probe（allocation 后 RPC 失败）

第五次 probe 观察到 `parse`、`validate`、`transform` 的 allocation 已进入 `active`，但 authoritative `run` 仍为 `null`；对应 Root subagent errors 仅有 `detailsCode: SUBAGENT_RPC_FAILED`。`serialize`/`audit` 没有 workspace receipt。公开错误没有保留底层 RPC operation 或 cause，因此无法区分 `rpc ping`、workflow spawn、child start 与 `bindRun` 失败。

## 单 Child 现场补录：授权、工具与 fixture

后续单 Child 已成功 allocation、workflow spawn、authoritative child binding 和 commit，但 Root Broker grant 文件从未创建。根因是
`extension.ts` 只在 Goal ticket 存在时调用 `registerAuthorizedRun`；合法 standalone managed coding 的 ticket 必须为 `false`，不能伪造
Goal ticket。修复后的 Host authorization 在 child binding 的 run/session/pid/profile 与 workspace owner/root 匹配后注册，standalone grant
仅含 `root.subscribe`，不得含 `acceptance.submit` 或任何 Goal authority。grant 写失败必须终止 dispatch/bind，workspace 保持 active、run=null；
`grant-created`/`grant-failed` 诊断只记录 stage 和 timestamp，不记录 caller token。

同一现场的 workflow leaf 已加载 `child-extensions/integration-queue.ts`，但 executor 的严格 `tools` allowlist 没有
`subagent_integration`。pi-subagents 的合同要求 extension path 与 tool name 同时生效；受信任 managed-child extension 因此在
`session_start` 后只把自身已注册的工具名加入 active tools，并保持去重。`execution.worktree:false` coding 与 generic leaf 不注入该
extension，不能获得无 workspace 的 integration tool。

acceptance fixture 的 `.pi/agents/executor.md` 同时缺少 `name`/`description`，且从 agent 文件目录解析的 barrier 相对路径应为
`../../acceptance-barrier.mjs`，不是 `../acceptance-barrier.mjs`。真实 `discoverAgents(fixture, "project")` 必须解析出 executor，且
effective `subagentOnlyExtensions` 的绝对路径实际存在；async barrier factory 仍在模型启动前等待 release。

## 第六/七次现场根因一：stateRoot 没有唯一 canonical 值

`normalizedStateRoot`（ledger）用 `realpathSync` 逐级上溯到存在的祖先后拼接缺失段，因此 workspace service/ledger 分区总是
`/private/var/...`。而 `createCoordinatorRegistry` 只用 `path.resolve(stateRoot)` 计算 `canonicalStateRoot`，macOS 上保留
`/var/...` 别名。同一 `PI_CODING_WORKSPACE_DIR` 因此产生两个字符串：coordinator metadata 记 `/var/...`，inventory/ledger 记
`/private/var/...`。

后果链：

1. `auditManagedWorkspaces` 用 `path.resolve` 比较两个值，`state-root-split-brain` 债务由合法 symlink 路径产生，doctor 报错。
2. `createCoordinatorServer` 把未 canonical 的 stateRoot 直接拼进 `repositories/<repositoryId>/terminal-proof-outbox`，outbox 与
   ledger 分区可以落在不同真实目录。
3. 同一条 `state-root` migration debt 把 `originRoot`（repository 根）与 `inventory.stateRoot`（workspace 状态根）相比较，这是两个
   无关概念，合法现场必然不相等，因此债务恒定产生、`isAcceptanceAuditSettled` 永远不成立。

修复方向：canonical stateRoot 是 production identity 事实，由 `canonicalWorkspaceStateRoot`（realpath 上溯，与 ledger 同算法）
唯一确定；coordinator registry metadata、coordinator server 的 service/queue/outbox 路径、audit 比较全部使用该值；
`state-root` 债务改为比较“声明的 state root”与 ledger canonical 分区，不再比较 repository 根。不改 T9 probe 逻辑绕过。

RED：`test/managed-workspace-coordinator.integration.mjs` 的 symlink 用例与
`test/subagent-worktree-lifecycle.integration.mjs` 的 canonical lifecycle 用例（`/var` 别名 vs `/private/var` 目标，audit debts 必须为空）。

## 第六/七次现场根因二：authoritative terminal proof 未可靠送达 coordinator

`RootBrokerServer.acceptTerminalProof` 接受官方 terminal 后以 `void Promise.resolve(...).catch(() => undefined)` 调用
`recordTerminalProof`，失败被静默吞掉；`subagent-runtime.ts` 的 sink 只在 `listOwned({ runId })` 恰好返回一条时才转发，其余情况直接
抛错并丢失。coordinator 侧 `deliverTerminalProof` 把 Root Broker 的原始 proof（`{runId, version, runnerProcessInstanceId, state,
observedAt, instances}`）直接交给 `workspaceService.recordTerminalProof`，而 v2 ledger 要求恰好
`{state, conflict, runId, rootSessionId, asyncDir, processInstance, proofId}` 七个键，因此正常路径也必然失败。

后果链：

1. 合法 child 完成 commit、queue item `completed`、candidateHead 与 integrationIntent/receipt 一致，但 outbox 从未收到 proof，
   `terminal-proofs.json` 为空，workspace 长期 `active`，audit 记 `proof unresolved`。
2. `deliverTerminalProof` 不幂等：一旦 workspace 已 `released`，重放会在 `statusOwned` 抛 `MANAGED_WORKSPACE_STATE`，receipt 永远
   无法持久化。
3. coordinator 暂不可用或 run binding 无法解析时没有任何 durable 记录，proof 静默消失，违反 fail-closed。

修复方向：sink 先把 proof 整形为 v2 ledger proof（`proofId` 复用 Root Broker 的 canonical proof hash），先写 durable outbox
`pending`，再调用 coordinator；binding 无法解析写 durable `proof debt`；coordinator `deliverTerminalProof` 对已 released workspace
幂等返回既有 receipt；Root Broker 记录可观察的 delivery 状态（`inspectTerminalProofDelivery`），不再吞错、不推断 terminal。
只有 receipt 持久化后才允许 release。

RED：`test/managed-workspace-terminal-proof-handoff.integration.mjs` 的正常送达、coordinator 不可用重放、run binding 缺失三个用例，
以及 `test/root-subagent-broker.test.mjs` 的 proof sink 契约用例。

## 收尾阶段发现的第三个根因：stale coordinator metadata 不可回收

canonical stateRoot 修复后，`claim()` 仍把“stateRoot 比较”放在“owner 存活判断”之前，因此
`.git/.pi-coordinator/coordinator.json` 记录的任何不同 state root（即使 owner 已死亡）都会让后续
Host 的 `session_start` 永久 fail-closed。既有测试 `test/pi-subagents-compat.test.mjs` 与
`test/pi-runtime.integration.mjs` 用隔离临时 `PI_CODING_WORKSPACE_DIR` 在同一 repository 启动 Host，
因此稳定暴露该偏离点（`coordinator-registry.ts` `claim()`）。

修复收紧为：只有记录的 owner 已确认死亡（`captureProcessBirthIdentity` 抛错或 birth identity 不匹配）
才允许接管；存活 owner 仍严格拒绝不同 canonical state root；不使用 TTL，也不以 socket 缺失为依据。
接管通过既有 `temp + rename` 原子写入复用同一 repository endpoint，并把被放弃的 canonical state root
记入 `supersededStateRoots`，由 `auditManagedWorkspaces` 继续产出 `state-root-split-brain` /
`migration-debt`，不静默抹除历史。

RED/GREEN 与精确复现见 `docs/bugs/bug-coordinator-stale-state-root-bricks-repository.md`；新增回归用例
为 `test/managed-workspace-coordinator.integration.mjs` 的 dead-owner takeover 用例。
存活 Host 持有本 repository coordinator 时，上述两个旧测试仍按契约 fail-closed，属旧 fixture 范围阻断，
不在本任务写入范围内。

## 单 Child 验收现场：Root Broker 在 child integration 未结算时提前断开

### 合法入口与权威身份

合法入口仍是 public `subagent` typed dispatch（`dispatch-ir.v1`、`execution.worktree: true`）。真实单 child 验收链路为：
Root session 启动 `RootBrokerServer` 并经 `connectRuntimeCoordinator` 注入 `coordinatorRequest`/`recordTerminalProof` 代理；
child worktree 由 workspace service `ensureAllocated`/`bindRun` 绑定权威 `runId`/`asyncDir`；child leaf 加载
`child-extensions/integration-queue.ts`，其 `subagent_integration` 工具在 broker-backed 模式下经
`createRootBrokerClient(...).coordinatorRequest(operation, input)` 把 enqueue/await_admission/report_conflict/publish/fail
代理到 Root Broker，再由 broker 的 `coordinatorRequest` 闭包转发到 repository coordinator。

权威身份：workspace owner scope 为 `{ kind: "standalone-subagent", rootSessionId }`；broker 身份为 `rootSessionId` 派生的
UNIX socket 与 grant；child 身份为授权 `runId`（kind `coding`、goal `null` → capability 仅 `root.subscribe`）。queue item 以
`childRunId`/`ownerScope` 与 workspace lease 绑定。

### 事件顺序（按 provenance 分类）

1. child 真实模型 `codex-pool/gpt-5.6-sol` 完成代码并 commit，candidate commit 存在，workspace `active`，barrier 成功。
   —— 这是合法 production 顺序，无缺陷。
2. **外部因素（provider）**：随后 provider 返回 `server overloaded`，模型以 `stopReason=error` 停止。这是 provider 容量问题，
   属外部失败，**不得**被 broker 当作可重试错误，也不得据此推断 child integration 已结算。
3. child 在模型停止后仍尝试 `subagent_integration` enqueue 两次；两次都返回 `BROKER_DISCONNECTED`。Root records 显示
   subagent tool 已 end，但 child 仍在调用 integration。
4. **production 缺陷（broker 生命周期）**：Root 最终 `Root broker executor drain failed` 并 SIGTERM，settlement timeout。

### 首个偏离点

首个偏离点在 `RootBrokerServer.closeRootSession` 的 drain 条件。当前实现只依据
`forcePendingRuns`/`terminalProofs`（child 进程官方 terminal）决定 drain，并在 startup barrier 后立即拆除 transport
（`socket.end()`/`socket.destroy()`、`server.close()`）。它**不**等待 owned child 仍在飞行中的 `coordinator.request`
（child integration lease 推进）。因此当 Root session 结束触发 close 时：

- 若 child 的 integration request 已越过 `dispatch` 的 `if (this.closed)` 检查、正 `await this.coordinatorRequest(...)`，
  transport 拆除会在其响应写回前销毁 socket，child 观察到 `BROKER_DISCONNECTED`（即现场两次 enqueue 的由来）。
- drain 以 subagent tool end / child 进程 terminal / 模型 stop 为依据提前关闭，违反“integration 未结算不得关闭 broker”。

该偏离发生在 broker close/drain 边界，早于 coordinator queue 算法，因此本任务只修复 broker 生命周期，不改 queue/Git core。

精确 RED 由 `test/root-subagent-broker.test.mjs` 的
“Root broker keeps an owned child integration request alive across Root session close” 观察：真实 broker + 真实 client +
受控 `coordinatorRequest` gate，request 在飞行中时触发 `closeRootSession`；修复前 `await inflight` 以
`code: BROKER_DISCONNECTED`（“Root broker disconnected before response”）拒绝。

### Provenance 分类结论

- **外部 provider 失败**：`server overloaded` / `stopReason=error` 是 provider 容量与模型停止事实，不是 broker 可重试错误，
  不得泛化为 broker retry，也不得据此提前结算 integration。
- **production broker 生命周期缺陷**：Root Broker drain 条件缺少“owned child 飞行中 integration request”这一门，导致
  transport 在 integration 未结算时被拆除；这是本任务修复对象。

### 修复方向

1. `RootBrokerServer` 跟踪每个 owned child 飞行中的 `coordinator.request`（从 `respond` 收到请求到响应写回 socket 为止），
   `closeRootSession` 在 startup barrier 之后、drain 之前以有界 deadline（`integrationTimeoutMs`）等待这些请求结算；
   超时则记为可观察 `integrationDebt`（preserved/debt），不再无界等待，也不静默拆除 transport。
2. 保持 root session 主动 dispose 语义：drain 仍由 `closeRootSession` 驱动，terminal proof/proof-outbox 送达仍在 transport
   拆除前 await（既有 `awaitTerminalProofDeliveries`）。
3. broker-backed `subagent_integration` 的 coordinator 失败必须 `isError:true`，`details` 含安全 `code`/`stage`/`operation`，
   不得只在 text 正文返回错误；`BROKER_DISCONNECTED`/`root_closing` 是独立有界失败路径，provider overload 不并入 broker retry。

GREEN 后 Root 保持到 integration request 结算（request 成功）或明确 preserved/debt；回归覆盖 broker 关闭竞态、
coordinator unavailable、duplicate close、pending request drain 与无残留 socket/handle。

### 三条独立有界失败路径（互不误判）

1. **broker disconnect（`BROKER_DISCONNECTED` / `root_closing`）**：broker-backed `subagent_integration` 经
   `createRootBrokerClient` 代理；transport 断开或 Root 已关闭时 client 以安全 code 拒绝，工具返回
   `isError:true`、`details={code, stage:"coordinator", operation}`。这是独立有界结果，child 据此记 fail/preserved，
   不重试、不无限等待；Root close 侧若 request 未能结算则记 `integrationDebt`（可观察 preserved/debt）。
2. **provider `stopReason=error`（server overloaded）**：这是 provider 容量/模型停止事实，发生在模型层而非 integration 工具或
   broker。它是外部失败，**不得**被泛化为 broker 可重试错误，也不得据此推断 child integration 已结算；本修复未引入任何
   broker retry 逻辑，因此 provider overload 与 broker disconnect 保持独立 code 路径。
3. **`contact_supervisor` 无回复**：supervisor 请求有自身的有界结果（无回复即超时/失败返回），与 broker transport 和 provider
   stopReason 互不混淆；它不由 integration 工具或 Root Broker drain 处理，因此不会被误判为 broker disconnect 或 provider 错误。

三条路径各自产生独立、可观察的有界结果（tool error code / 模型 stopReason / supervisor 超时），任一都不会被当作另一类重试。

## 第十/十一次真实现场：Child 未完成 integration lifecycle 却被结算

第十次现场中，真实 managed coding child 的模型 barrier、代码修改、commit 与聚焦测试均成功，但 repository queue 仍为
`absent`，workspace 保持 `active`；Root 收到的 child 文本声称工作完成，却没有任何 integration receipt。第十一次现场复现同一
权威状态，并观察到 workspace 在 child 结束后成为 active/orphan：child 从未调用 `subagent_integration`。这不是 queue 工具不可用；
另一些同配置真实运行已经完成 enqueue、admission、publish 和 receipt 生命周期。

首个偏离点是 child completion 边界只检查模型 mutation/output，不查询 Root Broker/coordinator 的 trusted queue 状态。因此
`agent_end` 不能作为完成证明（Pi 对它没有 veto），仅记录 pending；`agent_settled` 后通过无模型身份参数的
`inspect_integration_state` 查询 run grant 对应 workspace。唯一成功态是 queue `completed` 且 integration receipt 匹配。
queue absent 或非 terminal 时发送最多两次 `deliverAs=followUp`、`triggerTurn=true` continuation，每次发送前后重查；连续无进展、
查询失败或 capability 撤销后，由 trusted binding 将 queue/workspace 置为 `preserved` 并记录 integration completion debt。
重复 settled、extension reload、late query 与 shutdown 由 run generation fence 保持幂等；该 guard 仅随 managed coding worktree
child extension 安装，不改变 worktree=false、generic 或其他 Goal 路径。
