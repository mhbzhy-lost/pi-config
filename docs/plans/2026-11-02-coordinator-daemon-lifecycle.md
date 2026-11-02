# workspace coordinator 守护进程化与引用计数生命周期 实现计划

> **执行状态（2026-11-03，含验收审查修复）：** T1–T6 inline 执行完成，并经用户授权的 astra 成果验收审查；审查提出的 3 blocker + 8 high + 5 medium 已全部修复：①迁移全部遗漏的 claim 调用测试（multi-root/wave2y/worktree-lifecycle/coordinator-recovery）；②spawn 锁 mismatch 一律 fail-closed（D4 对齐）；③audit 同步四态判定（classifyCoordinatorOwnerSync，防 pid 复用误判）；④endpoint 父目录拉起前创建 0700；⑤绑定解析与 plan facts inspect 降级为 ledger/queue 本地视图（localCoordinatorView），查询不拉起；⑥preferClient 单 flight + 超时取消不回填缓存；⑦socket close 原子失效缓存引用；⑧锁内 endpoint 清理仅限连接被拒（活跃未知 listener fail-closed）；⑨daemon 退出守卫升级为 instanceId+pid+birthIdentity 全匹配；⑩daemon 日志目录创建、spawn error 收敛、泵 single-flight、whenStartupReady 契约、wrapper 必需 COMMON_DIR。验证：typecheck 通过；全仓测试 1599 项两轮全绿；隔离场景 F1–F5 10/10；yugang 旧 claim 残留 audit 正确分类 coordinator-legacy-registration。**F6 的 live 复核仍待用户重启受影响 Host 后执行，完成前本计划不标记整体完成。**
> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 跟踪。只有整体交付终态全部验证通过，才算计划执行完成；未满足时持续修复与验证。执行方式由计划编写完成后的用户选择决定。

**目标：** 把 workspace coordinator 从「寄生在随机会话 Host 进程内、启动时 claim、宿主死亡无人接管」改造为「独立 detached daemon：懒加载拉起 + 内核引用计数（Host 持久连接）+ 归零宽限自退」，并让纯查询在 daemon 不存在时降级 ledger 直读。

**架构：** coordinator 保持仓库级共享单例（merge queue / 处置 / terminal proof / trusted broker 的唯一仲裁者），但不再属于任何 Host：首个「需要类」操作（集成任务入队、处置、proof 结算、broker 注册、recovery 提交）在 spawn 锁内拉起独立 daemon；**每个 Host 以持久 socket 连接作为引用**（child 不直连：其 coordinator 请求经 Root Broker 由所属 Host 转发，child 是 Host 子进程，生命周期随 Host 闭合），进程以任何方式死亡时内核保证连接关闭；daemon 统一 idle 快照（活连接、在途、保留注册全零）持续宽限期后优雅退出。「利用类」操作（绑定解析、inspect/status 查询）存在则用、不存在降级 ledger 目标直读，绝不触发拉起。

**技术栈：** Node.js `>=22.19.0` 原生 type-stripping、`tsc --noEmit`、`node --test`、unix domain socket、既有 managed workspace ledger / coordinator 协议（`repository-workspace-coordinator.v1` wire 不变）、既有 durable recovery 轮询通道。

## 全局约束

- 仓库和 package 的最低 Node 版本 `>=22.19.0`；production 代码使用 `.ts`；新增/迁移实现由 `tsc --noEmit` 或等价静态检查覆盖。
- `scripts/` 只放 CLI/诊断入口；共享实现放 `packages/pi-subagents-enhanced/src/workspace/`。
- 未经用户明确授权不新增测试文件；既有测试、断言与 fixture 随已授权生产修复同步调整（允许）；全新测试仅列「建议（待用户授权）」。
- 不创建 commit，除非用户另行明确授权。
- 不对 live `var/workspaces` 做写操作（T6 的 live 复核单独列出，需用户在场执行）；不执行 raw `git worktree` 管理。
- daemon 日志与 metadata 不得包含 ownerToken、lease token 等敏感值。
- wire 协议保持 `repository-workspace-coordinator.v1` 兼容（不 bump）；升级生效前提是受影响仓库的全部 Host 重启，不做新旧双向长时混跑设计。
- 不引入 fs-ext 等新原生模块依赖（spawn 锁沿用既有 O_EXCL+staleness 模式，避免重演 node 版本构建事故）。
- 文档、代码注释、诊断文案使用中文；错误码、函数名、路径和标准技术术语保持现有字面量。

## 现状证据与范围

