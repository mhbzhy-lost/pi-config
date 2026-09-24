# managed workspace 生命周期与 git merge queue 源码归因报告

> 取证范围：只读源码、只读现场 ledger/queue/worktree、错误样本与运行日志。未执行任何 `git worktree remove/prune/repair/lock/unlock/add`、`reset/clean/checkout/stash`，未调用 dispose/release 工具，未运行验收 probe。现场保留原状。

## 1. 摘要与结论

**一句话根因：**生命周期把“可处置的 workspace 状态/动作”与“Git 回收失败后的 cleanup debt”拆开了，但 agent-callable 面只允许 active 状态通过 `status` 刷新 disposition token，preserved/debt 的 release 又依赖隐藏的 legacy/recovery 语义；同时 Git 失败只透传固定短消息并丢弃 stderr，且无法续做既有 state-root worktree，最终把真实现场推入人工债务。

**死结判定：存在 agent 不可逃逸死结，但不是“preserve 后 release token 永远拿不到”这一简化链条。** `active -> dispose(preserve) -> preserved` 后 public `status` 被 service 拒绝（`statusForLease` 只接受 active），所以不能再用 status 刷新 disposition token；不过 `releaseForLease` 对已消费的 preserve challenge 走 `legacyRelease`（`service.ts:591-600`），因此 bound workspace 在 preserve 后仍可直接调用 public `release`，现场也确实进入了 release。真正的死结是：release 的 Git remove 失败后 state 进入 `cleanup-debt`，没有 force-release/cleanup-debt recovery 的 agent tool，且普通 release 重试仍执行同一失败 Git 命令；重新 dispatch 到既有 worktree 又被 `execution-contract.ts:154-163` 的 state-root cwd preflight 拒绝（现场日志 `SUBAGENT_RPC_FAILED`）。源码虽有 admin `plan/apply cleanup` 与 service `reconcile`，它们不是 `subagent_worktree` agent 面。因此 agent 无法从“Git 回收持续失败 + 无受信续做/恢复能力”循环自行退出。

**本次 merge queue 实效：未形成一次 terminal proof。** 64 个 child 中只有 5 个 cwd 在 managed worktree；queue 现场只有 1 个 item，仍为 `queued`，`admissionGeneration:0`，无 `queueLeaseId/candidateHead/integrationReceipt/completedAt`。因此本次实践没有可证明的 enqueue -> claim/admission -> rebase -> publish/fast-forward -> terminal proof 闭环；queue 断点在 admission 之前。已有源码/缺陷文档同时证明过早 enqueue 固化 base head、child completion 与 enqueue 断开、以及 broker drain 断开均可造成同类停滞。

## 2. 权威来源与现场范围

- 唯一 workspace service：`packages/pi-subagents-enhanced/src/workspace/service.ts`。
- Git mutation：`packages/pi-subagents-enhanced/src/workspace/git-worktree.ts`。
- durable record 状态集合：`packages/pi-subagents-enhanced/src/workspace/ledger.ts:31`。
- agent 工具 schema/分派：`packages/pi-subagents-enhanced/src/workspace/tool.ts:1-92`。
- durable FIFO queue：`packages/pi-subagents-enhanced/src/workspace/integration-queue.ts`。
- 现场 ledger：`var/workspaces/repositories/85369acc.../records/*.json`（5 条）。
- 现场 queue：`.../integration-queue/queue-index.json` 只有 `0ed45c9b-...json`；`queue-meta.json` 为 `{ "nextSequence": 2 }`。
- 现场 coordinator metadata：`/Users/leshi.zhy/new-api-account-pool/.git/.pi-coordinator/coordinator.json`，协议 `repository-workspace-coordinator.v1`，repositoryId `57e63c...`，storageRepositoryId `85369acc...`，canonicalStateRoot `/Users/leshi.zhy/pi-config/var/workspaces`。

主 agent 的独立现场统计也纳入本报告：64 个 child cwd 分布为 51 个仓库根、8 个直接 submodule、5 个 managed worktree；因此只有这 5 个 child 属于本次 managed lifecycle 样本。`subagent_worktree` toolResult 计数为 Git 5、STATE 3、ACTION 1、NOT_FOUND 1，JSON 成功 19；处置失败率 10/29=34.5%。

## 3. 完整状态机

### 3.1 ledger 状态集合

