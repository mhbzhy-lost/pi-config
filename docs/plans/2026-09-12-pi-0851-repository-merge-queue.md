# Pi 0.85.1 与 Repository Merge Queue 实现计划

> **给执行 agent：** 必须逐任务执行本计划；步骤使用 `- [ ]` 复选框跟踪。执行方式由计划完成后的用户选择决定。

**目标：** 将 Pi core 从 `0.84.4` 受控升级到 `0.85.1`，修复 `worktree:true` 无法完成“创建、工作、集成、回收”的生产流程，并为同一 Git common-dir 下多个 root Pi session 派发的 subagent worktree 建立独立于 root session 的 repository coordinator 与 child-owned rebase/fast-forward queue。

**架构：** Pi core 升级与 merge queue 是两个可独立验收的交付物，`pi-subagents` 保持 `0.62.0`。每个 Git common-dir 由一个独立 Node coordinator 进程拥有 workspace registry、integration queue 和 Git 资源处置权；subagent 在自己的 worktree 完成 commit 后由 trusted child lifecycle 入队，获得 admission 时 rebase 到 coordinator 给出的最新目标 commit，再提交 sealed candidate，coordinator 通过目标 ref CAS 执行 fast-forward。机械门禁挂在 Pi `0.85.1` awaited `agent_end`：此时仍可在同一 AgentSession 中追加有限 follow-up；`agent_settled` 只负责最终状态记录与恢复补偿。Root Broker 继续拥有 child process 和控制协议，root session 只负责派发、观察与显式回收，不执行合回；现有 `src/workspace/` service、ledger、action token、Git operation lock 和 reconcile 是唯一生命周期实现。

**技术栈：** Node.js `>=22.19.0`、原生 TypeScript type-stripping、Pi Extension API `0.85.1`、`pi-subagents@0.62.0`、Node `net`/`child_process`/`fs`、Git worktree、Node test runner、TypeBox。

## 全局约束

- 仓库和 package 的最低 Node 版本固定为 `>=22.19.0`。
- Pi 配置根是 `pi/`，不是 `~/.pi`。
- Pi core 目标版本精确固定为 `0.85.1`；`@earendil-works/pi-agent-core`、`pi-ai`、`pi-coding-agent`、`pi-tui` 必须同步升级。
- `pi-subagents` 精确保持 `0.62.0`；不得引入 `0.63+`、Worktrunk、native `AgentSession` child runtime 或新的 upstream patch。
- `pi/settings.json` 的 `enabledModels` 是 per-machine 配置，禁止修改或提交；`pi/models.json` 是本机配置，禁止修改或提交。
- 所有 production 代码、配置与行为变更严格执行 RED-GREEN-REFACTOR；每个任务先观察正确 RED，再写最小实现。
- 文档、代码注释和问题记录使用中文，仅专业术语、协议字段和代码标识符可保留英文。
- repository coordinator 只处理 subagent/Goal task/Goal validation 的 managed workspace；不为主 agent 自动创建 worktree。
- 本计划的 merge queue 只接管 standalone coding subagent 的集成；Goal task/Goal validation 保持既有 disposition 语义，但与 queue 共用同一 repository Git operation lock。
- cwd fingerprint、主 agent状态缓存、跨 clone、跨机器、自动解决 merge conflict、自动 stash 和强制覆盖用户修改均不在本计划范围。
- repository scope 只能由 canonical Git common-dir 决定；root session 只能作为业务 owner，不能作为 coordinator identity 或 ledger 分区键。
- coordinator singleton endpoint/owner metadata 固定放在 Git common-dir 的私有 coordinator 目录，durable workspace 数据继续使用首次启动确认的 canonical state root；后续 client 声明不同 state root 时连接既有 daemon 并 fail closed，不得启动第二个 daemon。
- Root Broker 继续拥有 child process、steer/interrupt/resume/stop 与 terminal proof；Repository Coordinator 只拥有 Git workspace、integration queue、处置和回收。
- coordinator 只信任经过 Root Broker registry challenge 建立的 server-to-server registration。upstream 可在 child 启动时通过环境变量注入非秘密的 rootSessionId/runId locator，但授权只来自对应 run 私有 grant 文件和 Broker 内存 principal；workspaceId、grant token 和 capability 不得进入环境变量、模型参数、prompt、session 或普通 socket payload。私有目录权限固定 `0700`、grant 文件固定 `0600`，terminal/stop 后撤销。
- subagent 入队前必须提交 clean committed workspace；admission 绑定 queue lease 和最新 target commit；publish 前必须验证 sealed candidate HEAD、workspace clean、writePaths、owner/run binding 与 target ref CAS。
- integration 发生在 child 尚存活且等待 publish 结果期间；terminal proof 改为 cleanup 前置条件，不再作为 integration 前置条件。coordinator 只有在 child terminal 后才能删除 worktree。
- source cwd dirty、Git sequencer 活跃、workspace 身份不一致或来源不确定时必须 fail closed；不得自动 stash、reset、覆盖或删除现场。
- target ref 必须是 canonical origin checkout 当前检出的 symbolic branch；publish critical section 在执行前后检查 branch binding、HEAD、index、worktree 和 sequencer，并只使用 `git merge --ff-only <candidateHead>` 同步更新 ref/index/worktree。不得用裸 `git update-ref` 更新已检出 branch。
- 所有 standalone subagent、Goal task 和 Goal validation workspace 继续使用 `packages/pi-subagents-enhanced/src/workspace/` 的唯一 service、ledger 和 Git lifecycle。
- TUI renderer 只能压缩显示；不得改写 agent 实际收到的 message、tool result、event payload、session 内容或结构化 details。
- 测试必须创建独立临时 Git repo、state root 和 socket root；不得触碰用户仓库 worktree、`var/goals` 或现存运行目录。
- 不默认创建 Git commit；只有用户另行明确授权后才允许提交。
- 当前 Goal Runtime 仍处于 Manual Preview；在既定 R13 验收与 fresh Host 前不得使用 Goal Engine 执行、编排或验收本计划。
- 计划完成后必须先取得用户对本次完成后审阅的单独明确批准，再派发 `reviewer` 对整体完成情况执行一次 review；最多两次，修复后再报告。

## 非目标与残余边界

- 多个 root Pi session 仍可直接修改同一个 source cwd；coordinator 不协调这些主 agent 写入，只在 source dirty 时阻断 subagent integration。
- repository coordinator 的一致性范围是同机、同一 Git common-dir；不同 clone 即使指向同一 remote 也不共享 queue。
- queue 不替模型解决语义冲突。child trusted lifecycle 负责执行 rebase、保留 sequencer、报告冲突并发起有限 continuation；模型只解决未合并文件并 `git add`，随后 lifecycle 执行 `rebase --continue` 和验证。child 明确失败、终止或 lease 失效后才释放队首并保留 workspace。
- 自动机械集成只在 awaited `agent_end` 中启动；禁止把 `agent_settled` 当作原子 veto。`agent_settled` 之后若仍存在未结算状态，只能执行一次持久化恢复/通知路径，不得直接递归启动无限新 run。
- coordinator 不成为 subagent supervisor，不读取 child session 内容，也不替代 acceptance evidence。
- “rebase 到 main worktree”精确定义为 rebase 到 admission 返回的目标 branch commit，不读取或合并 main worktree 的未提交内容。
- child rebase 后的 candidate 必须是 admitted target commit 的 descendant；coordinator 初期只支持 `rebase-ff`，不在 queue worker 中执行 cherry-pick、merge commit 或自动 rebase。
- 威胁边界只防止模型、tool 参数和其他 root session 越权；同 UID 恶意本地进程不属于安全边界，必须在文档中明确。
- 非协作外部编辑器不遵守 coordinator lock；publish 依赖 Git 自身 index/ref lock、执行前后 clean 检查和精确 commit receipt 降低竞争风险，检测到并发写入后保留现场，但不宣称能阻止同 UID 外部进程在 Git 更新窗口覆盖文件。
- 测试和验收只允许在临时 fixture repository 内创建 Git commit；“不默认创建 Git commit”仍适用于仓库本身。

## DAG

```text
T1 (Pi 0.85.1 升级) ───────────────────────────────────────────────┐
                                                                   │
T2 (Coordinator 协议与仓库身份) ──> T3 (独立进程与可信连接) ──> T4 (worktree:true 缺陷与多 Root 接入) ──┐
             │                                                                                │
             └────────────────────> T5 (持久化 FIFO Queue) ────────────────────────────────────> T6 (集成与崩溃恢复)
                                                                                                      │
                                                                                         ┌────────────┴────────────┐
                                                                                         v                         v
                                                                                  T7 (Public Child 接线) ──> T8 (Doctor/Admin)
                                                                                                               │
                                                                                                               v
                                                                                                  T9 (端到端验收与文档) <── T1
```

## Waves

- Wave 1：T1、T2（可并行；分别产出 Pi 运行时基线与 coordinator 协议）。
- Wave 2：T3、T5（可并行；都只依赖 T2 的协议与 repository identity）。
- Wave 3：T4（先记录并复现 `worktree:true` 全流程缺陷，再接入 repository-scoped service；不依赖 T5 的 queue 实现）。
- Wave 4：T6（等待 T4 的 repository-scoped workspace service 与 T5 的 durable queue）。
- Wave 5：T7（接入 public Host、child tool 与 terminal proof handoff）。
- Wave 6：T8（等待 T7 的 proof/delivery debt，接入运维面）。
- Wave 7：T9（等待 T1、T7、T8，执行真实五 child 与全量验收）。