- 2026-11-02 事件：yugang coordinator 宿主（pid 47059，11-01 04:22 claim）正常退出后，已运行的 Host（22653，10:03 启动时旧 owner 存活故未接管）自 18:35 起所有 coordinator 依赖操作报 `Coordinator connection closed`；纯读的 `managed_workspace_status` 因绑定解析「coordinator 权威优先」同报此错。
- `extensions/subagent-runtime.ts:85-137`：Host 启动时 `registry.claim`，赢家进程内 `createCoordinatorServer` + `listen()`（仅此处调用一次），输家持久 client 连接；`:746-747` 启动即 `selectRepository`，`:353-354` 最终调 `connectRuntimeCoordinator`——当前**读取与分配也会建立 coordinator**，这是 F1 要拆掉的路径。
- `coordinator-server.ts:562 schedule()`：`clients.size===0` 过 `idleGraceMs` → `server.close()` 仅关 listener，进程不死、claim 不释放（第二缺口）；`:31` 另有 `active/retained` 计数，`:585 beginActivity`、`:596-610` listen 后才执行 startup recovery、`:545` 未就绪时非查询请求抛 `COORDINATOR_RECOVERY_NOT_READY`、`:616 close()` 无条件 `unlink(endpoint)`。
- `coordinator-client.ts:45-55`：持久连接、close→`failPending("Coordinator connection closed")`、`:55` 每次调用生成随机 transport requestId（除 integration-queue `:250-257` 的稳定幂等 requestId 外，wire 层无通用幂等）。
- `child-extensions/integration-queue.ts:118-130,215-221`：child 通过 Root Broker `coordinatorRequest` 转发，**child 无 coordinator socket**；`extensions/subagent-runtime.ts:207-212` 仅 Host 安装 broker 侧 coordinator 回调。
- `coordinator-process.ts:4-19`：按 `PI_COORDINATOR_*` 环境变量起 server 的旧入口，不登记 metadata、无归零退出。
- `coordinator-registry.ts:34-57`：metadata 路径由 `commonDir` 推导，`:57 writeRaw` 非原子（claim 路径 `:135-136` 用 temp+rename），`:70-110` 活性判定四态 alive/dead/mismatch/undetermined；`administration.ts:78-79` audit 目前仅 `process.kill(pid,0)`。
- `disposition-facade.ts`：读走 `localService`（ledger）；`issueOwnedDisposition/disposeOwned/releaseOwned` 走 coordinator；`reserve/ensureAllocated`（分配）ledger-local（事件当天 18:08 coordinator 濒死时 workspace 创建仍成功可证）。
- coordinator 方法调用点基线（T4 步骤 1 需扩展为完整逐方法表）：disposition facade 三方法、`enqueueIntegration/prepareAutoIntegration/advanceAutoIntegration/awaitIntegrationAdmission` 等（child 经 broker）、`recordTerminalProof`、`recoveryStatus/activateResume/recoveryRetry` 等（`subagent-runtime.ts:500,933,1049,1069`）、`run-binding-resolver.ts:54`、`terminal-proof-binding.ts:38,62`。
- 范围内：`coordinator-server.ts`、`coordinator-client.ts`、`coordinator-registry.ts`、`coordinator-process.ts`、`coordinator-daemon.ts`（新建）、`coordinator-spawn.ts`（新建）、`extensions/subagent-runtime.ts` 接线、`src/subagent-dispatch/run-binding-resolver.ts`、`src/subagent-dispatch/terminal-proof-binding.ts`、`src/workspace/disposition-facade.ts`、`src/workspace/administration.ts`、既有 coordinator/registry 测试的同步调整。范围外：durable queue 本体（`integration-queue.ts` 的 `daemonClaim/claimRevision` 队列租约语义保留不动）、supervisor channel、ledger 本体、disposition 状态机语义。

## 设计决策（已与用户确认方向 + 首轮 review 修订，执行者不得偏离）

