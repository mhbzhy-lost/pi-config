# Goal Runtime v2：多仓库超级工作区实施计划

> **For agentic workers:** 用户选择执行方式前不得实施。执行时严格遵循本计划的串行 DAG、WritePaths、验收与停止条件。Subagent-Driven 模式下由主会话派发完整合同并验收；真实 smoke 只能沿用已授权模型、预算与沙箱边界。发现缺陷先保存证据并分类，不跨层盲修。

**Goal:** 支持 cwd 为非 git 超级目录、其下包含多个独立 git 仓库的 Pi 会话。一份 v1 计划按 writePaths 的仓库前缀归属任务，各仓库复用既有 worktree、proof、集成与恢复链；单仓库行为、旧合同 hash、旧 session 与旧 subject 不变。

**Architecture:** 不扩展计划 schema，不引入 repoId 字段或双路径文法。采用一份 Host 生命周期、一个 execution broker、按 canonical repository identity 管理的既有 coordinator/workspace 上下文，以及只负责选择上下文的薄路由。Goal 侧按“纯归属与 binding → Host 单子仓库 → Host 双仓库 → subject+scheduler 完整增量 → continuity”串行推进；验证随各增量前移，真实 smoke 只做最终确认。

**Tech Stack:** Node 22.19+ 原生 TS、goal-runtime、pi-subagents execution/workspace/coordinator、git worktree；只扩展既有测试文件，不新增测试文件。

## 0. 复杂度预算与范围

- 已只读核对 `~/taoappuse/`：根目录非 Git，当前可见 **23 个一层普通独立 Git 根**；本版只服务这种形态。
- 不支持：linked worktree、同 common-dir 多候选、路径别名、嵌套仓库、动态仓库拓扑、超级根裸目录任务、跨仓库单任务、Inline Goal。
- **计划合同零扩展：**不增加 `GoalTask.repoId`，不改变 hash 输入；超级工作区只接受超级根相对且带仓库前缀的 writePaths。
- **持久化最少量：**单仓库 binding/subject 保持原形状；多仓库 binding 只保存计划实际参与仓库及固定身份，不保存目录库存、任务映射或 run→repo 索引；subject 只有旧单仓库与一个多仓库封套两种形状，无过渡格式。
- **状态机零新增：**复用既有 broker drain、workspace lifecycle、integration queue、proof outbox 与 shutdown-debt。新增代码不得拥有第二套业务状态、终局判定或恢复账本。
- **串行 DAG：**T0→T1→T2→T3→T4→T5→T6。每个增量必须 typecheck、运行所属既有测试并留下对应证据后才进入下一步；不为文件级并行制造隐含接口返工。
- 测试只扩展真实既有文件，不新增测试文件；真实 provider 仅在 T5 使用。每个任务完成后立即勾选，完成通知不代替验收。

### 权威参考