**关键路径：** T2 → T3 → T4 → T6 → T7 → T8 → T9。T1、T5 不在关键路径，但 T1 是 T9 的运行时验收前置。

---

### Task 1：Pi core 0.85.1 受控升级

**Deps：** `none`

**WritePaths：**
- `package.json`
- `package-lock.json`
- `packages/pi-subagents-enhanced/package.json`
- `packages/pi-subagents-enhanced/package-lock.json`
- `init-pi.sh`
- `scripts/doctor.ts`
- `scripts/probes/pi-subagents-compat.ts`
- `pi/extensions/openai-codex-proxy.ts`
- `docs/bugs/2026-09-12-pi-ai-esm-export-resolution.md`
- `src/session-owner/contract.ts`
- `test/helpers/pi-host.mjs`
- `test/helpers/pi-runtime.test.mjs`
- `test/pi-subagents-compat.test.mjs`
- `test/pi-runtime.integration.mjs`
- `test/openai-codex-proxy-extension.test.mjs`
- `test/session-owner-contract.test.mjs`

**Resources：** npm registry、package lock 与当前 Pi Host extension startup；同一时间只允许一个任务写两份 lockfile。T1 从首次修改 runtime import 到完成候选安装/聚焦 GREEN 期间，不得启动任何新的 Pi subagent Host；已经启动且完成 extension load 的任务可继续。

**Files：**
- Modify：`package.json`、`package-lock.json`
- Modify：`packages/pi-subagents-enhanced/package.json`、`packages/pi-subagents-enhanced/package-lock.json`
- Modify：`init-pi.sh`
- Modify：`scripts/doctor.ts`、`scripts/probes/pi-subagents-compat.ts`
- Modify：`pi/extensions/openai-codex-proxy.ts`
- Create：`docs/bugs/2026-09-12-pi-ai-esm-export-resolution.md`
- Modify：`src/session-owner/contract.ts`、`test/helpers/pi-host.mjs`
- Test：`test/pi-subagents-compat.test.mjs`
- Test：`test/pi-runtime.integration.mjs`
- Test：`test/openai-codex-proxy-extension.test.mjs`
- Test：`test/session-owner-contract.test.mjs`
- Test：`test/helpers/pi-runtime.test.mjs`

**接口契约：**
- Consumes：Pi `0.85.1` 的 public root exports、`@earendil-works/pi-ai/compat`、stdio RPC 与 Extension API；`pi-subagents@0.62.0` 的现有 patched runtime。
- Produces：四个 `@earendil-works/pi-*` package 精确为 `0.85.1` 的可复现安装；doctor/probe 接受 `0.85.1`；production 代码不再通过 `dist/compat.js` 或 `dist/index.js` 加载公开 Pi API。

**验收标准：**Pi `0.85.1` 与 patched `pi-subagents@0.62.0` 可同时加载；现有 RPC、session owner、Codex proxy、TUI 和 subagent runtime 聚焦测试通过；`pi/settings.json` 与 `pi/models.json` 无本任务 diff。

- [x] **步骤 1：为版本门禁和 public exports 编写失败测试**

  在 `test/pi-subagents-compat.test.mjs` 中将候选版本设为 `0.85.1`，保留未知 patch 版本拒绝断言；在 Codex proxy、session-owner、probe resolver 和 `test/helpers/pi-runtime.test.mjs` 中断言 loader 只请求 public package export，不拼接 `dist/*.js`。

- [x] **步骤 2：运行测试确认 RED**

  运行：

  ```bash
  node --test test/pi-subagents-compat.test.mjs test/openai-codex-proxy-extension.test.mjs test/session-owner-contract.test.mjs test/helpers/pi-runtime.test.mjs
  ```

  预期：FAIL，原因为 `0.85.1` 未进入 allowlist，且当前 resolver 仍访问 `dist` 路径。

- [x] **步骤 3：更新 public import 与版本常量**

  将 `pi-ai/dist/compat.js` 改为 `@earendil-works/pi-ai/compat`；将 `SessionManager`、compat probe resolver 和测试 Host loader 改为 package root public export。更新 `init-pi.sh`、doctor 与 probe 的 Pi 版本，不改变 `pi-subagents` 版本。

- [x] **步骤 4：同步 manifests 与 lockfiles**

  将四个 Pi package 在根 package 和 enhanced package 中精确设为 `0.85.1`，使用仓库既有 npm 流程更新两份 lockfile；确认 `pi-subagents` 仍为 `0.62.0`，且 `enabledModels` 没有进入 diff。

- [x] **步骤 5：运行聚焦测试确认 GREEN**

  运行：

  ```bash
  node --test test/pi-subagents-compat.test.mjs test/pi-runtime.integration.mjs test/openai-codex-proxy-extension.test.mjs test/session-owner-contract.test.mjs test/helpers/pi-runtime.test.mjs
  npm run verify:subagents-enhanced
  npm run typecheck:root
  npm run typecheck:subagents-enhanced
  ```

  预期：PASS；plain Node 可加载 patched runtime，stdio RPC 与 public SDK 合同不变。

- [ ] **步骤 6：执行 Pi 0.85.1 交互 smoke**

  使用候选配置启动一次 regular 和 fullscreen session，验证 `/model`、`/thinking`、custom footer、child browser、RPC abort 与 `ctx.cwd`；记录命令、版本和结果，不修改 per-machine model 配置。

### Task 2：Repository Coordinator 协议与仓库身份

**Deps：** `none`

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts`
- `packages/pi-subagents-enhanced/src/workspace/repository-identity.ts`
- `packages/pi-subagents-enhanced/src/workspace/contract.ts`
- `test/managed-workspace-coordinator-protocol.test.mjs`
- `test/managed-workspace-repository-identity.integration.mjs`

**Resources：** 临时 Git repositories；测试目录必须隔离。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts`
- Create：`packages/pi-subagents-enhanced/src/workspace/repository-identity.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/contract.ts`
- Test：`test/managed-workspace-coordinator-protocol.test.mjs`
- Test：`test/managed-workspace-repository-identity.integration.mjs`

**接口契约：**
- Consumes：现有 `WorkspaceOwnerScope`、`WorkspaceRecord`、`WorkspaceInspection`、`DispositionActionToken` 与 Git common-dir inspection。
- Produces：`COORDINATOR_PROTOCOL_VERSION = "repository-workspace-coordinator.v1"`；`resolveRepositoryIdentity(cwd): Promise<{ repositoryId: string; originRoot: string; commonDir: string; storageRepositoryId: string }>`，其中 `repositoryId` 是 common-dir hash，`originRoot/storageRepositoryId` 固定指向 `git worktree list --porcelain` 的 canonical main worktree 与其现有 ledger 分区；严格 TypeBox request/reply unions；`CoordinatorProcessIdentity`、`CoordinatorRegistration`、`IntegrationQueueReceipt` 与 root/child/admin 权限矩阵。

  权限矩阵固定为：Root Broker 可 attach/detach、登记/撤销 child binding、提交 terminal proof 与查询本 root receipt；绑定 child 只能对自己的 workspace enqueue、await、report conflict、publish 或 fail；root Host 只能查询 owned status，不能替 child publish；admin 默认只有 repository audit，reconcile 必须提供现有 public lease authorization；只有 coordinator internal worker 可以 claim queue 和执行 Git mutation。

**验收标准：**同一 clone 的主 worktree 与 linked worktree 得到同一 `repositoryId` 和 canonical storage partition，不同 clone 得到不同 identity；旧的非主 worktree ledger 分区被识别为 migration debt 而非自动合并；所有 RPC request 都绑定 protocol、requestId、repositoryId 和 server-side registration，未知字段、跨 repository 请求和无 capability admin mutation 被拒绝。

- [x] **步骤 1：编写 repository identity RED**

  创建临时 repo、linked worktree 和第二个 clone，断言 common-dir identity 的共享与隔离，并断言 linked worktree 选择 main worktree 的既有 originRoot-hash ledger 分区；增加旧 linked-worktree ledger、symlink cwd、非 Git cwd 和不存在 cwd 的行为。

- [x] **步骤 2：运行 identity 测试确认 RED**

  运行：`node --test test/managed-workspace-repository-identity.integration.mjs`

  预期：FAIL，原因为 `resolveRepositoryIdentity` 尚不存在。

- [x] **步骤 3：实现最小 repository identity**

  使用 `git rev-parse --show-toplevel`、`git rev-parse --git-common-dir` 和 `git worktree list --porcelain`，对 realpath 后的 common-dir 计算 SHA-256；main worktree root 决定兼容的 `storageRepositoryId`。不接受调用方提供 repository ID，旧 linked-worktree 分区只进入 migration debt inventory。

- [x] **步骤 4：编写协议 codec RED**

  覆盖 Broker `attach` challenge、`detach`、workspace service 调用、child queue 调用、read-only audit、authorized reconcile 和事件通知；验证 root/child/admin 权限矩阵以及跨 root owner 参数不能伪造 trusted owner scope。

- [x] **步骤 5：运行协议测试确认 RED**

  运行：`node --test test/managed-workspace-coordinator-protocol.test.mjs`

  预期：FAIL，原因为协议 codec 和版本常量尚不存在。