- D1 **无主模型（限定范围）**：删除 **registry 层 claim/release 的 owner 语义**（含启动期接管与 owner 锁文件协议）；coordinator 是独立 detached 进程，任何 Host 平等连接。queue 层 `daemonClaim/claimRevision`、lease/CAS 语义与本计划无关，保留。
- D2 **懒加载触发点 = 需要类操作集合**：集成任务入队（`enqueueIntegration` 等，child 经 broker 由 Host 连接承载）、处置（`issueOwnedDisposition/disposeOwned/releaseOwned`）、terminal proof 结算（`recordTerminalProof`）、trusted broker 注册、recovery 提交（`activateResume/recoveryRetry` 等写操作）。分配（`reserve/ensureAllocated`）与全部读取/查询不触发；绑定解析与 proof binding 的读路径属利用类（D5）。
- D3 **引用 = Host 持久连接**：child 不直连 coordinator（经 Root Broker 转发，由所属 Host 的连接承载；child 为 Host 子进程，生命周期闭合）。不建 refs 目录、不做 pid 轮询计数；内核在进程任何死法下保证关闭 socket。**归零条件 = 统一 idle 快照**（`clients.size===0 && active===0 && retained===0`，复用 server 现有三计数）持续宽限期（默认 60s，daemon 参数可配）→ 原子 drain→close 转换后优雅退出并清理 socket 与 metadata。
- D4 **拉起与活性判定**：spawn 文件锁内 double-check → detached spawn → **startupReady 握手**（探测一个仅 startup recovery 完成后才成功的请求，非仅 socket 可连）→ poll 至超时（默认 10s，`COORDINATOR_SPAWN_FAILED` 附 daemon 日志尾 20 行）。锁内清理与活性判定复用 registry 四态：pid 不可达（dead）→ 清理陈旧 metadata/socket；**alive 且 socket 可连 → 直接复用**；alive 但 socket 连不上 → fail-closed `COORDINATOR_LOCKED_BY_LIVE_OWNER`（附 pid，提示重启该 Host）；**mismatch/undetermined（pid 复用、权限未知、identity 不可读）→ 一律 fail-closed 不覆盖**。daemon 退出清理以 `instanceId` 比对守卫，防止旧进程误删新 daemon 的 socket/metadata；spawn 锁覆盖「关闭旧实例→清理→新登记」全程。metadata 登记用 temp+rename 原子写。
- D5 **利用类降级**：绑定解析与查询路径改为「已有连接则用 → 短超时试连（不拉起）→ 失败降级 ledger 目标直读（复用 9b35ebf6 目标直读能力）」；`run-binding-resolver.ts`、`terminal-proof-binding.ts` 相应改为 optional-client。
- D6 **移除 `schedule()` 收缩**：listener 生命周期 = daemon 进程生命周期；归零退出由进程退出承担。
- D7 **recovery 事件投递等价**：daemon 的 `recoveryEventSink` 不再具备 Host 的 `pi.sendMessage` 快路径，一律落 durable（coordinator durable 状态本就是唯一权威）；消费统一走既有 durable `recovery.status` 轮询通道（`subagent-runtime.ts:101-105` 注释确认该通道存在且负责跨 Host 投递）。delivery debt 判定语义不变。
- D8 **旧入口收敛**：`coordinator-process.ts` 改造为新 daemon 的 env 形 wrapper（保留 `PI_COORDINATOR_*` env 协议，内部走 `runCoordinatorDaemon` 生命周期与登记），消灭「无登记、无归零」的旧 server 形态。

## 文件职责锁定

- `src/workspace/coordinator-daemon.ts`（新建）：daemon 进程入口；参数解析、metadata 原子登记、统一 idle 快照监视、归零宽限自退、instanceId 守卫清理、信号优雅退出、日志；导出 `runCoordinatorDaemon(argv)`。
- `src/workspace/coordinator-spawn.ts`（新建）：spawn 锁（四态 fail-closed 矩阵）、陈旧清理、startupReady 握手拉起；导出 `ensureCoordinatorDaemon`。
- `src/workspace/coordinator-process.ts`：改造为 daemon env wrapper（D8）。
- `src/workspace/coordinator-client.ts`：新增 `requireCoordinator`（需要类，触发拉起+建连+按方法重试表）与 `preferCoordinator`（利用类，不拉起、可降级）两类入口与 Host 级引用持有语义。
- `src/workspace/coordinator-server.ts`：移除 `schedule()` 收缩；暴露统一 idle 快照；close/unlink 以 instanceId 守卫。
- `src/workspace/coordinator-registry.ts`：移除 claim/release 的 owner 语义；保留 metadata 读写（原子化）与四态活性判定。
- `extensions/subagent-runtime.ts`：启动路径拆分（身份/ledger 上下文选择不再建连）；需要类/利用类接线；broker 注册随首连进行。
- `src/subagent-dispatch/run-binding-resolver.ts`、`src/subagent-dispatch/terminal-proof-binding.ts`：optional-client 化与 ledger fallback。
- `src/workspace/disposition-facade.ts`：dispatch 路径改走 `requireCoordinator`。
- `src/workspace/administration.ts`：audit 判定改用 registry 四态 + daemon kind。
- 既有测试同步调整：`test/managed-workspace-coordinator.integration.mjs`、`test/coordinator-registry-lock.test.mjs` 及 T5 步骤 1 穷举出的其他直接调用方。

## 整体交付终态