| 路径 | 用途 |
|---|---|
| `docs/plans/2026-10-26-goal-runtime-v1.md`、`docs/architecture/goal-runtime-v1.md` | v1 合同与恢复边界 |
| `docs/reviews/2026-10-27-goal-runtime-v2-review-1.md` | 首轮源码缺口 |
| `docs/reviews/2026-10-27-goal-runtime-v2-review-2.md` | 二审复杂度与收敛约束 |
| `src/goal-runtime/contract.ts` | `GoalTask`、`GoalSubject`、`CaptureSubject`、合同 hash；本版不改 GoalTask |
| `src/goal-runtime/session-state.ts` | `PlanBinding`、`GoalState`、精确解码与旧记录恢复 |
| `src/goal-runtime/index.ts` | 绑定发现入口、execution service 恢复接线 |
| `src/goal-runtime/scheduler.ts` | 派发、binding 重入、subject 捕获与完成比较、持久 dispatch intent/run 恢复 |
| `src/goal-runtime/verification.ts` | 单仓库 Git 原语、指纹与共享比较实现 |
| `src/goal-runtime/continuity.ts` | compact/新 Host 恢复；只消费 execution.inspect |
| `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts` | Host 单 coordinator/service/facade、broker 回调、trace、关闭 |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts` | executeCoding、dispatch writePaths/policy、request origin |
| `packages/pi-subagents-enhanced/src/execution/index.ts` | `PlanRunRef`、execution service；不是 executeCoding 实现 |
| `packages/pi-subagents-enhanced/src/workspace/repository-identity.ts` | common-dir coordinator identity 与 storage identity |
| `packages/pi-subagents-enhanced/src/workspace/service.ts` | workspace receipt 的 originRoot/owner/lease/run |
| `packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts` | 当前单 client 处置 facade |
| `packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts` | 既有 drain/关闭顺序 |
| `scripts/probes/goal-smoke.ts` | v1 真实 Host RPC、预算与清理模式 |

### 冻结规则

1. **发现与准入：**仅 plan 绑定时枚举一层直接子目录。候选必须是 realpath 后仍位于超级根内的 canonical 普通仓库根；linked-worktree migration debt、同 common-dir 重复、路径别名排除或拒绝并诊断。repoId 只是相对目录名，不替代既有 `repositoryId/storageRepositoryId`。
2. **唯一路径文法：**超级工作区任务的每条 writePath 都必须以同一个 `<repoId>/` 开头；恰好归属一个参与仓库。无前缀、跨仓库、绝对路径、`..`、剥除后空或非法路径稳定拒绝。单仓库无前缀规则完全不变。
3. **一次投影：**共享纯函数输出任务 repoId、仓库 root、原 writePaths 与仓库相对 writePaths。只有派发投影剥除一次首段；child prompt、dispatch writePaths、workspace policy 消费同一结果。原合同、acceptance、TaskState 与 hash 不改写。
4. **固定参与集合：**多仓库 binding 只保存本计划实际参与仓库的 repoId、root 与既有固定身份；恢复只解析这些记录并核验，不重新扫描全目录。新增无关兄弟仓库不影响重入；task→repo、路径投影、标题和 checkpoint 的 repoId 全部派生，不另存。
5. **主体：**保留 `captureSubject(string)` 的单仓库原算法作为内部原语。多仓库封套按计划参与仓库逐个调用原语，成员复用旧字段，按 repoId 排序聚合；仓库内部仍覆盖 v1 完整 Git 可见候选，不缩成 writePaths。一个比较实现服务 receipt 与 scheduler 完成判定。
6. **check：**超级工作区命令在超级根执行，单仓库在 repositoryRoot；不增加 check cwd 字段，fail-closed 不变。

### T0: 纯归属、一次投影与最小 binding

- [x] **Depends:** none
**WritePaths:** `src/goal-runtime/repository-resolution.ts`（新建纯函数模块）、`src/goal-runtime/session-state.ts`、`src/goal-runtime/index.ts`、`packages/pi-subagents-enhanced/src/workspace/service.ts`（仅公开 re-export 既有 canonical identity）、`test/goal-runtime-contract.test.mjs`、`test/goal-runtime-runtime.integration.mjs`
**Docs:** 冻结规则；contract/session-state/index；二审 High 2、3 与 Medium 5、6
**Resources:** 旧账本只读，不迁移、不回填

**Steps:**

1. 在纯函数模块实现候选准入、参与仓库解析、唯一前缀归属、一次路径投影与稳定的 binding 语义等价输入；不让 scheduler/verification 反向依赖 index。
2. index 只在绑定时发现仓库并构造参与集合；canonical identity 通过 `pi-subagents-enhanced/workspace` 公共入口复用既有 `resolveRepositoryIdentity`，不得复制哈希算法。单仓库继续产生 v1 binding；多仓库保存固定参与仓库及既有 canonical identity，不保存发现库存。`repositoryRoot` 在超级工作区仅是锚点，不作 Git 操作目标。
3. session-state 精确解码多仓库 binding；旧记录原样恢复。为避免旧 scheduler 把超级根用于 Git/dispatch，T0 的 plan_execute 必须在 activate/advance 前以 `GOAL_MULTI_REPOSITORY_EXECUTION_UNAVAILABLE` 拒绝多仓库执行，且不持久化半激活实例；该临时门由 T3 删除。此任务不改 GoalTask、GoalSubject、CaptureSubject 或 scheduler，不制造过渡 subject 类型。
4. 在既有测试内覆盖 23 仓库场景所需的普通根、无关兄弟仓库、旧 hash 固定值、旧 binding 重入等价输入、路径投影和非法拓扑拒绝。此增量只验纯规则与 binding，不声称 Goal 已可端到端执行。

**Acceptance:** 归属规则只有一个入口和一种文法；单仓库持久形状不变；多仓库仅固定参与集合；typecheck 与所属测试通过。
**Stop conditions:** 需要 repoId 合同字段、双文法、linked worktree 或动态重扫时停止。

### T1: Host 单子仓库完整链与证据点

- [x] **Depends:** T0
**WritePaths:** `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/execution/index.ts`、`test/subagent-runtime-membrane.test.mjs`
**Docs:** Host 初始化/关闭、executeCoding、PlanRunRef、workspace receipt、root-broker drain；二审 High 1、4
**Resources:** 一份 Host 生命周期；真实生产连接装配，provider/child 可受控替身

**Steps:**

1. 非 git 超级根先只支持一个已验证子仓库的完整 Host 链：从经验证 request origin 选择 canonical 仓库上下文，复用现有 coordinator client/server、workspace service、binding resolver、queue 与 proof outbox。Host 在 package 内以既有 repository identity 和 realpath/gitDir 等事实独立执行同等一层普通仓库准入，不跨层 import T0、不复制身份 hash、不扫描仓库；workflow/orchestrator 以可信 Host ctx.cwd 校验会话，child cwd 保持 workspace.dispatchCwd。
2. 打通 executeCoding 分配、集成、terminal proof、execution.inspect、typed resume 与 close；保留单仓库 Host 快路径。此步不实现双仓库并行或路由发现。
3. 既有 run 的操作从唯一、同 owner 的持久 workspace receipt 的 originRoot 解析仓库上下文；`listOwned` 只用于选定后的核验，不用于轮询发现归属。
4. 将 plan service 当前空 trace 接入普通工具调用已有的阶段 trace，记录分配、workspace/lease/run、canonical identity、queue/proof/receipt 的对应关系；不新增日志系统。
5. 用真实生产连接装配和既有 coordinator 接口做受控验证，不用合成 execution adapter 代替 Host 证据。

**Acceptance:** 超级根内一个子仓库的 Host 全链受控通过；身份来源固定；单仓库 Host 无回归；关闭与 trace 有明确证据。
**Stop conditions:** 需要第二账本、扩展 PlanRunRef/proof 或声明外文件时停止。

### T2: 同 Host 双仓库薄路由与关闭边界

- [x] **Depends:** T1
**WritePaths:** `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`、`packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`packages/pi-subagents-enhanced/src/execution/index.ts`、`test/subagent-runtime-membrane.test.mjs`、`test/workspace-disposition-settlement.integration.mjs`
**Docs:** T1 证据；repository-identity、disposition-facade、ledger.listScoped、root-broker 关闭；二审 High 1、3、4
**Resources:** 一个 broker、一套全局回调；各仓库只有连接上下文，不复制 execution/workspace 注册或业务生命周期