`ledger.ts:31` 的合法集合是：`reserved / allocating / active / disposing / preserved / released / cleanup-debt`。不存在源码声明的 `awaiting-disposition`、`integrated`、`discarded` ledger 状态；这些是语义/queue 状态，不是 workspace record state。`integrated` 的持久化证据是 `integrationReceipt` 字段，而不是 state 名称；queue 另有 `queued/admitted/rebasing/resolving-conflict/prepared/completed/blocked/preserved/cancelled`（`coordinator-protocol.ts:25`、`integration-queue.ts`）。

### 3.2 状态转换表

| 当前状态 | 触发入口 | 前置条件/校验 | token/proof | 下一状态 |
|---|---|---|---|---|
| 无记录 | `reserve` / `ensureAllocated` | request v2、owner、origin/base/policy 合法；ledger 记录不存在 | 无 action token；内部 owner token/lease | `reserved` |
| `reserved` | `ensureAllocated` | Git origin exact base、worktree identity 预检 | 无 | `allocating`，随后 Git add 成功为 `active` |
| `allocating` | `ensureAllocated`/`reconcile` | `ensureManagedGitWorkspace` 成功 | 无 | `active`；失败仅 identity 分支尝试 `cleanup-debt` |
| `active` | `bindRun` | run 未绑定或幂等相同 | 无 | `active`（绑定记录改变） |
| `active` | `recordTerminalProof` | proof identity 匹配 run/root | proof 可为 observed | `active` |
| `active` | `status` | **仅 active**；Git inspection；proof 解析 | 无；返回新的 snapshotHash；active status tool 随后自动 issue disposition token | `active` |
| `active` | `issueDisposition`（由 tool status 内部调用） | status 成功；记录 actionChallenge | 产生 action token，绑定 snapshotHash、proofId、allowed actions | `active` |
| `active` | `dispose(preserve)` | action token 未消费、token hash/snapshot/proof 匹配，disposition allowed | **需要 action token**；proof hash 必须匹配 challenge | 先 `disposing`，随后 `preserved` |
| `active` | `dispose(discard)` | 同上；Git inspect/remove 成功 | 需要 token/proof | `disposing` -> `released`；Git 失败 -> `cleanup-debt` |
| `active` | `dispose(integrate)` | publication allowed 时直接拒绝，child queue 拥有 integration | 需要 token；但 production auto integration 不走此动作 | 通常拒绝；非 child-owned 路径可进入 `disposing` |
| `disposing` | `dispose` 重放 / `reconcile` | pendingAction 存在；token 必须拥有 pending disposition | pending token | preserve -> `preserved`；Git remove 成功 -> `released`；失败 -> `cleanup-debt` |
| `preserved` | `issueRelease` | state preserved；bound run 还需 observed proof | **产生 release token**；token challenge snapshotHash=null | `preserved` |
| `preserved` | `release` | 正常 recovery 路径需 release token/proof；public tool 依赖已消费 preserve challenge 的 legacyRelease 例外；Git remove 成功 | recovery 需 token + bound run observed proof；legacy bound-preserve 可不传 | `released`；Git 失败 -> `cleanup-debt` |
| `cleanup-debt` | `recordTerminalProof` | observed authoritative proof | 无 public tool 入口；service internal/coord path | `active`，清除 debt |
| `cleanup-debt` | `issueRelease`/`release` | issueRelease 要 observed proof；release token/proof；Git remove 成功 | 需要 token/proof（但 tool 未暴露 token 参数） | `released`；再次失败仍 `cleanup-debt` |
| 任意 active/preserved/disposing/debt | `reconcile` | admin/service 内部可读 ledger；Git identity 检查 | 非 agent tool；admin authorization 另有 lease plan | 可能恢复 allocating/disposing；失败标 debt |
| `released` | 任意 allocate/dispose/release | closed；allocate 明确拒绝 released | 无 | 终态（不可再 allocate） |

证据：active status 门禁及 allowed actions 在 `service.ts:385-401`；issue token 在 `service.ts:404-412`；dispose token/snapshot 校验和 `disposing` 写入在 `service.ts:527-564`；release 前置和错误文本在 `service.ts:575-603`；release Git failure -> debt 在 `service.ts:604-618`；reconcile 分支在 `service.ts:640-664`。

### 3.3 ASCII 图