| ID | 必须成立的条件 | 验证方法与环境 | 通过判据 | 证据位置 | 覆盖任务 |
| --- | --- | --- | --- | --- | --- |
| F1 | 懒加载：从未触发需要类操作的仓库/会话，daemon 永不存在；纯 status/list/绑定解析/分配不拉起 | 临时隔离 state root：启动 Host 会话执行查询、绑定解析与 `subagent_start`（分配）后检查进程表与 socket 目录 | 无 daemon 进程、无 socket、无 metadata | 临时 state root 快照 + 验证输出 | T4、T6 |
| F2 | 拉起与引用：首个需要类操作在锁内拉起 detached daemon 并经 startupReady 后建 Host 持久连接执行成功；并发触发被锁串行化；child 集成请求经 Root Broker 由 Host 连接承载 | 临时 state root：两 Host 并发触发需要类操作；child（worktree 派发）提交集成任务 | 操作成功、仅一个 daemon、两 Host 各持一连接、child 无直连 | 验证脚本输出 | T1–T4、T6 |
| F3 | 归零释放：统一 idle 快照（连接/在途/保留全零）持续宽限（默认 60s）后 daemon 退出并清理 socket/metadata；全部 Host `kill -9` 同样成立；退出清理不误删新实例产物 | 临时 state root：触发拉起后断开/击杀全部持有者，等待宽限；再验证「旧实例退出与重拉交错」场景下新 socket 存活 | daemon 进程消失、socket 与 metadata 已清理、重拉后新实例不受影响 | 验证脚本输出 | T1、T3、T6 |
| F4 | 查询降级：daemon 不存在时 status/list/readOwned/绑定解析/proof binding 走 ledger 直读，不报 coordinator 错误、不拉起 | 临时 state root（无 daemon）：执行 `managed_workspace_status/list`、绑定解析与 proof binding 路径 | 全部成功返回、daemon 仍未诞生 | 工具结果 + 进程检查 | T4、T6 |
| F5 | 崩溃恢复：daemon 被 kill 后下一个需要类操作在锁内重拉成功，durable 状态无损失 | 临时 state root：kill -9 daemon → 重触发集成/处置操作 | 操作成功、新 daemon 就位、ledger/queue 状态一致 | 验证脚本输出 | T2、T3、T6 |
| F6 | 旧机制清理与兼容：registry claim/release owner 语义移除；`coordinator-process.ts` 收敛为 daemon wrapper；audit 四态判定；陈旧 metadata（含 yugang 现场）拉起时锁内清理；类型检查与既有测试（同步调整后）通过 | `npm run typecheck:subagents-enhanced` + `node --test`（T5 列出的既有测试文件）+ 用户重启 yugang Host 后 `worktree-lifecycle.ts audit` | 全绿；audit 不再报 `coordinator-singleton dead`（重启后）；无 claim 残留调用方 | 命令回执 | T1、T4、T5、T6 |
| F7 | recovery 投递等价：daemon 形态下 resume/preserve 事件落 durable 并由 Host 轮询通道等价送达；delivery debt 判定语义与改造前一致 | 临时 state root：构造 recovery intent（resume 场景），对比改造前后送达路径与 debt 记录 | 事件经轮询送达、无新增静默丢失、debt 判定一致 | 验证脚本输出 | T1、T4、T6 |

**完成规则：** F1–F7 同时满足，且验证证据对应当前交付版本，才能标记计划执行完成；仅完成任务步骤不能替代终态验证。

**未满足时：** 在已授权范围内持续 `fix → test（验证）→ 对照终态`；真实阻塞记录为未完成并写明恢复下一步。升级生效前提（受影响仓库 Host 全量重启）未满足时，F6 的 live 部分记为阻塞而非失败。

## DAG

```text
T1（daemon 入口与生命周期） ──> T2（spawn 锁与拉起器） ──> T3（client 两类入口与重试表） ──> T4（扩展接线与降级） ──> T5（registry/audit/旧入口清理） ──> T6（终态验证）
```

## Waves

- Wave 1：T1
- Wave 2：T2（依赖 T1 的 daemon CLI 与 idle 快照契约）
- Wave 3：T3（依赖 T2 的 `ensureCoordinatorDaemon` 接口）
- Wave 4：T4（依赖 T3 的两类入口契约）
- Wave 5：T5（依赖 T4 移除 claim 最后调用方；依赖 T1 的 wrapper 契约）
- Wave 6：T6（等待全部代码变更；live 复核需用户在场）

**关键路径：** T1 → T2 → T3 → T4 → T5 → T6（全串行：T5 必须等 T4 移除 claim 调用方后才能删实现）。

---

### Task 1：coordinator daemon 入口、统一 idle 快照与归零自退