**Steps:**

1. 将 T1 单上下文扩展为按 canonical repository identity 延迟建立并复用的上下文集合；不是“一个连接随任务切换”，也不是按仓库复制完整 runtime。Git 单仓库 fast path 继续原样接受既有 goal-task/goal-validation/standalone owner，不因新 wrapper 收窄；超级根新路由仅承诺 standalone，其他 owner fail-closed。
2. 首次分配只从已验证 request origin 选上下文；已有 run 只从唯一同 owner workspace receipt 选上下文。分配、disposition、inspect、resume、proof 全部消费同一选择结果，禁止分别推导或靠 listOwned 发现归属。
3. workspace service 按既有 storageRepositoryId 分仓，disposition facade 路由到同一选定 client；workspace/queue/proof 不得跨分区。
4. broker 回调只安装、卸载一次；每仓库 close 不得清空全局回调。继续由既有 broker drain 与 shutdown-debt 拥有关闭顺序；单连接失败只清理该上下文，晚到或错身份回调 fail-closed。
5. 受控验证 A/B 交错回调、并行 workspace、错身份拒绝、连接失败、proof delivery、typed resume 和完整关闭；保留每个身份边界的首个失配证据。

**Acceptance:** 两个子仓库在同一 Host 下完整链与关闭通过；无回调覆盖、跨分区、别名连接或新增状态机；单仓库回归通过。
**Stop conditions:** 需要复制完整 runtime、新增 run→repo 持久索引、修改证明/集成语义或扩大拓扑支持时停止。