```text
                  reserve
                    |
                 reserved --ensureAllocated--> allocating
                                                   |
                                      Git add ok  v
                                                 active
                                                   |
          +----------------------+-----------------+--------------------+
          |                      |                                      |
     status (only active)   issueDisposition                     queue/child auto lifecycle
          |                      |                                      |
          +--> snapshot + token -+                                      |
                    |                                                 |
        +-----------+-----------+                                      |
        |           |           |                                      |
     preserve     discard     integrate                              enqueue
        |           |           |                                      v
   disposing   disposing   child-owned reject                  queued -> admitted
        |           |                                                  |
        v           |                                          rebasing/conflict
    preserved      |                                                  |
        |           |                                          prepared -> completed
        |           |                                                  |
 issueRelease     Git remove                                      integrationReceipt
        |           |                                                  |
        +------> release <----+                                      |
                   |                                            workspace disposition
          Git ok   v                                            / terminal proof
                released <---------------------------------------------+

 Git remove failure from discard/dispose/release/reconcile:
                         +--> cleanup-debt
                               |\
                 observed proof| \ admin reconcile/cleanup plan (not agent tool)
                               |  \
                             active  -> release attempt -> released or debt

 preserve 后 status 不可用：preserved --X--> status/token refresh
 cleanup-debt 也无 agent-visible repair/force edge
```

## 4. 死结证明

### 4.1 `preserve -> status unavailable`

`service.ts:385-387` 对所有非 active 状态直接抛出 `MANAGED_WORKSPACE_STATE: workspace status is unavailable in ${state}`。现场 `/tmp/wt-analysis/errors-only.txt:50-52` 和 `:99-101` 分别复现 preserved 的 status 失败。agent tool `tool.ts:71-73` 只有 status 成功时才会自动调用 `issueOwnedDisposition`；preserved status 根本不会返回 action token。

### 4.2 token 是一次性、快照绑定且无 TTL

snapshot hash 在 `git-worktree.ts:440-453` 覆盖：`headCommit/baseCommit/descendant/aheadCommits/changedFiles/clean/originRef/originHead/originClean/terminalProof`。disposition challenge 还保存 `proofHash`、allowed actions、used（`service.ts:480-493`）。消费时要求 token hash、未 used、snapshotHash、proofId 全部相等（`service.ts:540-546`），否则是现场错误 `MANAGED_WORKSPACE_ACTION`。源码没有 expiresAt/clock/TTL 字段；因此 token 不是时间过期，而是使用、proof 变化或 Git snapshot 改变后失效。唯一刷新路径是对 **active** workspace 再调用 status/issueDisposition（`service.ts:385-412,480-502`）。

### 4.3 release 在失败后如何进入 debt

`releaseForLease` 只接受 preserved 或 cleanup-debt，错误文本明确为 “only a preserved or cleanup-debt workspace can be released”（`service.ts:586-588`）。需要区分两条路径：`issueRelease` 正常发行 release challenge 时要求 bound run 有 observed proof（`service.ts:575-581`）；但 public tool 的 `release` 不传 token/proof，若 preserve challenge 已消费，`legacyRelease` 条件 `challenge?.used === true` 成立（`service.ts:591-600`），所以 preserve 后 release **并非必然因缺 token 失败**。Git 删除异常进入 catch，并调用 `markDebt` 把 state 写成 cleanup-debt、保存 phase/code/message（`service.ts:604-617`、`174-178`）。因此现场 5 条记录均为 cleanup-debt，记录 message 也确实只剩笼统 `git worktree remove ... failed`。

### 4.4 NOT_FOUND、owner-kind 与 live-root-session 门禁

现场请求的 `3d9e19a2-f88e-4678-b384-c607d301e16c` 不在本 repository partition 的 5 个 `records/*.json` 中；日志只证明 agent 在 `runtime-calls.txt` 发起过该 ID，不能证明它来自另一 owner、另一 session 或 Goal workspace。`ledger.locate` 会在所有 repository partitions 搜索：零匹配抛 `MANAGED_WORKSPACE_NOT_FOUND`，多匹配抛 `MANAGED_WORKSPACE_CONFLICT`（`ledger.ts:412-426`）；若记录存在但 owner kind/rootSession 不匹配，service 的 `loadOwned` 会抛 `MANAGED_WORKSPACE_OWNER_SCOPE`（`service.ts` 的 `loadOwned` owner 门禁，约 146-153 行）。因此这次 NOT_FOUND 是可区分的“无记录”而非权限不足；来源无法从现场确证，不能称为 agent 幻觉以外的事实。