**Agent：** `delegate`

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-daemon.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts`

**Resources：** 临时隔离 state root（`/tmp` 下自建）；不得触碰 live `var/workspaces`。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-daemon.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`（移除 `schedule()` 收缩；暴露 `idleSnapshot(): { clients, active, retained }`；`close()` 的 `unlink(endpoint)`/metadata 清理以 `instanceId` 比对守卫）
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts`（改造为 daemon env wrapper，D8）
- Suggested Test（待用户授权）：`test/coordinator-daemon.lifecycle.test.mjs`

**接口契约：**
- Consumes：现有 `createCoordinatorServer`（含 `recoveryEventSink` 钩子、`:596-610` listen→startup recovery 顺序、`:545` `COORDINATOR_RECOVERY_NOT_READY`）、`createCoordinatorRegistry` 的 metadata 读写与四态判定。
- Produces：
  1. daemon CLI：`coordinator-daemon.ts --state-root <abs> --repository-id <sha256> --storage-repository-id <sha256> --endpoint <abs sockPath> --idle-exit-grace-ms <n 默认 60000>`；行为：参数严格校验（非法 exit 2）→ 锁外自检 endpoint 无活 listener（有则 exit 3 防双 daemon）→ `createCoordinatorServer({ ..., recoveryEventSink: durable-only 落盘（D7，无 pi.sendMessage 快路径） })` + `listen()` → **startup recovery 完成后**才以 temp+rename 原子写 metadata `{ protocol: "repository-workspace-coordinator.v1", kind: "daemon", pid, birthIdentity, instanceId, repositoryId, storageRepositoryId, canonicalStateRoot, endpoint }` → 轮询 `idleSnapshot()`：三计数全零持续 `idle-exit-grace-ms` → 原子 drain（拒绝新请求）→ close（instanceId 守卫清理 socket 与 metadata）→ exit 0；`SIGTERM/SIGINT` 走同一优雅路径；stdout/stderr 追加 `<stateRoot>/logs/coordinator-<repositoryId 前 16>.log`（0600，超 1MB 截断）。导出 `runCoordinatorDaemon(argv)` 供测试与 wrapper 复用。
  2. `coordinator-process.ts` wrapper：`PI_COORDINATOR_*` env 协议不变（`ENDPOINT/REPOSITORY_ID/STORAGE_REPOSITORY_ID/INSTANCE_ID/STATE_ROOT/CAPABILITY`），缺失即抛（保留现有报错）；内部映射到 `runCoordinatorDaemon`，`idle-exit-grace-ms` 可由 `PI_COORDINATOR_IDLE_EXIT_GRACE_MS` 覆盖；stdout 首行仍输出就绪 JSON（追加 `kind: "daemon"`）。
  3. server 改造后导出 `idleSnapshot()` 与 `startupReady: Promise<void>`（供握手与 T2 复用）。

**终态关联：** `F2`（登记与被拉起）、`F3`（归零自退与 instanceId 守卫清理）、`F7`（recovery durable-only sink）。

**验收标准：**

- [x] **步骤 1：核对现有 server 生命周期与 metadata 契约**：记录 `createCoordinatorServer` 返回面、`clients/active/retained` 三计数的增减点（`beginActivity`/endActivity/注册保留）、startup recovery 顺序、registry 四态判定与 birthIdentity 生成方式；全仓 grep `idleGraceMs|schedule()` 确认收缩路径无其他依赖方。
- [x] **步骤 2：完成最小实现**：按接口契约实现三文件；注释标明「listener 生命周期=进程生命周期」「归零=引用计数释放（含在途/保留）」「instanceId 守卫防旧删新」；不引入 fs-ext。
- [x] **步骤 3：运行适用的既有检查并记录结果**：`npm run typecheck:subagents-enhanced`；临时 state root 手动起 daemon（`node coordinator-daemon.ts …`）：`nc -U` 建断连接验证归零退出与清理；验证「连接断开但在途请求未完时不退出」；验证 wrapper env 形等价；记录 exit 与输出。
- [ ] **停止条件**：发现 `repository-workspace-coordinator.v1` wire 之外存在未记录的 server 调用方依赖 claim 语义或 schedule 收缩、或 metadata 需写入敏感值时停止上报。
- [ ] **建议（待用户授权）：新增测试**：参数校验、双 daemon 防护、归零宽限（含在途不退出）、SIGTERM 优雅退出、instanceId 守卫清理、recovery durable-only sink。

---

### Task 2：spawn 锁与拉起器（四态 fail-closed + startupReady 握手）

**Agent：** `delegate`

**Deps：** `T1`（理由：拉起器 spawn T1 的 daemon CLI，依赖其参数、exit code、metadata 格式与 `startupReady` 契约）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts`