- [x] **步骤 6：实现协议并确认 GREEN**

  运行：

  ```bash
  node --test test/managed-workspace-coordinator-protocol.test.mjs test/managed-workspace-repository-identity.integration.mjs
  npm run typecheck:subagents-enhanced
  ```

  预期：PASS。

### Task 3：独立 Coordinator 进程、可信注册与连接恢复

**Deps：** `T2`（理由：消费 `repository-workspace-coordinator.v1` codec 与 canonical repository identity）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-auth.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `test/managed-workspace-coordinator.integration.mjs`
- `test/managed-workspace-coordinator-recovery.test.mjs`

**Resources：** 每个测试使用独立 socket/state root；真实 spawn Node 子进程；不得共享端点。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-process.ts`
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-registry.ts`
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-auth.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/process-birth-identity.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- Test：`test/managed-workspace-coordinator.integration.mjs`
- Test：`test/managed-workspace-coordinator-recovery.test.mjs`

**接口契约：**
- Consumes：T2 的 identity、codec 与权限矩阵；现有 Root Broker registry/process identity。
- Produces：`connectRepositoryCoordinator(identity, brokerRegistration, options): Promise<RepositoryCoordinatorClient>`；coordinator 主动 challenge 已登记 Root Broker 并签发内存 registration capability，后续 owner scope 由该 registration 注入；child request 由 Root Broker 已验证的 run/workspace binding 代理；`RepositoryCoordinatorClient.close()` 只释放 registration。metadata `coordinator.json` 绑定 PID、process birth identity、instanceId、repositoryId、canonicalStateRoot、endpoint 和 protocol version。

**验收标准：**两个真实 Root Broker/client 对同一 common-dir 连接同一 daemon；不同 common-dir 使用不同 daemon；不同 state root 的第二 client 不能启动第二 daemon；直接伪造 attach、旧 capability replay、foreign bindRun/proof 和越权 reconcile 均拒绝；死 PID metadata 可恢复，活 PID/identity 不一致时 fail closed；clean idle daemon 在 30 秒 grace 后删除 socket 退出，有 queued/admitted 操作时不得 idle exit。

- [x] **步骤 1：编写跨进程单例 RED**

  两个测试进程各启动一个真实 Root Broker 并并发连接同一临时 repo，断言 `instanceId` 相同；另建 repo 断言不同。验证 singleton endpoint/owner metadata 位于 common-dir 私有目录，canonical state root 只由胜出的 daemon 记录。

- [x] **步骤 2：运行测试确认 RED**

  运行：`node --test test/managed-workspace-coordinator.integration.mjs`

  预期：FAIL，原因为 coordinator client/process 尚不存在。

- [x] **步骤 3：实现 lazy start 与 RPC transport**

  使用 `process.execPath` 直接 spawn `coordinator-process.ts`，通过 Node `net` 的 LF-delimited JSON 建立本地 IPC；启动竞争由 common-dir 原子 metadata/lock 和 process birth identity 解决。coordinator 反向连接 Root Broker registry 完成 challenge，socket/metadata 权限设为当前用户可读写；普通请求不携带可由模型选择的 rootSessionId。

- [x] **步骤 4：编写崩溃与 stale metadata RED**

  覆盖 daemon `SIGKILL`、PID reuse 模拟、metadata 半写、protocol mismatch、socket 存在但 owner 不存活、client 请求中途断开、伪造 Broker registry、重连旧 capability、不同 state root 竞争、clean idle shutdown 和 queued 时禁止退出。

- [x] **步骤 5：运行恢复测试确认 RED**

  运行：`node --test test/managed-workspace-coordinator-recovery.test.mjs`

  预期：FAIL，原因为 stale recovery 尚未实现。

- [x] **步骤 6：实现恢复并确认 GREEN**

  metadata 使用临时文件加原子 rename；只有 PID 与 process birth identity 均失效时才接管；registration capability 随 broker process identity 或 coordinator instance 变化立即撤销；未知状态保留现场并返回诊断，不删除 workspace。clean idle shutdown 只在无 client、无 queue claim、无正在执行的 Git action 时发生，durable workspace 可留待下次 lazy start reconcile。

  运行：

  ```bash
  node --test test/managed-workspace-coordinator.integration.mjs test/managed-workspace-coordinator-recovery.test.mjs
  npm run typecheck:subagents-enhanced
  ```

  预期：PASS。

### Task 4：记录 `worktree:true` 缺陷并接入多 Root Workspace Service

**Deps：** `T3`（理由：需要独立 daemon/client 生命周期和 repository registration）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/registry.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `docs/bugs/2026-09-12-subagent-worktree-lifecycle-broken.md`
- `test/managed-workspace-multi-root-session.integration.mjs`
- `test/subagent-worktree-lifecycle.integration.mjs`
- `test/managed-workspace-service.integration.mjs`
- `test/managed-workspace-terminal-proof.test.mjs`

**Resources：** 两个真实 client process、一个临时 repo、两个 root session fixture；同一 repo 测试不得并行。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/registry.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- Create：`docs/bugs/2026-09-12-subagent-worktree-lifecycle-broken.md`
- Create：`test/managed-workspace-multi-root-session.integration.mjs`
- Create：`test/subagent-worktree-lifecycle.integration.mjs`
- Test：`test/managed-workspace-service.integration.mjs`
- Test：`test/managed-workspace-terminal-proof.test.mjs`

**接口契约：**
- Consumes：现有 workspace service API 与 T3 client/server。
- Produces：root-session registry 仅保存 `rootSessionId -> RepositoryCoordinatorClient registration`；daemon 内每个 repository 只创建一个 `ManagedWorkspaceService`；所有 public requests 由 server 从 trusted connection registration 注入 `WorkspaceOwnerScope`，不信任 agent 参数中的 root identity。

**验收标准：**问题记录给出 public typed 入口、首个偏离点、完整生成调用链和 production 可达分类；对应精确 RED 在任何 service/registry 修改前被观察，并由本任务修复到“child worktree 完成工作并进入 committed/run-bound 可排队状态”；Root A 与 Root B 共享 repository inventory 但不能互相处置；Goal owner 路径仍使用同一 service；main-worktree legacy partition 原地作为 canonical storage，旧 linked-worktree partition 只报告 migration debt。

- [x] **步骤 1：记录 `worktree:true` 生产缺陷来源链**

  使用现有 public typed `subagent` 调用和 `subagent_worktree` receipt 复现“创建后无法走到集成与回收”的第一个偏离点；在中文问题记录中写明 actual entry、workspace/run/owner 事实、事件顺序、预期状态机与现场保留策略，不用手工拼非法 ledger fixture 证明 production 可达。若首个偏离点不是 root-local registry/run binding，停止实施并先修订本计划。

- [x] **步骤 2：编写 public lifecycle 首段 RED**

  `test/subagent-worktree-lifecycle.integration.mjs` 通过 public typed dispatch 创建 child worktree、执行真实写入与 commit，断言 workspace 可由 repository coordinator 观察为 committed/run-bound。测试只覆盖 queue 前置里程碑，完整 rebase/publish/cleanup 由 T7 扩展。

- [x] **步骤 3：运行首段测试确认 RED**

  运行：`node --test test/subagent-worktree-lifecycle.integration.mjs`

  预期：FAIL，且失败原因与问题记录的首个偏离点一致。

- [x] **步骤 4：编写双 Root Session RED**

  两个 client 使用不同 rootSessionId 各创建 workspace，断言 `listOwned` 隔离、repository inventory 汇总、foreign dispose/release 拒绝，以及一个 client 断开后另一个仍能 status。

- [x] **步骤 5：运行测试确认 RED**

  运行：`node --test test/managed-workspace-multi-root-session.integration.mjs`

  预期：FAIL，当前 registry 仍按 root session 创建独立 service。

- [x] **步骤 6：将 service 实例移入 coordinator server**

  保持 `ManagedWorkspaceService` 的既有状态机，不抽取第二套核心；registry 改为 client registration facade。server 根据 Broker registration 绑定 owner scope，再调用现有 service。main worktree 的既有 originRoot-hash partition 作为 canonical storage；扫描到旧 linked-worktree partition 时只写 migration debt，不复制、合并或删除记录。

- [x] **步骤 7：运行首段、双 Root 与既有 service 回归确认 GREEN**

  运行：

  ```bash
  node --test test/subagent-worktree-lifecycle.integration.mjs test/managed-workspace-multi-root-session.integration.mjs test/managed-workspace-service.integration.mjs test/managed-workspace-terminal-proof.test.mjs
  ```

  预期：PASS；现有 workspace record 无需复制到第二个 ledger。

- [x] **步骤 8：验证非 Git cwd 行为**

  增加并运行测试，确认未请求 worktree 的 generic subagent 不启动 coordinator；非 Git cwd 请求 managed worktree 时返回稳定的 unsupported receipt，不创建 daemon 状态目录。

### Task 5：持久化 FIFO Integration Queue

**Deps：** `T2`（理由：queue item 与 receipt 使用 coordinator protocol 和 repository identity；实现可与 T3 并行）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts`
- `test/managed-workspace-integration-queue.test.mjs`
- `test/managed-workspace-integration-queue.concurrent.mjs`

**Resources：** 多进程 queue claim 测试；每个测试使用独立 state root。

**Files：**
- Create：`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- Create：`packages/pi-subagents-enhanced/src/workspace/coordinator-ledger.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts`
- Create：`test/managed-workspace-integration-queue.test.mjs`
- Create：`test/managed-workspace-integration-queue.concurrent.mjs`