### 4.5 agent 是否有出口

对“preserved -> release”这一边，**有一个无 token 的 legacy 出口**；对“Git remove 持续失败后的 cleanup-debt”，没有 force/recovery 出口。public schema：

- status 只有 `action/workspace_id`，且 preserved/debt 被 service 拒绝（`tool.ts:5-8,71-73`）；
- dispose schema 必须有 `action_token`（`tool.ts:9-21`），而 preserved 后不能刷新 token；
- release schema没有 `action_token`、terminalProof 或 force 字段（`tool.ts:22-25`），execute 只调用 `releaseOwned({workspaceId,ownerScope})`（`tool.ts:82-83`）；这依赖 service 的 legacyRelease 例外，不能用于显式诊断/强制回收；
- Git release 没有 `--force`，`git-worktree.ts:419-438` 固定执行 `git worktree remove record.path`；源码无 force 等价能力；cleanup-debt 重试仍重复该路径；
- `reconcile` 虽公开于 service，但不在 `subagent_worktree` tool action union 中；admin `planManagedWorkspaceCleanup/applyManagedWorkspaceCleanup` 在 `administration.ts:198-245`，要求显式 authorization，属于人类/宿主管理面；
- 现场尝试把 child 重新派回 worktree 失败：根日志 L680 的 `SUBAGENT_RPC_FAILED` 原因为 `dispatch request cwd cannot be inside the managed state root`，源码抛点为 `src/subagent-dispatch/execution-contract.ts:154-163`，由 `extension.ts:1319-1331` 兜底成 RPC/spawn 错误。因此保留现场后也没有合法 child continuation 路径。

所以用户提出的链条不是理论死结，而是 agent-visible 状态机的不可逃逸死结；只有 admin/recovery 人工面或直接现场处置可打破。

## 5. `git worktree remove failed` 真因与信息丢失

### 5.1 代码抛点及 stderr 丢失

`git-worktree.ts:44-49` 和 `52-57` 用 `execFileSync(... stdio:[ignore,pipe,pipe])`，catch 只构造 `MANAGED_WORKSPACE_GIT` 与 `git ${args.join(" ")} failed`，没有从 `cause.stderr` 提取 stderr；`git-worktree.ts:419-429` 的 release 正是调用该 wrapper。因此 runtime **设计上**丢弃 Git 原因，不是 tool renderer 截断。service 的 cleanupDebt 只保存该短 message（`service.ts:174-178`）。同样的笼统文本在 `errors-only.txt:82-125` 五次现场输出中可见。

### 5.2 逐 workspace 现场证据

| workspace | ledger state/debt | 只读现场 | 能确定的失败因素 | 结论等级 |
|---|---|---|---|---|
| `c161c5e9-80f8-44ae-aef4-b1ed1081fb6d` | cleanup-debt，phase=release，`MANAGED_WORKSPACE_GIT` | `git -C worktree status --porcelain` 显示 ` M sub2api`；父仓 gitlink 改变，但本次 `git -C worktree/sub2api status --porcelain` 未输出；registration 仍在；无发现 `*.lock`；无该 worktree 驻留进程 | 父仓 gitlink/submodule dirty 与普通 remove 拒绝条件一致，是最强候选；但因 stderr 被丢弃，不能声称 Git 原因已被绝对证明 | **候选高置信，精确原因未证实** |
| `5c1844c9-9243-49fa-baf3-8eb18b010a79` | cleanup-debt，phase=release | 父 worktree ` M sub2api`；gitlink 从 `5feca724...` 到 `87bb590...`；根还有 `?? docs/reports/2026-09-20-v0.2.7-qoder-rebuild-log.md`；无 `*.lock` | dirty gitlink 与 untracked report 都与普通 remove 拒绝条件一致；不是进程占用证据 | **候选高置信，精确原因未证实** |
| `6686ea46-eb9a-4719-bdb1-65b701422a64` | cleanup-debt，phase=release | 父/submodule `status --porcelain` 均无输出；registration 正常；`.pi` 目录可见；无 lock、无驻留进程 | 现场不能证明 dirty/submodule/process/lock/path 缺失；`.pi` 可能是 runtime residue，但 release 前会尝试清理若干 metadata 根，且其是否在失败时被重建无法仅凭快照判断 | **未证实；必须保留未知** |
| `3b8d0a57-8d00-44f5-a186-ebf0adc53350` | cleanup-debt，phase=release | tracked status 无输出，但 `status --ignored --untracked-files=all` 显示 `!! .pi/subagents/artifacts/...meta.json`、`...output.md`；无 lock、无驻留进程；registration 仍在 | ignored runtime artifacts 与普通 remove 拒绝条件一致，是强候选；但 `removeUntrackedRuntimeMetadata` 会在 Git remove 前尝试删 metadata，且失败后可能被恢复/重建，故仍不能还原唯一 Git 原因 | **候选高置信，精确原因未证实** |
| `01a2da1b-2e6d-4951-914d-4db3186e72d4`（对照） | active，不在 release 失败五条中 | submodule 有 4 个 untracked 文件；`sub2api/.git/index.lock` 存在；已知 pid 77416 pi 驻留 cwd；这不是五次失败记录之一 | 说明同类现场确实存在 lock/process 放大器，但不能倒推为上述五条失败原因 | **对照证据，不归因到失败** |