**Resources：** 临时隔离 state root；最多一个并发验证进程。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-spawn.ts`
- Suggested Test（待用户授权）：`test/coordinator-spawn.test.mjs`

**接口契约：**
- Consumes：T1 daemon CLI 参数/exit code/metadata 格式/`startupReady`；`coordinator-registry.ts` 四态活性判定（alive/dead/mismatch/undetermined）与 `commonDir` 推导。
- Produces：`ensureCoordinatorDaemon({ stateRoot, repositoryId, storageRepositoryId, commonDir, endpoint, spawnTimeoutMs = 10000 }): Promise<{ metadata: CoordinatorMetadata }>`——**只负责确保 daemon 存在并返回 metadata，不建业务 client**（client 由 T3/T4 用 `connectRepositoryCoordinator(identity, brokerRegistration, { metadata })` 完成）。实现：
  ① 读 metadata（经 `commonDir` 推导路径）：按四态分类——无 metadata：进入拉起；**alive 且 endpoint 可连：直接返回 metadata**；**alive 但连不上：抛 `COORDINATOR_LOCKED_BY_LIVE_OWNER`（附 pid，提示重启该 Host）**；**dead（pid 不可达）：进入锁内清理+拉起**；**mismatch/undetermined（pid 复用、权限未知、identity 不可读）：fail-closed 抛 `COORDINATOR_OWNER_UNDETERMINED`，不覆盖**。
  ② spawn 锁 `<endpoint>.spawn.lock`（`O_WRONLY|O_CREAT|O_EXCL` 0600，内容 pid+birthIdentity；已存在时读锁内 pid 做同款四态判定：dead→可覆盖，alive→等待重试至超时，mismatch/undetermined/malformed/EPERM→fail-closed）。
  ③ 锁内 double-check（复①的连接探测）；清理 dead 之陈旧 metadata 与 socket 文件（以 metadata 内 instanceId/birthIdentity 记录比对，防误删新实例产物）。
  ④ `spawn(process.execPath, [daemon.ts, …参数], { detached: true, stdio: "ignore", env: 继承 })` 后 `unref()`。
  ⑤ **startupReady 握手**：poll 一个仅 startup recovery 完成后才成功的探测请求（如幂等 status 类 op；连接成功但收到 `COORDINATOR_RECOVERY_NOT_READY` 视为未就绪继续等），至 `spawnTimeoutMs` 超时抛 `COORDINATOR_SPAWN_FAILED`（附 daemon 日志尾 20 行）；成功后释放锁并返回 daemon 写好的 metadata。

**终态关联：** `F2`（锁内串行化拉起）、`F5`（崩溃重拉）、`F6`（陈旧 metadata 清理）。

**验收标准：**

- [x] **步骤 1：核对锁与四态既有模式**：参照 `ledger.ts` `withLock` 的 O_EXCL+staleness 与 `coordinator-registry.ts:70-110` 四态判定；记录 malformed lock 的既有 TTL/undetermined 分支，对齐 fail-closed 矩阵。
- [x] **步骤 2：完成最小实现**：按接口契约实现；并发两进程同触发只允许一个 spawn（输家走等待→double-check 复用路径）；错误码统一 `failure()` 风格。
- [x] **步骤 3：运行适用的既有检查并记录结果**：`npm run typecheck:subagents-enhanced`；临时 state root 手动验证：正常拉起、双进程并发只起一个 daemon、kill -9 daemon 后重拉、alive-但-连不上断言 `COORDINATOR_LOCKED_BY_LIVE_OWNER`、malformed/undetermined 锁断言 fail-closed、startup 未就绪时握手不提前返回。
- [ ] **停止条件**：发现无法在不误杀活进程前提下区分「旧 in-process coordinator」与「死 daemon」（D4 的 alive-连不上分支不可行）时停止上报。
- [ ] **建议（待用户授权）：新增测试**：锁竞争、陈旧锁覆盖、四态矩阵、握手超时、`COORDINATOR_SPAWN_FAILED` 日志附带。

---

### Task 3：client 两类入口、Host 引用与按方法重试表

**Agent：** `delegate`

**Deps：** `T2`（理由：消费 `ensureCoordinatorDaemon` 的 metadata 产物作为需要类建连输入）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`

**Resources：** 临时隔离 state root。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- Suggested Test（待用户授权）：`test/coordinator-client-lazy.test.mjs`

**接口契约：**
- Consumes：T2 `ensureCoordinatorDaemon`；现有 `connectRepositoryCoordinator`（保持导出不变）。
- Produces：
  1. `requireCoordinator({ identity, brokerRegistration, ensure }): Promise<RepositoryCoordinatorClient>`——需要类：**Host 进程级**连接缓存（引用）；无连接或已断时：`ensure()` 拉起 → `connectRepositoryCoordinator(identity, brokerRegistration, { metadata })` 建连 → 随首连完成 broker 注册（复用现有注册 wire）。**断线重试按方法分表**：仅对具备稳定幂等语义的操作（integration-queue 系列的稳定 requestId、只读查询）在重连后重放一次；其余操作（disposition、settlement、recovery 写等非幂等 wire，服务端 settlementId 随机生成）断线后**直接向上抛**，不做泛化重放；重试表以常量导出（方法名→`replay|fail`）并注释依据。
  2. `preferCoordinator({ identity, brokerRegistration, connectTimeoutMs = 500 }): Promise<RepositoryCoordinatorClient | undefined>`——利用类：有缓存连接用缓存；无则短超时试连，失败返回 `undefined`（调用方降级 ledger），绝不拉起。
  3. `disposeCoordinator()`：Host 退出前主动断连（引用释放；内核兜底）。

**终态关联：** `F2`（Host 引用获取）、`F3`（引用释放）、`F5`（断线重拉）。

**验收标准：**

- [x] **步骤 1：核对 wire 幂等性事实**：逐方法记录 transport requestId 语义（`:55` 随机 vs integration-queue `:250-257` 稳定）与服务端副作用（settlementId 随机等），产出重试表初稿；发现表外模糊操作时标 `fail` 保守处理。
- [x] **步骤 2：完成最小实现**：按接口契约实现；注释标明「引用=Host 持久连接，内核担保释放；child 经 Root Broker 转发不直接持有」。
- [x] **步骤 3：运行适用的既有检查并记录结果**：`npm run typecheck:subagents-enhanced`；临时 state root 验证：requireCoordinator 首次拉起并复用、幂等方法断线重试成功、非幂等方法断线上抛、preferCoordinator 无 daemon 时返回 undefined 且未拉起。
- [ ] **停止条件**：发现需要类集合中存在既非幂等又必须自动重试的操作（无法 fail-up）时停止上报并给出操作清单。
- [ ] **建议（待用户授权）：新增测试**：引用缓存复用、重试表分派、preferCoordinator 不拉起。