**接口契约：**
- Consumes：T2 的 `IntegrationQueueReceipt` 与 repository identity。
- Produces：`INTEGRATION_QUEUE_RECORD_VERSION = "workspace-integration-queue-item.v1"`；`enqueueIntegration(request)`、`claimNext(instanceIdentity)`、`completeItem(receipt)`、`failItem(receipt)`、`recoverClaims(instanceIdentity)`、`listQueue()`；单调 `sequence` 决定 FIFO。

  Queue item 固定字段：

  ```ts
  type IntegrationQueueItem = {
    version: "workspace-integration-queue-item.v1";
    queueItemId: string;
    repositoryId: string;
    sequence: number;
    workspaceId: string;
    leaseId: string;
    ownerScope: WorkspaceOwnerScope;
    strategy: "rebase-ff";
    targetRef: string;
    authorizedWorkspaceHead: string;
    observedTargetHead: string;
    admittedTargetHead?: string;
    candidateHead?: string;
    claimRevision?: number;
    admissionGeneration: number;
    integrationIntentId?: string;
    workspaceDispositionReceiptId?: string;
    attempt: number;
    state: "queued" | "admitted" | "rebasing" | "resolving-conflict" | "prepared" | "completed" | "blocked" | "preserved" | "cancelled";
  };
  ```

  Queue 只拥有 `queued -> admitted -> rebasing/resolving-conflict -> prepared -> completed` 的调度事实；workspace ledger 独占 `pendingAction -> disposing -> released/preserved/cleanup-debt`。`integrationIntentId` 和 `workspaceDispositionReceiptId` 只引用 workspace ledger 的权威记录，不在 queue 中复制处置状态。

**验收标准：**多个 child 并发 enqueue 获得唯一递增 sequence；任一时刻每个 repository 只有一个 admitted item；daemon claim、child admission lease、workspace lease 是三个独立 identity；publish 成功即将 queue item 标记 completed 并释放队首，terminal cleanup 不占队首；child terminal、Broker stop 或显式 authorized cancel 可撤销 admission，不能按 wall-clock 强抢 live child；retry 创建新 item 排到队尾。

- [x] **步骤 1：编写 FIFO 与 CAS RED**

  覆盖并发 enqueue、稳定排序、重复 request 幂等、同一 workspace 重复排队拒绝、单 consumer claim、daemon claim/child admission/workspace lease 混用拒绝、publish 后立即推进下一项和 revision mismatch。

- [x] **步骤 2：运行测试确认 RED**

  运行：`node --test test/managed-workspace-integration-queue.test.mjs`

  预期：FAIL，原因为 queue ledger 尚不存在。

- [x] **步骤 3：实现 durable queue ledger**

  使用 repository state root 下的版本化 queue item 文件、原子 rename 与现有 ledger lock/CAS 约定；不得仅在内存保存 queue。`observedTargetHead` 用于诊断，不作为消费时的最终事实。

- [x] **步骤 4：编写真实多进程 RED**

  spawn 四个 enqueue client，验证 sequence 唯一和 FIFO；模拟 daemon `SIGKILL`、child terminal、Broker authorized cancel、live child 卡住、半写 receipt 和 retry attempt。

- [x] **步骤 5：运行并发测试确认 RED**

  运行：`node --test test/managed-workspace-integration-queue.concurrent.mjs`

  预期：FAIL，原因为 claim recovery 和 process identity fencing 尚不存在。

- [x] **步骤 6：实现 claim fencing 并确认 GREEN**

  daemon claim 绑定 coordinator instanceId、PID birth identity 和 queue revision；child admission 绑定 trusted run/workspace、admissionGeneration 和 queue lease。dead daemon 或 authoritative child terminal 可恢复，live child 只报告 blocked，不按超时抢占。

  运行：

  ```bash
  node --test test/managed-workspace-integration-queue.test.mjs test/managed-workspace-integration-queue.concurrent.mjs
  npm run typecheck:subagents-enhanced
  ```

  预期：PASS。

### Task 6：Child Rebase、Sealed Candidate 与 Queue Fast-Forward

**Deps：** `T4`（理由：需要 repository-scoped workspace service 与 trusted owner registration）；`T5`（理由：需要 durable queue/claim/receipt 状态机）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-ledger.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- `packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- `test/managed-workspace-integration-queue.integration.mjs`
- `test/managed-workspace-coordinator-recovery.test.mjs`
- `test/managed-workspace-action-token.concurrent.mjs`

**Resources：** 同一临时 repo 的 Git integration 测试必须串行；使用真实 commits/worktrees，不 mock Git。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-ledger.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/ledger.ts`
- Create：`test/managed-workspace-integration-queue.integration.mjs`
- Modify：`test/managed-workspace-coordinator-recovery.test.mjs`
- Test：`test/managed-workspace-action-token.concurrent.mjs`

**接口契约：**
- Consumes：T4 workspace service；T5 queue item/claim。测试通过 coordinator server 的 trusted internal fixture 调用，不依赖尚未在 T7 注册的 public child tool。
- Produces：`awaitIntegrationAdmission(queueItemId, childBinding): Promise<{ queueLeaseId: string; targetRef: string; targetHead: string }>`；`publishRebasedCandidate({ queueItemId, queueLeaseId, candidateHead }): Promise<QueueTurnReceipt>`；workspace service 先持久化唯一 integration intent，再由 coordinator 在 canonical origin checkout 中执行 `git merge --ff-only candidateHead`；queue receipt 只引用 service disposition receipt；cleanup 继续等待 Root Broker terminal proof。

  Publish 的持久化顺序固定为：queue 将 candidate 标记 `prepared` 并保存精确 candidate HEAD；workspace ledger 写入绑定 queueItemId/candidate/target 的 integration intent；获取 Git operation lock并执行 fast-forward；workspace ledger 写入精确 disposition receipt；queue 引用该 receipt 转为 `completed` 并立即释放 admission；terminal proof 到达后由 workspace service 独立进入 disposing/cleanup。任一步骤崩溃均从前一权威 receipt 恢复，不以相同 tree 推断已完成。

**验收标准：**两个 trusted child binding fixture 按 sequence 获得 admission并提交已 rebase candidate；canonical origin checkout 的 symbolic branch、HEAD、index 和 worktree 一致推进；publish 成功即释放 queue head，cleanup 在独立 workspace state 中等待 terminal proof；并发 source 编辑、外部 target advance、冲突和 crash window 均 fail closed 或幂等恢复。

- [x] **步骤 1：编写双 Owner FIFO integration RED**

  两个 trusted owner/child binding fixture 从同一 base 创建无冲突 commits，按 sequence 获得 admission；第二个 candidate 基于第一个已 fast-forward 后的 target。测试只调用 T6 internal server contract，不伪造 public Host event。

- [x] **步骤 2：运行测试确认 RED**

  运行：`node --test test/managed-workspace-integration-queue.integration.mjs`

  预期：FAIL，当前 service 没有 admission/sealed-candidate/fast-forward 协议。

- [x] **步骤 3：实现 admission 与最新状态重检**

  child 通过 trusted run/workspace binding 入队并写 durable intent；admission 时重新验证 workspace HEAD、lease、source clean、sequencer empty 和 target HEAD，返回 queue lease 与 immutable target commit。前序合法推进由后续 item 在 admission 时观察，不使其提前失效。

- [x] **步骤 4：编写 sealed candidate RED**

  测试 child 只允许在获得 admission 后执行 `git rebase <targetHead>`；rebase 完成后 workspace 必须 clean 且 HEAD 为 target descendant。没有 queue lease、lease 已过期、candidate HEAD 漂移和越界 changed files 均拒绝 publish。

- [x] **步骤 5：实现 canonical checkout fast-forward critical section**

  固定锁顺序为 `coordinator queue claim -> workspace ledger intent -> Git common-dir operation lock`；禁止反向获取。锁内再次确认 canonical origin checkout 正检出 `targetRef`、HEAD 等于 admitted targetHead、index/worktree clean、sequencer empty，然后执行 `git merge --ff-only <candidateHead>`；命令后验证 symbolic branch、HEAD、index/worktree 一致。不得使用裸 `git update-ref`、reset 或 stash。

- [x] **步骤 6：编写冲突、CAS、checkout 与并发 source 编辑 RED**

  覆盖 child rebase 冲突后报告 `resolving-conflict`、target branch 未在 canonical checkout 检出、detached HEAD、admission 后外部 target advance、检查后到 merge 前出现 source 编辑、merge 后到 receipt 前出现 source 编辑、workspace HEAD 在 sealed 后被修改、queue lease 重放和 foreign child binding。Git 命令失败时保留现场，不以 reset/stash 修补。

- [x] **步骤 7：实现 fail-closed 分支并确认 GREEN**

  `resolving-conflict` 保持当前 admission，允许绑定的 child 继续处理；child 失败、终止或显式放弃时转为 `preserved` 并释放 queue。CAS 失败后 retry 创建 `attempt + 1` 的新 queue item。source dirty 只标记 blocked，不删除或 stash。