补充：Git worktree remove 本身通常会拒绝 dirty/未跟踪工作树而不使用 force；本 runtime 固定未带 `--force`。由于禁止执行 destructive command，不能用现场重放验证具体 Git stderr，且源码已经明确把 stderr 丢失，故 6686 的根因只能列为未证实。

### 5.3 不是 locked/path/process 的证据

五条失败 workspace 的 registration 仍存在且 `git worktree list` 可列；只读 `find` 未发现其 `.lock`。除对照 workspace `01a2...` 外，`ps` 未发现进程 cwd 驻留失败 workspace。故不能把 locked、path missing、process cwd 当作五条失败的共同原因。`registrationFor`/`inspectIdentity` 会先检查 registration、locked/prunable（`git-worktree.ts:132-167`），但现场错误发生在实际 remove wrapper，说明 registration 并未给 agent 可见 blocked reason。

## 6. merge queue 实效判定

### 6.1 持久文件实际内容

`queue-index.json` 只有 `0ed45c9b-ec5f-4579-b509-e0bb944a436b.json`；`queue-meta.json` 为 nextSequence=2。该 item 实际为：

- workspace `3b8d0a57...`，childRun `74f0fb42...`，target `refs/heads/main`；
- `authorizedWorkspaceHead=a7526c469...`；
- `autoManaged=true`；
- `admissionGeneration=0`、`revision=3`、`state=queued`；
- 没有 `queueLeaseId`、`admittedTargetHead`、`candidateHead`、`integrationIntentId`、`workspaceDispositionReceiptId`、`completedAt`。

四份 resume 文件都指向该 item，状态为三份 `failed`、一份 `starting`；`resume-55...` 的 delivery 为 `debt`，reason 是 `run can bind only to an active workspace`。这与 workspace ledger `3b8d... state=cleanup-debt` 相互印证：resume 试图继续，但 workspace 已非 active。

terminal proof outbox 有该 5 条 workspace 的 observed proof，但没有 completed queue integration proof；其 `debts` 大量为 `trusted run binding is unavailable`，说明 proof delivery/绑定也曾产生 durable debt。

### 6.2 源码闭环所需边

`integration-queue.ts:221-230` enqueue 只产生 queued；`claimNext` 在 `:235-242` 只有 coordinator worker claim 后才写 admitted、queue lease、admission generation；`prepareCandidate` 在 `:275-284` 才写 prepared/candidateHead；`completePrepared` 在 `:288-299` 才写 completed/integration receipt；Git rebase/publish 分别由 `git-worktree.ts:371-407` 与 `:520-545` 执行。现场没有任何后续字段，故至少未发生 durable claim/admission，更没有可证明 rebase/publish/terminal settlement。

### 6.3 断点归因

本次具体断点在 queued -> admitted 之前；不能仅凭 queue 文件区分是 coordinator 未启动、claim admission 失败、child 过早退出、broker disconnect 或 lifecycle 未调用。现有证据支持以下生产级断开：

