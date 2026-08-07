# Planned 基础控制面统一设计（冻结版）

日期：2026-08-08

状态：Planned；本文件定义 `dispatch-ir.v1` 的实现边界，不实现其中任何代码。

## 1. 目标、适用范围与不变量

本 Goal 自举新的 Planned Goal 与 Subagent dispatch 基础控制面。新建 Planned task 一律采用 criteria-only acceptance；既有持久化 Goal/event/command record 的 v1、v2、v3 语义只读 replay。设计必须让正在执行本 bootstrap Goal 的旧控制面记录在候选代码下仍可读取、恢复并按旧控制面完成。

以下是不变量：

1. 新 contract 的身份是 `dispatch-ir.v1`；其 canonical bytes 的 SHA-256 是唯一 `contractHash`。
2. **新** Planned/dispatch 请求只接受 `acceptance.criteria`，不得接受、补推或执行 `acceptance.commands`。
3. `acceptance.commands` 仅是 v1/v2/v3 历史 command record replay 的只读字段：reducer 可展示历史结果和原始字段，但任何新 dispatch、settle、accept 或 validation 均不得将它转回可执行输入。
4. 所有状态改变 fail closed：缺失、重复、版本不匹配或相互冲突的 identity、proof、evidence、lease 都不得以 prose、退出码或“看似成功”的日志替代。
5. bootstrap Goal 自身继续按其创建时的 legacy schema/控制面运行；候选实现必须先按 record schema/version 选择 legacy decoder，不能用 v1 strict parser 拒绝旧 Goal。

本 Goal 不实现 `goal_finalize`、exact-eight ABI、idle continuation 或 Convergent Goal；不删除/回收任何历史 worktree、branch、recovery ref，也不修改 `pi/settings.json`、TokenRec、aliyun skill 或并发 Playwright 工作。

## 2. Schema cutover 与兼容边界

### 2.1 新 schema（写入路径）

新 Planned task 的概念 schema 如下；`additionalProperties` 均为 false，枚举外值一律拒绝：

```yaml
schemaVersion: planned.v1
id: task identifier
kind: coding
acceptance:
  criteria:
    - id: stable criterion identifier
      statement: human-readable, testable requirement
      evidenceKinds: [changed-files, tests, command, manual-review]
dispatch:
  contractVersion: dispatch-ir.v1
  contractHash: sha256 hex
```

`acceptance.criteria` 必须是非空数组，criterion `id` 在 task 内唯一，`statement` 非空。不存在 `acceptance.commands`、shell 字符串、隐式默认命令或由 Agent 解释成命令的自由文本字段。criteria 可以要求 command evidence，但命令只能作为后述受控 validation plan 的产物，不能来自 task acceptance schema。

`dispatch-ir.v1` 的 canonical contract 至少绑定：`goalId`、`taskId`、`attempt`、任务版本、approved `writePaths`、`cwd`/Git root、criteria snapshot、executor policy、workspace allocation、validation policy。canonicalization 固定 UTF-8、字段排序、无未声明字段；hash 对 canonical contract 计算，hash 字段本身不参与 hash。任一重算差异都拒绝 dispatch。

### 2.2 读取路径（legacy replay）

每条历史 record 先由持久化 `schemaVersion`（缺失时按创建时 legacy generation）路由：

- v1/v2/v3：使用对应 immutable legacy decoder/reducer，仅只读 replay；保留 `acceptance.commands` 原文、历史状态、历史 evidence 与历史 verdict。
- `planned.v1`/`dispatch-ir.v1`：使用本设计的 strict decoder。
- 未知、混合或伪造版本：不猜测、不降级，projection 标记 `recovery_required`，mutation 和 settle 均拒绝。

迁移不重写事件，不把 legacy commands 编译到 v1，也不要求历史 record 满足 criteria-only。新 writer 不得向 legacy Goal 追加 v1 事件；bootstrap Goal 的 legacy completion 路径继续可读并可完成。候选 Pi canary 必须以隔离 state/fixture 运行，并明确验证“旧 bootstrap record 可 replay、新 Planned record 才 strict cutover”。

## 3. Dispatch、executor 与 terminal proof

### 3.1 一次 dispatch 的绑定

创建 dispatch ticket 时，原子持久化 `(goalId, taskId, attempt, taskVersion, contractHash, workspaceLeaseId)`。Subagent spawn 返回 `runId` 后，追加不可变 `task.executor_bound`：

```yaml
goalId: ...
taskId: ...
attempt: positive integer
runId: host-issued opaque id
contractHash: sha256...
workspaceLeaseId: ...
executor: { hostId: ..., sessionId: ... }
headAtDispatch: full Git commit SHA
```

同一 `(taskId, attempt)` 只能绑定一个 runId；同一 runId 不能绑定多个 task/attempt。spawn 前 hook 和实际 execute-time resolver 都重算 contract hash，并核对 ticket、cwd/Git root、attempt、writePaths 和 lease；任何一处不一致即不启动或标记失败。主 Agent、Subagent 不能自报或覆盖 runId。

### 3.2 Root Broker official terminal proof

只有 Root Broker 写出的、按 runId 查询到的 official terminal proof 才能结束 attempt：

```yaml
runId: ...
terminal: succeeded | failed | cancelled | timed_out
finishedAt: RFC3339 timestamp
hostId: ...
proofId: immutable broker identity
```