---

### Task 4：扩展接线改造与查询降级

**Agent：** `delegate`

**Deps：** `T3`（理由：消费 `requireCoordinator/preferCoordinator` 接线到需要类/利用类调用点）。

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/run-binding-resolver.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/terminal-proof-binding.ts`
- `packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`

**Resources：** 临时隔离 state root；不触碰 live 状态。

**Files：**
- Modify：`extensions/subagent-runtime.ts`（启动路径拆分：`selectRepository`/`:746-747` 启动期不再建 coordinator；移除启动期 claim/connect/listen；接线两类入口）
- Modify：`src/subagent-dispatch/run-binding-resolver.ts`（optional-client 化，client 为空走 ledger）
- Modify：`src/subagent-dispatch/terminal-proof-binding.ts`（proof 提交路径分需要类/利用类）
- Modify：`src/workspace/disposition-facade.ts`（dispatch 改走 `requireCoordinator`）
- Suggested Test（待用户授权）：`test/subagent-runtime-root-upstream.test.mjs`（扩展既有断言）

**接口契约：**
- Consumes：T3 `requireCoordinator/preferCoordinator/disposeCoordinator`；`shouldStartRepositoryCoordinator(cwd)`、`resolveRepositoryIdentity(cwd)`（含 `commonDir`）既有函数；durable recovery.status 轮询通道（既有）。
- Produces：
  1. `connectRuntimeCoordinator` 改造为 `createLazyCoordinatorProviders({ pi, cwd, broker, stateRoot })`，返回 `{ requireClient(reason): Promise<client>, preferClient(): Promise<client|undefined>, dispose(): void }`；扩展加载/`selectRepository` 阶段**零建连零 claim**，仅解析身份与 ledger 上下文。
  2. `makeWorkspaceService` 的 `resolveCoordinatorClient` 改走 `requireClient("disposition")`。
  3. run/workspace 绑定解析（`selectReceipt`/`coordinatorRequest` 权威优先路径）与 `terminal-proof-binding` 读路径改 `preferClient()`，undefined 时走 ledger 目标直读（9b35ebf6 能力）；proof **提交**（`recordTerminalProof`）归需要类 `requireClient`。
  4. recovery 写操作（`activateResume/recoveryRetry` 等，`:500,933,1049,1069` 调用点）归需要类；recovery 事件消费确认走 durable 轮询通道（F7 等价性在本任务验证）。
  5. Host 进程退出钩子调用 `dispose()`。
  6. **完整调用点分类表**：步骤 1 产出（见验收），并作为 F1/F4 验证范围依据。

**终态关联：** `F1`（查询/分配不拉起）、`F2`（首个需要类操作拉起）、`F4`（绑定解析/proof binding 降级）、`F7`（recovery 轮询等价）。

**验收标准：**

- [x] **步骤 1：穷举 coordinator 调用点并逐方法分类**：全仓 grep coordinator client 方法调用（`coordinatorRequest`、facade dispatch、integration-queue、proof outbox、recovery/resume、completion-reminder、binding resolver、terminal-proof-binding），产出「文件:行号 → 方法 → 需要类/利用类/无关 + 降级路径」完整清单；发现无法归类或非请求驱动的后台职责时停止上报（该场景破坏懒加载语义需重新评估）。
- [x] **步骤 2：完成最小实现**：按接口契约改造；`shouldStartRepositoryCoordinator` 判定外的仓库零行为变化；旧 `connectRuntimeCoordinator` 若有残留调用方（含 `scripts/probes/goal-smoke.ts`）保留兼容壳并标 deprecated，同步适配 probe。
- [x] **步骤 3：运行适用的既有检查并记录结果**：`npm run typecheck:subagents-enhanced`；`node --test test/subagent-runtime-root-upstream.test.mjs` 及步骤 1 清单涉及的既有测试；临时 state root 验证 F1/F4/F7 场景（查询与分配不拉起、无 daemon 时 status 成功、recovery intent 经轮询送达）。
- [ ] **停止条件**：发现某需要类操作存在 daemon 缺位时无法 fail-up 的后台自动触发路径时停止上报。
- [ ] **建议（待用户授权）：新增测试**：查询不拉起、首个集成提交拉起、绑定解析降级、recovery 轮询等价。

---

### Task 5：registry 去 owner 化、audit 适配与旧入口清理

**Agent：** `delegate`

**Deps：** `T1`（理由：消费 daemon metadata `kind: "daemon"` 格式与 wrapper 契约）；`T4`（理由：claim 的唯一生产调用方在 T4 移除后才能删实现，避免中间态编译失败）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts`
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`
- `packages/pi-subagents-enhanced/README.md`
- `test/managed-workspace-coordinator.integration.mjs`
- `test/coordinator-registry-lock.test.mjs`
- （步骤 1 穷举出的其他 claim/release 直接调用测试文件，届时补入本清单并同步调整）

**Resources：** none。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts`（移除 claim/release owner 语义；`writeRaw` 原子化 temp+rename；四态判定保留）
- Modify：`packages/pi-subagents-enhanced/src/workspace/administration.ts`（audit coordinator 判定）
- Modify：`packages/pi-subagents-enhanced/README.md`（生命周期一节）
- Modify：上述既有测试（同步调整断言到新语义，不新增文件）