1. `docs/bugs/2026-09-13-real-runtime-enqueue-disconnect.md`：Root Broker close 时请求尚未进入 integrationRequests，transport 结束导致 `BROKER_DISCONNECTED`，enqueue durable record 可能不存在或不完整。
2. `docs/bugs/2026-09-17-premature-enqueue-freezes-base-authorized-head.md`：首次纯文本 turn 的 agent_end 以 base HEAD 入队，后续 child commit 不刷新授权头会永远卡 admission；当前 coordinator 已有 `prepareAutoIntegration` 后续 descendant refresh（`coordinator-server.ts:167-185`），但现场该 item generation=0 且无 admission，不能声称修复在本样本中生效。
3. `docs/bugs/2026-09-12-subagent-worktree-lifecycle-broken.md`：真实 child completion 可以发生但 queue absent/active orphan；completion guard 必须查询 queue/workspace terminal，而不是把模型文本当成功。

因此本次不能宣称 Auto Integration 真正串行 rebase+publish；5 个 managed child 全部最终 release failure，queue 仅保留一项 queued，实效为 **0/5 terminal integration**。

## 7. 信息丢失审计

| 错误/现象 | runtime 内部已知但 agent 未获知 | 代码证据 | 影响 |
|---|---|---|---|
| `MANAGED_WORKSPACE_GIT ... failed` | child process 的 stderr、exit status、Git 是否 dirty/untracked/locked/submodule | `git-worktree.ts:44-49,419-429` | 无法决定是等待进程、保存文件、处理 submodule 还是请求 force |
| status unavailable in preserved/debt | 当前 state 之外的合法 actions、现有 `actionChallenge` 是否 used、release token 发行路径 | `service.ts:385-387`; `tool.ts:71-73` | preserved 后无法自助刷新 token |
| stale/replayed/snapshot mismatch | 实际比较失败的 token/snapshot/proof 字段、当前 snapshotHash、刷新方式 | `service.ts:540-546` | agent 只能盲目重试；重试不能生成 token |
| release only preserved/debt | active 正确出口应先 status->dispose(preserve/discard)；debt 要 admin recovery；force 不存在 | `service.ts:527-588` | 错误只说前置集合，不说处置流程 |
| release Git failure -> cleanup-debt | cleanupDebt phase/code/message 已持久化，但未返回 allowed recovery action/admin plan | `service.ts:604-617`; `administration.ts:198-245` | agent 看到一条短错，无法知道 `reconcile`/plan 不是其 tool 面 |
| NOT_FOUND | ledger locate 搜索所有 repository partitions、owner scope/live root 门禁的区别 | `ledger.ts` locate；`service.ts:118-127` | 幻觉 ID、另一 partition、权限拒绝无法从 agent message 区分 |
| queue queued/blocked | queue sequence、daemon claim、生存状态、admission failure reason、candidate/conflict digest | `integration-queue.ts:235-242`; coordinator inspect allowlist | child 无 queue inspect agent tool，只能依赖 integration tool/通知 |
| resume starting/debt | resume intent generation、delivery attempts、workspace active prerequisite | `integration-queue.ts:123-210` | resume 继续失败时只表现为 binding/state 错误 |
| auto integration inspect | 设计上 child 可见面已裁剪 path/branch/head，符合 `2026-09-13-auto-integration-inspect-information-leak.md`；但也丢失了足以自助诊断的原因 | `coordinator-server.ts:... inspectAutoIntegration` | “防泄漏”过度收敛为无法排障；应暴露分类 reason/digest，不暴露路径/提交身份 |

源码把 Git `cause` 挂到 Error 的 `cause` 字段，但 public tool catch 只将 `error.message` 放入文本、只把 `code/detail/keypath` 放入 details（`tool.ts:87-88`）；因此即使上层拥有 cause，也没有 child-visible stderr。

## 8. submodule 场景适配性

目标仓库 `.gitmodules` 含 `sub2api`。managed request 的 policy/writePaths 是 repo-relative（`contract.ts:87-99`），没有 submodule-aware 类型；`assertManagedWorkspaceWritePaths` 只匹配 `git diff` 输出路径（`git-worktree.ts:193-195`）。父仓库的 submodule 改动表现为单个 gitlink 路径 `sub2api`，所以 `sub2api/**` policy **可能允许父仓库 gitlink 变更**，但不会递归核验 submodule 内部 dirty、commit 是否发布、或 submodule branch/HEAD 与父 gitlink 是否匹配。