`goal_settle` 必须精确匹配 task/attempt 的 executor binding 和 successful terminal proof；proof 缺失、非 terminal、runId/host 冲突、多个 terminal proof 或 cancelled/failed/timed_out 都 fail closed。Subagent 的 completion prose、YAML、git commit、进程退出码都不能替代 broker proof。重试创建新 attempt 与新 binding，绝不复用旧 proof。

## 4. 双路径 evidence 与 settle 原子性

Subagent 在完成后提交 YAML self-evidence，绑定当前 `(goalId, taskId, runId, attempt, contractHash, HEAD)`：

```yaml
identity: { goalId: ..., taskId: ..., runId: ..., attempt: ..., contractHash: ..., head: full SHA }
criteria:
  - id: criterion id
    status: satisfied | not-satisfied | not-applicable
    evidence: immutable references
commandsRun: [{ command: redacted command, result: passed | failed, outputRef: ... }]
changedFiles: [repository-relative paths]
```

YAML 是声明，不是信任根。主 Agent 必须在不同于 executor worktree 的 managed validation workspace 独立复核：读取 integrated candidate HEAD、重算 identity、检查 approved paths 和 Git identity、执行受控 validation plan，并产出 reviewer evidence。不得将 executor worktree 的 untracked/ignored 内容复制到复核路径。

`goal_settle` 以单一 append/transaction 同时持久化：绑定的 broker terminal proof 引用、Subagent YAML reference、独立 reviewer evidence reference、每项 criterion verdict、验证 HEAD、settle verdict。任一引用缺失、hash/HEAD 不一致、criterion 未覆盖或 reviewer verdict 冲突时不写 partial accepted settle；写失败后的可见状态只能是未 settle/failed，不能是成功。

## 5. Managed worktree、释放与 clean validation

每个**新建** worktree 在创建前持久化 durable allocation intent：`leaseId`、owner `(goal/task/attempt)`、目的、repo root、target branch/ref、requestedAt、状态 `reserved|allocated|releasing|released|cleanup_debt`。分配成功后记录绝对路径、Git common-dir identity、base SHA 与 owner；任何未归属、重复归属或 owner 不匹配的路径不使用。

释放前按固定顺序检查并记录：

1. lease owner、task/attempt、worktree path、Git common-dir、HEAD 与预期 identity；
2. worktree 下及以其为 cwd 的子进程/进程组（含 validation server）均已退出；
3. Git worktree 状态、锁、branch/ref 占用和资源可安全释放；
4. teardown 完成后复查进程与 Git identity。

任一检查失败时保留 allocation、标为 `cleanup_debt`，阻止复用和 accept，不进行猜测性删除。本 Goal 不追溯清理历史资源。

validation workspace 必须由 manager 新建并有独立 validation lease，基于待验 integrated full SHA，干净 checkout，独立 HOME/TMP/port/process group；仅允许显式声明、受 allowlist/timeout/输出大小上限约束的 setup 与 validation action。最小安全上限须配置化且保守：并发 validation workspace 有全局上限、每 task 一个 active validation、每命令 timeout、输出截断、受控端口/子进程组、结束时强制 teardown。超限、残留进程、dirty tree、未知 Git identity 或 fixture 增长均失败，不复用 executor runtime 依赖。

测试 fixture 每轮建立 allocation 后必须 teardown；连续至少两轮运行后，manager inventory、Git worktree 数、fixture directory、监听进程/子进程数量均回到基线（零净增长）。真实 Pi Host 与 Root Broker 集成测试除单元测试外必须覆盖该检查。

## 6. acceptance、ABI 与后续能力边界

本 bootstrap Goal 内 `goal_accept` 维持既有 task-level 语义：它只消费已成功 settle 的 task-level双路径 evidence，不改名、不提升为 Goal-level finalize，也不改变 Root Broker exact-seven tool-name ABI。exact-seven 集合仍为现有七个 Goal tools；本设计不增加 model-facing tool。

- **goal_finalize（后续）**：负责 Goal-level 汇总/最终宣告时才可定义；不得由 `goal_accept`、settle 或 criteria-only cutover 暗中实现。
- **idle continuation（后续）**：空闲轮询、自动恢复/续派不是本 Goal 的 dispatch 语义；本版本只对显式 dispatch ticket 工作。
- **Convergent Goal（后续）**：迭代收敛、开放式再规划/终止策略不属于 Planned 的一次 task/attempt contract；不得以“criteria 未满足”自动扩张 scope。

## 7. 验收与迁移验证矩阵

实现后的验收必须覆盖：

1. 新 Planned/dispatch schema 仅接受非空 `acceptance.criteria`，含 commands 的新输入被拒绝；v1/v2/v3 command logs 在只读 replay 中继续显示且从不执行。
2. 当前 bootstrap Goal 的 fixture/state 可被候选 decoder replay，并按 legacy 控制面完成；隔离候选 Pi canary 同时验证上述新旧路径。
3. contractHash、task/attempt/runId/HEAD、Root Broker terminal proof 任一缺失或冲突时 settle fail closed。
4. YAML self-evidence 与不同路径 reviewer evidence 都存在且 identity 一致时才原子 settle；篡改任一字段被拒绝。
5. managed worktree intent、owner、release pre/post check、cleanup debt、dirty/active-process validation failure 与连续 fixture 零增长均有单元、集成和真实 Pi Host 覆盖。
6. 完整 Goal Engine、Subagent、Root Broker、worktree、真实 Pi Host 测试通过；候选 Pi canary 入口独立且不改变 bootstrap Goal 旧控制面。

本文件冻结接口与安全边界；实现计划可以补充测试、错误码和存储细节，但不得放宽上述 schema、只读 replay、绑定或 fail-closed 条件。