### T3: subject 与 scheduler 的一个可验收串行增量

- [x] **Depends:** T2
**WritePaths:** `src/goal-runtime/contract.ts`、`src/goal-runtime/session-state.ts`、`src/goal-runtime/verification.ts`、`src/goal-runtime/scheduler.ts`、`src/goal-runtime/index.ts`（仅移除 T0 临时执行门及必要接线）、`test/goal-runtime-contract.test.mjs`、`test/goal-runtime-runtime.integration.mjs`、`test/goal-runtime-rpc.integration.mjs`
**Docs:** T0 纯函数与 binding；T2 Host 接口；subject 类型、精确解码、两处捕获及比较；二审 High 2 与 Medium 5
**Resources:** 同一任务拥有类型、捕获、解码和两个消费者，避免中间不可 typecheck 的过渡合同

**Steps:**

1. 增加可判别多仓库 subject 封套与精确解码；旧单仓库字段/fingerprint/记录不变。保留单仓库 `captureSubject(string)` 原语，多仓库逐成员复用并按 repoId 排序聚合。
2. 在 verification 提供唯一 subject 比较实现；scheduler receipt/完成判定及两处捕获全部迁移，超级根不执行 Git。只捕获计划参与仓库，仓库内候选规则不变。
3. 删除 T0 的 `GOAL_MULTI_REPOSITORY_EXECUTION_UNAVAILABLE` 临时门。scheduler 派发使用 T0 仓库 root 与仓库相对 writePaths，executeCoding cwd 指向任务仓库；prompt、dispatch、policy 同源。binding 重入消费 T0 稳定语义等价，旧记录恢复后重复 execute 可用且不回填。
4. retry、cancelled 替换与真实持久 dispatch intent/run 恢复重新从原合同+binding 派生；不引入计划中此前误写的 `GOAL_QUEUED` 标识或新恢复机制。
5. 在既有三测试文件完成联合验证：旧 hash/subject、路径/policy、双仓库执行、漂移 repoId、重入、retry/替换与 RPC；单仓库旧断言不削弱。

**Acceptance:** Goal 调度与 T2 Host 链接通；subject 类型、捕获、解码和比较同增量闭合；无双份比较或过渡持久格式；测试/typecheck 通过。
**Stop conditions:** 需要伪造超级根 HEAD、按 writePaths 缩小候选、第二比较实现或新增 repo 持久字段时停止。

### T4: continuity、RPC 消费面与最终联合回归

- [x] **Depends:** T3
**WritePaths:** `src/goal-runtime/continuity.ts`、`src/goal-runtime/index.ts`、`docs/architecture/goal-runtime-v1.md`、`test/goal-runtime-runtime.integration.mjs`、`test/goal-runtime-rpc.integration.mjs`
**Docs:** T0–T3；C 修复同代恢复回调与 proof→settlement→resume 顺序；execution.inspect 合同
**Resources:** continuity 不复制 Host 的 proof/receipt/sidecar 校验

**Steps:**

1. compact/新 Host 只从固定参与 binding 恢复归属、路径与复合 subject；终局事实统一消费 execution.inspect，package Host 负责逐仓库校验，continuity 不重写一套。
2. status/checkpoint 的 repoId 从原合同+binding 派生；verify 使用共享复合比较；五工具和门不变。
3. 文档记录单一路径文法、固定参与集合、Host 身份路由、两种持久形状与不支持拓扑。
4. 运行三个 Goal 测试及 T1/T2 受影响 Host/workspace 回归，确认所有前置增量仍绿。