- [x] **步骤 8：编写 crash window、Git stale lock 与跨生命周期竞争 RED**

  在 admission 已发出但 child 未 rebase、candidate prepared 但 workspace intent 未写、intent 已写但 merge 未开始、target checkout 已 fast-forward 但 receipt 未写、queue completed 但 child 未 terminal、worktree 已删除但 service 未完成六个 fault injection 点终止 daemon。增加 Git operation directory lock 的 PID birth identity/stale recovery，以及 Goal apply/reconcile 与 queue publish 的锁顺序测试。

- [x] **步骤 9：实现 reconcile 并确认 GREEN**

  只在 target HEAD 精确等于已记录 candidate commit 且 workspace ledger 持有匹配 integrationIntentId 时确认已集成；不得以 tree-equivalent 猜测成功。来源不确定时进入 `preserved` 或 `cleanup-debt`。

  运行：

  ```bash
  node --test test/managed-workspace-integration-queue.integration.mjs test/managed-workspace-coordinator-recovery.test.mjs test/managed-workspace-action-token.concurrent.mjs
  ```

  预期：PASS。

### Task 7：Extension、Root Broker Proof 与完成通知接入

**Deps：** `T6`（理由：需要稳定 coordinator client、queue receipt 和 worker completion event）。

**WritePaths：**
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- `packages/pi-subagents-enhanced/src/workspace/registry.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/tool.ts`
- `packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts`
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- `test/subagent-worktree-lifecycle.integration.mjs`
- `test/managed-workspace-terminal-proof-handoff.integration.mjs`
- `test/subagent-workspace-tool.test.mjs`
- `test/subagent-workspace-completion-reminder.test.mjs`
- `test/pi-subagents-runtime.integration.mjs`
- `test/root-subagent-broker-protocol.test.mjs`

**Resources：** 两个 Pi/RPC root Host fixture；同一临时 repo；避免复用真实 session 目录。

**Files：**
- Modify：`packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-protocol.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-registry.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts`
- Modify：`packages/pi-subagents-enhanced/src/subagent-dispatch/workflow-spawn.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/registry.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/service.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/tool.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/completion-reminder.ts`
- Create：`packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts`
- Create：`packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- Modify：`test/subagent-worktree-lifecycle.integration.mjs`
- Create：`test/managed-workspace-terminal-proof-handoff.integration.mjs`
- Test：`test/subagent-workspace-tool.test.mjs`
- Test：`test/subagent-workspace-completion-reminder.test.mjs`
- Test：`test/pi-subagents-runtime.integration.mjs`
- Test：`test/root-subagent-broker-protocol.test.mjs`

**接口契约：**
- Consumes：T6 coordinator client、admission/publish receipt 与现有 Root Broker run binding。
- Produces：child-only `subagent_integration` 工具，固定 action 为 `enqueue`、`await_admission`、`report_conflict`、`publish`、`fail`；workspaceId、runId、rootSessionId 从 Root Broker trusted binding 注入，不接受模型自报。Root Broker 通过幂等 `record_terminal_proof` server-to-server RPC 交付 proof；daemon 不可用时写入私有 outbox，重连后按 proofId replay。extension startup 请求 Broker attach coordinator，dispose 只撤销 registration；queue event 产生原始结构化通知。

**验收标准：**public `worktree:true` 测试从 T4 的 committed/run-bound 里程碑扩展到 enqueue/rebase/publish/terminal cleanup 并转 GREEN；同一 cwd 的两个真实 root Host 连接同一 coordinator；工具不能通过参数伪造 identity；环境变量只定位私有 run grant且不能独立授权；正常 proof、daemon 暂不可用后的 replay、root SIGKILL 前后 proof 窗口均有确定结果；无法取得 authoritative proof 时保留 workspace 并形成可观察 proof debt；upstream leaf 始终 `worktree:false`。真实模型调用 `subagent_integration` 由 T9 五子代理验收统一证明。

- [x] **步骤 1：编写 child-only queue 工具 RED**

  断言 root 的 `subagent_worktree dispose(integrate)` 对新 workspace 返回 `CHILD_OWNS_INTEGRATION`；child 工具 enqueue 返回 queueItemId，`await_admission` 返回 targetHead/lease，`report_conflict` 只允许当前 admitted child 调用，publish 返回 integrated/awaiting-terminal；root status 可观察但不能代替 child publish。

- [x] **步骤 2：运行测试确认 RED**

  运行：`node --test test/subagent-workspace-tool.test.mjs`

  预期：FAIL，当前工具同步处置且没有 queue receipt。

- [x] **步骤 3：扩展 public lifecycle 测试确认完整流程 RED**

  将 T4 的 `test/subagent-worktree-lifecycle.integration.mjs` 扩展为 public child enqueue、admission、rebase、publish、terminal proof、cleanup；运行后预期在 child tool/Host binding 缺失处 FAIL，T4 已通过的 create/work/commit 断言保持 GREEN。

- [x] **步骤 4：接入 coordinator client 与 child 指令**

  extension startup 以 trusted Host session identity 注册；所有 workspace tool 调用经 client RPC；coding child prompt 明确要求 commit 后依次调用 enqueue、await_admission、在 worktree 中 rebase、遇到冲突先 report_conflict 并保留 target 现有改动、完成验证后 publish，且 publish 完成前不得结束。Root Broker/run/workspace identity 只通过 server-side binding 获取，不接受 tool 参数自报。

- [x] **步骤 5：编写 terminal proof handoff、授权与 root exit RED**

  覆盖 Root Broker challenge、直接伪造 attach、foreign bindRun/proof、旧 registration replay、正常 terminal proof、proof 已产生但 daemon 暂不可用、Broker/Root SIGKILL 前 proof 未产生、重启 outbox replay、queued/completed/blocked/resolving-conflict/proof-debt/cleanup-debt 通知；Root A detach 后 Root B 只能 audit repository queue，不能处置 A 的 workspace。

- [x] **步骤 6：实现 proof outbox 与 durable receipt 驱动通知**

  Root Broker 在观察 authoritative terminal event 时将 proofId/run/process identity 交给 coordinator；发送失败写私有 outbox，重连幂等 replay。若 Broker 在 proof 产生前消失，coordinator 不从 PID/TUI 文案推断 terminal，只保留 workspace 并记录 proof debt。`completion-reminder` 通知失败只记录 delivery debt。

- [x] **步骤 7：运行 public Host 集成确认 GREEN**

  运行：

  ```bash
  node --test test/subagent-worktree-lifecycle.integration.mjs test/subagent-workspace-tool.test.mjs test/subagent-workspace-completion-reminder.test.mjs test/managed-workspace-terminal-proof-handoff.integration.mjs test/root-subagent-broker-protocol.test.mjs test/pi-subagents-runtime.integration.mjs
  ```

  预期：PASS。

### Task 8：Doctor、管理 CLI 与状态迁移

**Deps：** `T7`（理由：需要稳定 queue/reconcile receipt、coordinator metadata、proof debt 与 delivery debt）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `scripts/doctor.ts`
- `scripts/worktree-lifecycle.ts`
- `packages/pi-subagents-enhanced/package.json`
- `package.json`
- `test/worktree-lifecycle-cli.test.mjs`
- `test/pi-subagents-enhanced-package.test.mjs`
- `test/doctor.test.mjs`
- `docs/audits/2026-09-12-repository-coordinator-migration.md`

**Resources：** CLI 测试使用隔离 state root；不连接或清理真实 coordinator。

**Files：**
- Modify：`packages/pi-subagents-enhanced/src/workspace/administration.ts`
- Modify：`packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- Modify：`scripts/doctor.ts`
- Modify：`scripts/worktree-lifecycle.ts`
- Modify：`packages/pi-subagents-enhanced/package.json`
- Modify：`package.json`
- Test：`test/worktree-lifecycle-cli.test.mjs`
- Test：`test/pi-subagents-enhanced-package.test.mjs`
- Create：`test/doctor.test.mjs`
- Create：`docs/audits/2026-09-12-repository-coordinator-migration.md`

**接口契约：**
- Consumes：T6 queue/reconcile/admin receipts。
- Produces：继续通过既有 `./workspace/admin` 暴露 coordinator audit types，不新增第三个 workspace export；`worktree-lifecycle audit` 是只读 inventory，`reconcile` 需要现有显式 public lease authorization 后才发送 mutation request；doctor 检查 singleton identity、protocol、queue CAS、legacy root registry 和 lock ordering。

**验收标准：**CLI 只通过既有 package public API audit 或请求 authorized reconcile；没有 raw Git cleanup；main-worktree 现有 ledger partition 原地接管，旧 linked-worktree partition 和不同 state-root 请求形成 migration debt；无法证明 owner/proof 的旧 active record标记 preserved，不自动释放。

- [x] **步骤 1：编写 admin/doctor RED**

  增加两个 root owner、queued item、dead coordinator metadata、proof/delivery/cleanup debt、旧 linked-worktree partition、不同 state-root client 和旧 active record fixture；断言 audit 输出稳定结构，doctor 对 split-brain、未授权 reconcile 与未知 queue schema 报错。

- [x] **步骤 2：运行测试确认 RED**

  运行：

  ```bash
  node --test test/worktree-lifecycle-cli.test.mjs test/doctor.test.mjs test/pi-subagents-enhanced-package.test.mjs
  ```

  预期：FAIL，当前 admin 不认识 coordinator/queue。