**接口契约：**
- Consumes：T1 metadata 格式与 wrapper；registry 四态判定；`administration.ts:78-79` 现有判定。
- Produces：registry 仅保留 `read()/writeRaw()`（原子）与路径推导；claim/release 及 owner 锁文件协议删除；`auditManagedWorkspaces` 判定：metadata 缺失 → `missing`；`kind: "daemon"` 且四态 alive → `observed`；dead → `stale` + debt `coordinator-daemon-dead`；mismatch/undetermined → `stale` + debt `coordinator-owner-undetermined`（fail-closed 提示人工核对）；非 daemon kind（旧 claim 残留）→ `stale` + debt `coordinator-legacy-registration`（提示由拉起器清理）。README 增补「懒加载 + Host 连接引用 + 归零自退 + recovery durable 轮询」说明。

**终态关联：** `F6`。

**验收标准：**

- [x] **步骤 1：核对 claim 全部调用方**：全仓 grep `registry.claim|registry.release|\.claim(|\.release(`，穷举生产与测试调用方；T4 未移除的生产调用方存在时停止上报；测试调用方全部列入 WritePaths。
- [x] **步骤 2：完成最小实现**：按接口契约改造；`integration-queue.ts` 的 `daemonClaim/claimRevision` 队列语义确认不动（grep 记录）；audit debt 文案中文化。
- [x] **步骤 3：运行适用的既有检查并记录结果**：`npm run typecheck:subagents-enhanced`；`node --test test/managed-workspace-coordinator.integration.mjs test/coordinator-registry-lock.test.mjs`（及步骤 1 补充清单）；对临时 state root 构造四类 metadata 形态验证 audit 判定。
- [ ] **停止条件**：发现 claim 锁文件协议被 `scripts/` 下生产 CLI 依赖时停止上报。
- [ ] **建议（待用户授权）**：无新增测试，仅既有断言迁移。

---

### Task 6：终态验证与 live 复核

**Agent：** `executor`

**Deps：** `T5`（理由：全部代码变更集成后才能验证终态）。

**WritePaths：** none（只读验证；一次性验证脚本写 `/tmp`，不入仓）。

**Resources：** 临时隔离 state root；live 复核需用户在场并先重启 yugang 会话 Host。

**Files：** none。

**接口契约：**
- Consumes：F1–F7 验证方法。
- Produces：逐条 F 条件的验证证据（命令、输出、结论）。

**终态关联：** `F1`–`F7`。

**验收标准：**

- [x] **步骤 1：静态与回归**：`npm run typecheck:subagents-enhanced`；`node --test` 运行 T4/T5 列出的全部相关既有测试文件；记录 exit 与失败分类（基线外失败为零）。
- [x] **步骤 2：隔离场景验证 F1–F5、F7**：在 `/tmp` 临时 state root 用一次性验证脚本依次执行：无 daemon 纯查询/绑定解析/分配（F1/F4）→ 两进程并发首个需要类操作 + child 集成提交（F2）→ 断开全部 Host 连接与 kill -9 全 Host 两种方式等待宽限（F3，宽限参数调小如 3000ms）→ kill -9 daemon 后重触发（F5）→ recovery intent 轮询送达对比（F7）；每步记录进程表与 socket 目录快照；脚本与输出存 `/tmp/coordinator-lifecycle-verify/`。
- [ ] **步骤 3：live 复核 F6（需用户在场）**：用户重启 yugang 会话 Host 后，确认无旧 claim 元数据残留、audit 不再报 `coordinator-singleton dead`、一次 worktree 集成任务触发 daemon 拉起与归零退出；本步未获用户配合时记为阻塞而非失败。
- [ ] **停止条件**：任何 F 条件复现失败且修复超出已授权范围（需改 wire 协议、需新增生产兼容分支）时停止上报。

---

## 执行备注

- 本计划不使用 Goal Engine 执行；执行方式（Subagent-Driven / Inline）由用户选择。
- 若 T4 步骤 1 穷举出本计划未预见的需要类/不可降级调用点，按停止条件上报，由主会话决策后再续，不在执行中自行扩 scope。