**Acceptance:** 恢复消费面单一；文档无多余状态机；全部相关测试/typecheck 通过。
**Stop conditions:** 需要在 continuity 再实现证明校验、动态仓库发现或旧记录迁移时停止。

### T5: 真实 smoke 与单仓库回归

- [x] **Depends:** T4
**WritePaths:** `scripts/probes/goal-smoke.ts`、`docs/summaries/2026-10-27-goal-runtime-v2-multirepo-smoke.md`、`docs/summaries/2026-10-26-goal-runtime-v1-verification.md`
**Docs:** T0–T4；v1 探针/报告；二审 High 4 与 Medium 6
**Resources:** `qoder-pool/DeepSeek-Flash`；每个 child 实例最多 6 次 assistant，主 Host 沿用现探针每场景最多 16 次，不新增预算；mkdtemp、auth 仅 cp 间接

**Steps:**

1. 先改探针取证：**失败无条件保留临时根与日志**，`--keep-artifacts` 仍可用于成功留证；只有成功或缺陷归因完成后才 removed:true 清理。并行、恢复、retry 分成独立场景，不叠加所有故障。
2. **并行场景：**两个无资源冲突任务，并发容量至少 2，记录真实运行重叠；验证各自 origin、workspace/lease/run、canonical identity、proof、receipt、exit 0 checks 与 released。
3. **工具与修复场景：**取得成功 checkpoint；制造受控检查失败，取得真实 retry 并完成；verify 复合主体通过；无前缀/跨仓库任务稳定拒绝。结合 status/execute 构成五工具实证。
4. **恢复场景：**真实 compact 与新 PID Host 组合，核对两个仓库旧 run facts、inspect、verify、proof/receipt 与 completed/released；不只测同 Host compact。
5. **单仓库回归：**复跑现有正向、typed resume、compact+新 PID 三场景。报告记录完整 ID/exit code/预算/清理；v1 报告只追加回归结论。新缺陷保留现场并另派修复，不伪造通过。

**Acceptance:** 双仓库真实并行、checkpoint/retry、compact+新 PID 恢复及单仓库三场景全部有证据；临时资源清理，无 staged。
**Stop conditions:** 模型不可用或生产缺陷未闭环时如实停止对应验收；不得人工推进 queue 或伪造 receipt。

### T6: 收尾

- [x] **Depends:** T5
**WritePaths:** `docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md`
**Steps:** 勾选已实证任务，报告剩余边界；commit/push 等待用户明确指令，AGENTS_GLOBAL 如确需同步另行报告。

## 1. 全局验收

- v1 计划 schema、GoalTask/hash、单仓库 binding/subject/fingerprint 不变；旧记录恢复和重复 execute 可用。
- 超级工作区只有一种前缀文法、一次投影和固定参与集合；新增无关兄弟仓库不影响计划。
- 一份 Host/broker 正确路由两个普通独立仓库，无第二业务状态机、第二账本、run→repo 索引或回调覆盖。
- 验证随增量前移；真实并行、checkpoint/retry、compact+新 PID 与单仓库回归通过，失败现场保留机制有效。
- Goal 门、fail-closed、resources 互斥、proof/集成与关闭语义零放宽。

## 2. 二审后明确删掉的设计

- 删除 `GoalTask.repoId`、显式/隐式双路径文法及其 hash/恢复组合。
- 删除全量目录库存、动态拓扑、linked worktree/common-dir 别名支持。
- 删除 T1/T2 文件级并行和所有验证后置；改为串行可验收增量。
- 删除按仓库复制完整 runtime、轮询 listOwned 发现归属、continuity 重复 proof 校验等候选方案。
- 保留真实并行 smoke，因为它直接检验共享 broker 的交错回调；不为增加语法组合而削弱它。

## 3. 下一步

本计划由主会话依据二审完成收敛。用户可选择 Subagent-Driven / Inline 开始执行，或继续授权下一轮 reviewer；未获选择不得自动执行。