- [x] **步骤 3：实现 public admin facade 与 doctor**

  `audit` 调用 coordinator client 的 read-only inventory；`reconcile` 必须消费现有 public lease authorization，不能因本机 CLI 身份自动获得 mutation 权限。package export 不允许调用方构造 trusted owner scope 或直接 claim queue。

- [x] **步骤 4：实现保守迁移**

  coordinator 使用 canonical main worktree 对应的现有 ledger partition；首次启动扫描 record。旧 linked-worktree partition、不同 state-root 请求和无法由 authoritative proof/Git inspection 解释的 active/disposing 状态保持原记录并标记 migration debt，不自动复制、合并或删除。

- [x] **步骤 5：编写中文迁移审计文档**

  `docs/audits/2026-09-12-repository-coordinator-migration.md` 记录 schema、来源链、首次偏离点、迁移分类、保留项和人工处置命令；不得包含真实 session 内容、凭据或本机 provider 配置。

- [x] **步骤 6：运行聚焦测试确认 GREEN**

  运行：

  ```bash
  node --test test/worktree-lifecycle-cli.test.mjs test/doctor.test.mjs test/pi-subagents-enhanced-package.test.mjs
  npm run verify:subagents-enhanced
  ```

  预期：PASS。

### Task 9：端到端验收、运行文档与最终回归（已由 T10–T13 取代）

**Deps：** `T1`（理由：最终 Host 必须运行 Pi `0.85.1`）；`T8`（理由：消费 T8 已验收的 Host/coordinator/admin 完整链路）。

**状态：** 历史验收草案，仅保留其文件范围和背景；不得按本任务执行。当前收尾必须执行 T10–T13，尤其是 T12 的 Auto Integration 五 Child 验收。

**WritePaths：**
- `test/managed-workspace-multi-root-session.integration.mjs`
- `test/managed-workspace-integration-queue.integration.mjs`
- `test/pi-runtime.integration.mjs`
- `test/repository-merge-queue-acceptance-probe.test.mjs`
- `test/fixtures/repository-merge-queue-acceptance/**`
- `test/fixtures/repository-merge-queue-acceptance/acceptance-barrier.mjs`
- `scripts/probes/repository-merge-queue-acceptance.ts`
- `packages/pi-subagents-enhanced/README.md`
- `packages/pi-subagents-enhanced/AGENTS.md`
- `README.md`
- `docs/plans/2026-09-12-pi-0851-repository-merge-queue.md`

**Resources：** 最终全量测试独占仓库测试资源；两个真实 Pi `0.85.1` RPC Host、至少五个可并发 detached coding subagent、一个临时 Git repo、独立 session/state roots。真实模型验收是长耗时操作，必须由 subagent 执行，主 agent 不得阻塞等待或轮询。

**Files：**
- Modify：`test/managed-workspace-multi-root-session.integration.mjs`
- Modify：`test/managed-workspace-integration-queue.integration.mjs`
- Modify：`test/pi-runtime.integration.mjs`
- Create：`test/repository-merge-queue-acceptance-probe.test.mjs`
- Create：`test/fixtures/repository-merge-queue-acceptance/src/pipeline.ts`
- Create：`test/fixtures/repository-merge-queue-acceptance/test/pipeline.test.mjs`
- Create：`test/fixtures/repository-merge-queue-acceptance/package.json`
- Create：`test/fixtures/repository-merge-queue-acceptance/acceptance-barrier.mjs`
- Create：`scripts/probes/repository-merge-queue-acceptance.ts`
- Modify：`packages/pi-subagents-enhanced/README.md`
- Modify：`packages/pi-subagents-enhanced/AGENTS.md`
- Modify：`README.md`
- Modify：`docs/plans/2026-09-12-pi-0851-repository-merge-queue.md`（只更新复选框与实际验收记录）

**接口契约：**
- Consumes：历史链路文件由 T10–T12 重新定义。
- Produces：无；当前验收接口见 T10–T13。

**验收标准：**历史标准已废止；当前标准见 T10–T13。

- [x] **步骤 1：旧 probe 草案已转移到 T12**

  fixture 初始实现固定为单行 `export const PIPELINE = ["base"];`。五个任务分别添加 `parse`、`validate`、`transform`、`serialize`、`audit`，每个任务都必须修改这同一行并增加自身行为断言。测试定义 barrier 的五方集合、超时、重复到达和释放合同，并断言 probe 只通过 public coordinator audit 确认 allocation receipt。

- [x] **步骤 2：旧 probe 草案已转移到 T12**

  运行：`node --test test/repository-merge-queue-acceptance-probe.test.mjs`

  预期：FAIL，原因为真实五 child acceptance orchestration 尚不存在。

- [x] **步骤 3：旧 probe 草案已转移到 T12**

  probe 只使用 public typed subagent/coordinator API，禁止直接写 ledger 或伪造 event。它给两组 Host 注入 test-only barrier extension，等待五个合法 child binding 到达后确认同一 base/不同 path，再一次性释放。临时 Git 环境使用空白 `GIT_CONFIG_GLOBAL`、`GIT_CONFIG_NOSYSTEM=1`、`rerere.enabled=false` 和 `rerere.autoupdate=false`。conflict receipt 必须由 coordinator 观察 rebase sequencer、unmerged entries 和对应 child binding 后生成，不能仅记录模型声明。

- [x] **步骤 4：既有双 Host 回归已转移到 T10/T12**

  运行 T7 已转 GREEN 的真实 RPC Host、child enqueue/admission/rebase/publish、root detach、daemon restart 和 reconcile 场景；T9 不再补 production 接线。

- [x] **步骤 5：旧端到端回归已转移到 T10/T12**

  运行：

  ```bash
  node --test test/managed-workspace-multi-root-session.integration.mjs test/managed-workspace-integration-queue.integration.mjs test/pi-runtime.integration.mjs
  ```

  预期：PASS；如失败，将修复回派 T6/T7 对应 WritePaths，不在 T9 添加未声明的 production 接线。

- [x] **步骤 6：文档责任已转移到 T13**

  说明 coordinator scope、lazy start、queue 状态、root detach、blocked/resolving-conflict/preserved、proof/delivery/cleanup debt、audit/reconcile、明确非目标与人工干预边界。

- [x] **步骤 7：聚焦回归责任已转移到 T13**

  运行：

  ```bash
  node --test \
    test/pi-subagents-compat.test.mjs \
    test/pi-runtime.integration.mjs \
    test/pi-subagents-enhanced-package.test.mjs \
    test/managed-workspace-contract.test.mjs \
    test/managed-workspace-ledger.integration.mjs \
    test/managed-workspace-service.integration.mjs \
    test/managed-workspace-terminal-proof.test.mjs \
    test/managed-workspace-action-token.concurrent.mjs \
    test/managed-workspace-coordinator-protocol.test.mjs \
    test/managed-workspace-coordinator.integration.mjs \
    test/managed-workspace-coordinator-recovery.test.mjs \
    test/managed-workspace-multi-root-session.integration.mjs \
    test/managed-workspace-integration-queue.test.mjs \
    test/managed-workspace-integration-queue.concurrent.mjs \
    test/managed-workspace-integration-queue.integration.mjs \
    test/repository-merge-queue-acceptance-probe.test.mjs \
    test/subagent-workspace-tool.test.mjs \
    test/subagent-workspace-completion-reminder.test.mjs \
    test/root-subagent-broker-protocol.test.mjs \
    test/worktree-lifecycle-cli.test.mjs \
    test/doctor.test.mjs
  npm run typecheck:root
  npm run typecheck:subagents-enhanced
  npm run verify:subagents-enhanced
  npm run doctor
  ```

  预期：全部 PASS，无 warning 被忽略。

- [ ] **步骤 8：运行真实五 Subagent 验收**

  由独立执行 subagent 运行：

  ```bash
  node scripts/probes/repository-merge-queue-acceptance.ts --roots 2 --subagents 5 --require-conflicts 4
  ```

  预期：PASS；receipt 证明五个真实 detached child、五个独立 worktree、同一 base barrier、四个不同 child 的 rebase 非零退出/unmerged entries/sequencer 证据、四次 conflict resolution、五次 CAS fast-forward、最终 fixture tests 通过、queue/worktree/process 全部结算。验收超时或失败时停止两个 Host，保留临时 repo、queue receipt 和未结算 worktree 供诊断，不执行 force cleanup；只有 PASS 路径要求零资源泄漏。

- [ ] **步骤 9：仅在计划末尾运行一次全量测试**

  运行：`npm test`

  预期：全部 PASS；不得在此前任务中重复运行全量套件。

- [ ] **步骤 10：执行完成后独立审阅门禁**

  先向用户请求并取得本次执行后 review 的单独明确批准；再派发一次 `reviewer`，检查计划偏差、跨进程正确性、锁顺序、crash window、越权路径、测试证据和遗留资源。最多允许第二次 review 验证修复，不得把 reviewer 文案替代测试证据。

## 收尾阶段：Auto Integration 与最终验收

前序 T1–T8 已在当前工作树完成并有聚焦证据：Pi `0.85.1`、repository coordinator、durable FIFO queue、Root/leaf CWD 分离、proof outbox、storage partition、managed rebase primitive 和 Auto Integration 基础状态机均已实现。以下任务只覆盖尚未完成的收尾，不重做已通过的基础任务。

### 收尾 DAG