worktree 创建只执行父仓库 `git worktree add`（`git-worktree.ts:198-218`），没有显式 `git submodule update/init`；因此子模块初始化/独立工作树内容依赖父仓库/Git 环境。merge admission/rebase/publish 使用父仓库 status/diff/merge/ff-only（`git-worktree.ts:221-250,371-407,520-545`），没有 submodule recursion。现场正好出现 ` M sub2api`、gitlink 从 `5feca724...` 变到 `87bb590...`、以及 submodule 内 untracked 文件；这不是“Git worktree remove 忽略 submodule”的安全适配，而是隐藏放大器：父 worktree clean contract 与子模块真实 clean contract 不一致，remove 和 integration 都可能被阻断。

结论：submodule 是本次失败的重要放大器，至少应在 admission/release 处把 submodule 状态作为显式分类（gitlink changed、nested dirty、nested uninitialized），否则 agent 仍只能看到笼统 Git failed。当前源码没有 `--recurse-submodules`、子模块 identity/clean 校验或跨 submodule writePaths 语义。

## 9. agent 可调用面缺口（按优先级）

| 等级 | 现象 -> 源码位置 | 缺口类型 | 建议方向 |
|---|---|---|---|
| blocker | preserved/debt status 直接 unavailable；release token 只能 service/admin 发行；tool release 不接 token/proof（`service.ts:575-603`; `tool.ts:22-25,82-83`） | 状态机死结/能力缺失 | 增加 agent-visible `recover/release-authorize`，或允许 preserved/debt 的只读 admin status + 安全 release authorization；明确 proof/token 合同 |
| blocker | release 固定无 force；Git failure -> debt，重复 release 仍失败 | 能力缺失 | 提供显式、授权、带审计的 force release/recovery（不得隐式删除用户内容）；至少返回 blocked reason 与安全下一步 |
| blocker | 既有 worktree cwd 被 `execution-contract.ts:154-163` 拒，无法续做 | continuation 能力缺失 | 建立“resume existing managed workspace”专用 trusted dispatch contract，不把它当普通 cwd；保留 owner/run/lease 门禁 |
| high | stderr/exit reason 被 `git-worktree.ts:44-49` 丢弃 | 信息缺失 | 将 stderr 分类为 dirty/untracked/submodule/locked/path/process，截断并脱敏后放 details；保留 raw Git 不泄漏路径策略 |
| high | no queue inspect action in `subagent_worktree`; child integration inspect 只最小状态 | 信息/能力缺失 | 增加 root/agent scoped queue status，暴露 state/sequence/admission generation/blocked reason/conflict digest，不暴露 path/head |
| high | queue item queued、resume starting/debt 没有主 agent 处置提示 | reminder/恢复缺口 | completion guard 每次 child completion 查询 queue；对 queued/debt 发 durable reminder/recovery intent，并允许有限 continuation |
| high | reminder 只在 `subagent:async-complete`、同 lifecycleSessionId、runId 唯一匹配，且只匹配 active/preserved（`completion-reminder.ts:25-45`） | 触发遗漏 | 监听 durable completion/debt/recovery 事件；覆盖 cleanup-debt、queue queued/preserved；delivery debt 应可查询 |
| high | 仅 3 次 reminder 对应 5 managed workspace，且大量 child 是 root/submodule cwd | 观测/接线缺口 | 启动时扫描 owned records/queue，不只依赖 async-complete；对 active orphan 与 debt 补一次幂等通知 |
| medium | `MANAGED_WORKSPACE_STATE` 未列 allowed actions/合法前置 | 信息缺失 | 错误 details 增加安全 `state`, `allowedActions`, `nextAction` |
| medium | submodule gitlink/nested dirty 无分类 | 能力缺失 | admission/release 递归或明确拒绝策略；返回 `submodule-dirty`/`gitlink-drift` |
| medium | 64 child 只有 5 managed；其余 59 直接写 root/submodule | 接线/策略缺口 | dispatch 时强制 coding child 的 worktree contract，或明确 worktree=false 不纳入 queue；统计应进入 completion gate |
| medium | raw bash 26 次中多次被用于长测试/收敛，现场也出现手工清理诱因 | 工具面/制度冲突 | 给 agent 正规 doctor/reconcile 入口；禁止 raw mutation 继续保持，但提供可审计回收路径 |

## 10. raw git 违规与合规遗留建议

### 10.1 是否被迫 raw git