```text
T10 (Auto Integration completion guard) ──> T11 (异常恢复与主 agent 回收)
T12 (真实五 Child 冲突验收 harness) ──> T13 (真实验收 + 全量 + 完成审阅)
T11 ───────────────────────────────────────> T13
```

### 收尾 Waves

- Wave 8：T10、T12 可并行；T10 负责 production lifecycle，T12 负责仅测试/验收 harness。
- Wave 9：T11（依赖 T10，补异常、回收和通知）。
- Wave 10：T13（等待 T11、T12，执行真实五 child、聚焦回归、一次全量测试和最终 reviewer）。

**收尾关键路径：** T10 → T11 → T13；T12 是最终验收关键路径。

### Task 10：Auto Integration Completion Guard 与自动机械生命周期

**Deps：** `T1`、`T4`、`T5`、`T6`、`T7`、`T8`（理由：消费已完成的 coordinator、queue、workspace、proof、rebase 和 public child binding）。

**WritePaths：**
- `docs/bugs/2026-09-14-child-integration-auto-lifecycle.md`
- `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
- `packages/pi-subagents-enhanced/src/workspace/child-integration-git.ts`
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/prompt.ts`
- `test/subagent-auto-integration-lifecycle.integration.mjs`
- `test/subagent-auto-integration-recovery.integration.mjs`
- `test/subagent-integration-completion-guard.test.mjs`
- `test/managed-child-rebase.integration.mjs`

**Resources：** 临时 Git repositories、真实 Root Broker/coordinator socket；不运行真实 LLM。

**接口契约：**
- awaited `agent_end` 触发 trusted lifecycle 查询与机械推进；`agent_settled` 只记录最终状态、恢复未送达的 durable intent，并不作为正常 enqueue/rebase/publish 入口。
- `prepare_auto_integration({})` 和 `inspect_auto_integration({})` 不接受 workspace/head/ref/lease 自报。
- `advance_auto_integration` 的 trusted binding（workspaceId/leaseId/runId/ownerScope）必须由 coordinator 侧 trusted connection registration 注入，不得从 wire input 读取；wire input 为空对象不等于 trusted binding 为空，runtime 扩展的 RPC 映射不得丢弃已注入的 trusted binding（架构审阅 2026-09-14 blocker）。
- admission 驱动责任：queued item 的 claim 由 child `awaitIntegrationAdmission()` 同步触发，`reconcileIntegrations()` 负责跨重启恢复且覆盖范围不得仅限 prepared；生产 Host 必须证明 enqueue 后 admission 必然发生（admissionGeneration 从 0 变为 1），该项为独立验收条款（架构审阅 2026-09-14 修订）。
- Auto Integration lifecycle 是唯一正常集成入口：auto generation 活跃时，legacy completion guard 不得并行 preserve 或 terminal 化；`session_shutdown` 只能查询 durable 状态并保持活跃集成存续，不得无条件 preserve；所有 preserve 必须携带真实原因分类，禁止固定标签（如 `integration-completion-guard-exhausted`）掩盖实际失败（架构审阅 2026-09-14 修订）。
- 生命周期执行：`prepare/enqueue → await admission → managed rebase → publish`。
- 无冲突时不发送 follow-up；真实冲突时保留 sequencer，最多两次有进展 continuation。每次 `agent_end` 只能产生一个 follow-up，使用持久 generation/conflict digest 去重；无进展、provider/broker/lease/target 错误进入 preserved/debt。
- 成功唯一条件：queue `completed`、有效 integration receipt、terminal proof 到达、workspace `released`。

**持久状态与转换：**

| 状态 | 进入条件 | 允许动作 | 退出条件 |
|---|---|---|---|
| `required` | managed workspace 已绑定 child | `prepare_auto_integration` | trusted workspace facts 已捕获 |
| `queued` | 幂等 enqueue 成功 | 等待 admission、Root close preserve | 获得唯一 admission 或 preserve |
| `admitted` | queue lease 与 targetHead 已签发 | child-side rebase | rebase 成功、冲突或 lease drift |
| `rebasing` | rebase 已开始 | 继续当前 Git 操作 | `prepared`、`resolving-conflict` 或 preserve |
| `resolving-conflict` | rebase 非零且存在 sequencer/unmerged | 最多两次有进展 follow-up | continue 成功并回到 `rebasing`，或 preserve |
| `prepared` | candidate clean 且身份/写路径复核通过 | coordinator publish | `completed` 或 preserve |
| `completed` | ff-only 与 integration receipt 已确认 | 等待 terminal proof | proof 后 workspace released |
| `preserved` | 无进展、异常、撤销或关闭 | root `recover/retry/discard` | 新 attempt `queued` 或显式处置终止 |

不变量：每个 generation 最多一个 follow-up；generation 单调递增；conflict digest 必须来自 sequencer/unmerged/HEAD 事实；`success` 必须同时具备 completed receipt、terminal proof 和 released workspace；重复事件与 late result不得跨 generation 变更状态。

**验收标准：**
- [x] clean committed child 自动完成 queue、admission、rebase、publish、proof、release（真实 Git E2E）。
- [x] 模型不需要调用 integration mutation tool；自动 generation 活跃时手工 mutation 拒绝或只读。
- [x] 真实冲突保留 sequencer/unmerged；模型只解决文件，lifecycle 执行 continue/publish。
- [x] duplicate settled、reload、late query、dispose、provider error 和 broker unavailable 均幂等、有界。
- [x] non-managed、generic、Goal acceptance child 不创建 Auto Integration record。
- [x] `PI_REAL_BIN=/opt/homebrew/bin/pi` runtime、typecheck、verify、diff check 通过且零 skip。
- [x] 真实 Pi `agent_end -> followUp -> agent_start` 顺序通过；`agent_settled` 不重复启动 integration run，handler 异常不会被误认为成功。

### Task 11：异常恢复、主 Agent 回收与通知

**Deps：** `T10`（理由：消费 Auto Integration 的 durable state 和 failure disposition）。

**WritePaths：**
- `packages/pi-subagents-enhanced/src/workspace/child-integration-lifecycle.ts`
- `packages/pi-subagents-enhanced/src/workspace/service.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`
- `packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts`
- `packages/pi-subagents-enhanced/src/workspace/administration.ts`
- `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts`
- `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`
- `packages/pi-subagents-enhanced/child-extensions/integration-queue.ts`
- `test/subagent-auto-integration-recovery.integration.mjs`
- `test/subagent-workspace-recovery-tool.test.mjs`
- `test/root-subagent-broker.test.mjs`
- `test/managed-workspace-terminal-proof-handoff.integration.mjs`

**Resources：** 临时 Git repositories、真实进程退出与重启；不运行真实 LLM。

**接口契约：**
- 主 agent 可观察并调用：`status`、`audit`、`preserve`、`recover`、`retry`、`discard`、`release`；所有处置继续走现有 owner scope/action token/terminal proof 门禁，并通过新增 `test/subagent-workspace-recovery-tool.test.mjs` 验证工具权限。
- coordinator 持久化 `recovery-intent.v1`，字段包含 queueItemId、workspaceId、ownerScope、runId、attempt、reason、requiredAction、generation 和 delivery state；不包含 token、私有路径或 session 正文。
- `recover` 只能由合法 root/admin authorization 调用，绑定原 workspace、queue item、owner scope 和新的 run/lease，不创建无关联新 workspace；`retry` 创建新 attempt，`discard/release` 不能跳过 proof/lease/action token 门禁。
- 无 proof、broker 断开、provider error、conflict budget exhausted、lease/target drift 均产生 durable preserved/debt 和 recovery notification；repository coordinator 在 root session 不在线时保留 intent。
- coordinator 将 recovery intent 投递给 Root Broker registry；Root Broker 在线时发送结构化 recovery event，离线时写 notification delivery debt，root 下次 attach 时 replay。通知是可丢失的 delivery surface；coordinator/workspace receipt 才是事实来源。

**验收标准：**
- [x] queued、admitted、rebasing、resolving-conflict、prepared、completed-awaiting-proof 各阶段 root close/restart 后均可恢复或保守 preserve（`real coordinator child exit and restart preserves all six recovery stages`：真实 spawn/SIGTERM/restart 子进程证据链）。
- [x] 主 agent 可发现并回收孤儿 workspace；不能越权处置其他 root 的 workspace（audit/status 发现 intent + foreign root 拒绝）。
- [x] recovery tool 的 `status/audit/preserve/recover/retry/discard/release` 权限矩阵、foreign root、旧 token、重复 action 和并发处置均有真实测试；Root A 退出后 Root B 只能观察或处理被授权的恢复意图（`recovery tool permission matrix rejects foreign roots, stale generations, duplicate actions, and permits one concurrent action`；被授权正向用例由 recover 的 root authorization 检查覆盖，代表性覆盖原则）。
- [x] broker/provider/lease/target 失败不无限 follow-up、不等待 supervisor、不误报成功（`provider, lease, and target failures preserve once without follow-up loops or false success`：preserve 恰好一次、0 follow-up、不误报 completed）。
- [x] recover/retry/discard/release 的 token、owner、proof 和 generation 检查通过（stale generation 拒绝 + release action-token/terminal-proof 门禁 + recover owner/root authorization；workspace 门禁由 service 聚焦测试覆盖）。
- [x] notification delivery debt、proof debt、cleanup debt 均可 audit/reconcile（durable delivery state 写入 queue ledger，`queue.audit` 返回 debt，broker attach replay E2E）。


**计划完成后：** 派发 reviewer 执行一次整体 review。

### Task 12：真实五 Child 冲突验收 Harness

**Deps：** `T10`（理由：验收必须使用 Auto Integration，而不是模型手工编排）；`T8`（理由：消费 public audit/admin receipt）。

**WritePaths：**
- `scripts/probes/repository-merge-queue-acceptance.ts`
- `test/repository-merge-queue-acceptance-probe.test.mjs`
- `test/fixtures/repository-merge-queue-acceptance/**`
- `README.md`
- `packages/pi-subagents-enhanced/README.md`

**Resources：** 两个 Pi `0.85.1` RPC Root、五个真实 `executor` coding child、临时 Git repository；仅最终运行使用真实 LLM。

**接口契约：**
- Root provider 只发完整 `dispatch-ir.v1` coding request；模型任务只包含 TDD、修改同一 pipeline 行、测试、commit 和冲突解决，不要求模型 enqueue/publish。
- test-only barrier 只由 trusted run/cwd/HEAD/PID 写 ready，不接受模型 identity；五个 child 同 base 后释放。
- probe 只消费 public dispatch receipts、coordinator audit、queue/workspace/proof receipts；不读内部 ledger/event，不伪造 projection。
- `ACCEPTANCE_OVERALL_TIMEOUT_MS` 必须同时控制 barrier、child settlement 和 public audit settlement。
- probe 必须记录 `agent_end`/follow-up/next `agent_start` 的结构化生命周期计数；不得用 `agent_settled` 触发自动集成作为成功证据。

**验收标准：**
- [x] harness 合同测试 GREEN 且零 skip：probe、fixture、trusted barrier、Git conflict evidence、public lifecycle counters 与统一超时门禁均已覆盖；本轮未运行真实 LLM。
- [x] 两个 Root 按 `3+2` 派发五个真实 executor child，五个不同 managed worktree 同 base。
- [x] 至少四个不同 child 产生真实 rebase 非零、unmerged entries、sequencer 和 conflict digest 证据。
- [x] 模型只解决冲突；Auto Integration 自动完成 enqueue/admission/rebase/continue/publish。
- [x] 五个 queue item 按 FIFO 完成，五次 ff-only，五个 terminal proof，五个 workspace released。
- [x] final fixture tests 通过；queue、debt、orphan、socket、process 全部清零。
- [x] 任一失败保留临时 repository/worktree/receipt，不 force cleanup，并输出首个偏离点。
- [x] 真实 LLM 运行前必须先通过非 LLM production wiring test：public child committed → enqueue → `agent_end` → admissionGeneration 从 0 变为 1 → rebase/publish 完成，全链确定性验证（架构审阅 2026-09-14 修订）。
- [x] probe 诊断必须区分中间失败类别：coordinator instance/PID、admission request 是否到达、queue claim 次数、`advance_auto_integration` trusted binding 解析结果，firstDeviation 细分为 no-daemon/binding-missing/not-subscribed/queue-not-head（架构审阅 2026-09-14 修订）。

### Task 13：最终回归与独立完成审阅

**Deps：** `T11`、`T12`（理由：必须在 Auto Integration 恢复和真实五 child 验收均 GREEN 后收尾）。

**WritePaths：**
- `docs/plans/2026-09-12-pi-0851-repository-merge-queue.md`
- `README.md`
- `packages/pi-subagents-enhanced/README.md`

**Resources：** 最终测试独占仓库测试资源；真实 acceptance 运行完成后才运行全量测试。

**验收标准：**
- [x] 运行全部计划聚焦测试、`npm run typecheck`、`npm run verify:subagents-enhanced`、`npm run doctor`。
- [x] 最后一轮只运行一次 `npm test` 全量测试（880 测 878 过；2 个既有债已分类归档：init-pi 引用 9/14 已删 external-llm-review、native supervisor 覆盖同名工具需 upstream 仲裁，见 `docs/bugs/2026-09-18-var-workspaces-legacy-record-cleanup.md` 附录）。
- [x] 检查无 staged 文件、无测试 worktree/socket/process 泄漏；失败现场按 disposition 规则保留（v1 遗留 record 经用户批准清理并归档；验收通过现场 tu6cnL/vt9Uj4 保留）。
- [ ] 向用户单独请求本次“计划完成后 reviewer”批准；批准后派发一次 reviewer 检查实际完成情况、计划偏差、跨进程状态机、五 child 证据和资源清理。
- [ ] 根据 reviewer 意见修复后，再向用户报告最终结果；reviewer 不替代测试证据。

**真实验收结果（2026-09-18，qoder-pool/GLM-5.3-0.6x）：**
- Single `1/1/0` ACCEPTED（`repository-merge-queue-acceptance-tu6cnL`）。
- Five `2/5/4` ACCEPTED（`repository-merge-queue-acceptance-vt9Uj4`）：7 次真实 resumed child 启动 + 7 次 resume 激活重绑、FIFO 链完整、五 proof observed、五 workspace released。
- 真实 LLM 场景暴露并 TDD 修复的生产缺陷（各附 bug 文档）：recovery descriptor 丢失 workflow child extensions（patch v2）、audit queue items 顺序不确定、过早入队固化 base 授权头、resolving-conflict 的 agent_end 不驱动 durable continue。
- 实现计划见 `docs/plans/2026-09-16-durable-fifo-resumed-child.md`（durable resume/续轮机制），blocker 决策见 `docs/decisions/2026-09-16-fifo-follower-liveness.md`。

## 计划自检

- [x] 规格覆盖：Pi `0.85.1`、`pi-subagents@0.62.0`、独立 repository coordinator、多 root subagent worktree、child rebase/publish、durable FIFO queue、真实五 subagent 冲突验收、处置与恢复均有对应任务。
- [x] 非目标覆盖：fingerprint、主 agent自动 worktree、跨 clone/跨机器、自动替模型解决语义冲突均明确排除；机械 rebase/continue/publish 与有限冲突 continuation 已纳入收尾范围。
- [x] 类型一致性：coordinator protocol、queue item、owner scope、queue lease、sealed candidate、terminal proof 与现有 workspace service 的命名和边界一致。
- [x] DAG 一致性：基础阶段 T3/T5 可并行；收尾阶段 T10/T12 可并行，T11 串行承接 T10，T13 等待 T11/T12。
- [x] WritePaths 检查：同一 Wave 无重叠写路径；共享 lifecycle/coordinator 文件只在明确依赖的串行任务中修改。
- [x] 占位扫描：文档未使用占位标记或未定义接口。
- [x] 测试治理：每项 production 行为先有正确 RED；全量测试只在 T9 末尾运行一次。

## 计划审阅记录

- [x] 已完成一次用户批准的独立计划前审阅。
- [x] 已修正 T6 依赖 T7 public child tool 的倒置：T6 只验收 internal server/service 合同，T7 才扩展 public lifecycle RED 并接入 Host。
- [x] 已定义 canonical checkout 的 `git merge --ff-only` 算法、执行前后 branch/index/worktree 检查与外部编辑残余边界。
- [x] 已定义 Root Broker challenge、root/child/admin/coordinator 权限矩阵、registration replay fencing 与同 UID 威胁边界。
- [x] 已区分 common-dir coordinator identity 与 main-worktree legacy storage partition，旧 linked-worktree/state-root 分歧只形成 migration debt。
- [x] 已将真实 production provenance 与首段 RED 放到 service/registry 修改之前。
- [x] 已规定 queue 只拥有调度状态，workspace ledger 独占 disposition/cleanup 状态和 crash recovery receipt。
- [x] 已分离 daemon claim、child admission lease 与 workspace lease，并规定 publish 后立即释放队首。
- [x] 已定义 Root Broker terminal proof outbox、幂等 replay 和 proof debt。
- [x] 已为五个真实 child 增加同 base barrier、关闭 rerere、unmerged entries/sequencer 冲突证据与失败现场保留。
- [x] 已保留现有 `./workspace`、`./workspace/admin` 两个 public export，不新增第三入口。
- [x] 已补充 Pi runtime helper/probe resolver、daemon idle shutdown、doctor test 创建属性与临时仓库 commit 授权。
- [x] T9 只执行 probe TDD、运行文档和验收；生产接线失败必须回派 T6/T7，不在最终任务隐式修改。
- [x] 执行期确认 `pi-subagents@0.62.0` 没有 pre-spawn callback；保持禁止新增 upstream patch。rootSessionId/runId 环境变量仅作为私有 grant locator，真实 model tool call 合并到 T9 五子代理验收。
- [x] Astra reviewer 复审完成：其提出的 T10 时序、T11 recovery intent/tool、T12 barrier/conflict 证据和 T13 精确回归要求已纳入本收尾阶段；Astra route 的首选模型因权限 403，实际由 `openai-codex/gpt-6-astra` fallback 完成复审。

## 执行交接

计划执行方式由用户在计划审阅完成后选择：

- **Subagent-Driven：**主 agent 按 DAG、Deps、WritePaths 和 Resources 编排当前宿主的 subagent。
- **Inline：**主 agent 在当前会话按拓扑顺序串行执行。

在既定 Goal Runtime R13 验收和 fresh Host 前，不使用 Goal Engine 执行本计划。