日志统计有 `bash`×26，且 workspace tool 处置失败后现场仍有 dirty submodule、untracked/ignored artifacts 和 active process。仓库规则禁止 raw `git worktree` mutation；在 release 失败且 agent 无 force/reconcile/recovery action 的前提下，agent 面临“违规手工回收”或“永久垃圾 worktree”的制度性两难。根日志 L689 的 `clean-root-worktree` dispatch 不能解决该问题：它的 `writePaths` 为 `docs/plans/**、docs/bugs/**、docs/reports/**、sub2api`，没有 managed state/worktree 路径，且同样受 raw mutation 禁令约束；即使派发成功，child 也无合规权限完成回收。根日志中另有把 child 派到既有 worktree 的尝试在 L680 被 state-root cwd preflight 拒绝。因此这不是单纯 agent 不听规则，而是 capability gap。

### 10.2 只给人类执行的合规命令文本（本报告未执行）

以下命令仅用于 owner/admin 在确认 child 已终止、保存/审核未提交内容后执行；不应由普通 coding agent 执行。先只读取证：

```bash
cd /Users/leshi.zhy/new-api-account-pool
for wt in \
  /Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/worktrees/c161c5e9-80f8-44ae-aef4-b1ed1081fb6d \
  /Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/worktrees/5c1844c9-9243-49fa-baf3-8eb18b010a79 \
  /Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/worktrees/6686ea46-eb9a-4719-bdb1-65b701422a64 \
  /Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/worktrees/3b8d0a57-8d00-44f5-a186-ebf0adc53350; do
  git -C "$wt" status --short --ignored
  git -C "$wt/sub2api" status --short --ignored
  git -C "$wt" log --oneline -3
  git -C "$wt" worktree list --porcelain
 done
```

在 owner 明确授权保留/导出未提交内容、确认无进程 cwd 和无 index lock 后，优先走本 package 的 admin plan/reconcile API（`administration.ts:198-245`），而不是 raw mutation。若 admin 工具明确显示必须人工强制回收，命令文本如下（**不要在本诊断中执行**）：

```bash
# 仅在人类确认不再需要未提交/未跟踪内容后，显式 force 回收指定 worktree
cd /Users/leshi.zhy/new-api-account-pool
git worktree remove --force /Users/leshi.zhy/pi-config/var/workspaces/repositories/85369acc70d48e2c3306d347b7551497835d492bebeaf72ba0441104aa8fb5f0/worktrees/<workspace-id>
# 仅在 remove 成功且 registration 已消失后，由管理员按 ledger/reconcile 流程清理 branch/记录
```

本命令只是合规遗留处置建议文本，runtime 当前没有把它实现为 agent capability；`--force` 会丢弃未提交和未跟踪内容，必须有人工确认与审计。

## 11. 最小修复方向（不在本任务实施）

1. Git wrapper 从 `cause.stderr` 提取 bounded、脱敏、分类原因；错误 details 同时给 `phase/state/nextAction`。
2. 建立 agent-visible `workspace doctor/recover`：读 preserved/debt、签发 release authorization、提交 terminal proof、生成 admin plan；不向 child 暴露私有 path/head。
3. 为 managed state-root worktree 增加受信 resume dispatch contract，允许同 owner/lease continuation，禁止普通 cwd 绕过门禁。
4. 将 queue status/recovery intent 纳入 root tool；queued/admitted/debt/blocked 必须有明确通知和 bounded retry。
5. 对 submodule 采取明确政策：递归初始化/clean 检查，父 gitlink 与子 commit 绑定，writePaths 不能把 `sub2api/**` 当成普通目录模式静默放行。
6. 保留 `auto integration` 的安全字段裁剪（不恢复 path/branch/head 泄漏），但向 authorized root 提供分类 blocked reason、conflict digest、admission generation。

## 12. 证据与残余限制

- 已执行只读 `nl/sed/grep/cat/ls/find/git status/log/worktree list/submodule status/ps`；未执行 destructive Git 或 lifecycle action。
- Git stderr 已在 runtime wrapper 丢失，故除现场 dirty/untracked/lock/process 证据外，不能还原每一次 Git 命令的原始错误字符串；特别是 `6686ea46...` 的精确阻断原因必须标为未证实。
- `terminal-proof-outbox/terminal-proofs.json` 内容包含大量历史 proof debt；本报告仅引用状态/原因，不把它当作 integration terminal proof。
- queue 未完成并不单独证明 coordinator 未启动；它证明本次没有 durable admission/rebase/publish/terminal completion。具体首个 transport 断点需未来在隔离 fixture 或新增可观测字段中验证。
