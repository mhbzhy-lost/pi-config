# Plan IR v3 架构合同

本文是 `pi-plan.v3` 与 `plan-ir.v3` 的字段、身份和消费者边界的权威说明。实现入口在 `scripts/lib/plan/plan-document.mjs`、`scripts/lib/plan/ir/compile.mjs`、`scripts/lib/plan/plan-revision-store.mjs` 与 `scripts/lib/plan/plan-amendment.mjs`。

## 输入与编译所有权

`pi-plan.v3` 是唯一可提交的 Markdown Plan 合同。其 Execution Contract 使用 `schemaVersion`、`revision`、`parentPlanHash`、`verification`、`requiredGates`、`resourceCapacities`、`executionDefaults`、`taskExecution` 与 `taskAcceptance`。Plan 必须有非空 `instructions`；每个 Task 必须有非空正文、完整验收策略及受声明资源约束的文件/资源定义。

| 字段 | 含义 |
| --- | --- |
| `revision` / `parentPlanHash` | 正整数 revision 与上一个规范化 Plan hash；revision 1 的父 hash 为 `null`。 |
| `verification` | 非空、唯一 ID 的 `{id, command, cwd, timeoutMs}` 受控命令表。 |
| `executionDefaults` / `taskExecution` | 默认执行策略与每 Task 的 `risk`、`workflow`、`timeoutMs` 覆盖；agent 固定为 `executor`。 |
| `taskAcceptance` | 每个 Task 恰有一项策略；`commands` 引用命令 ID，其他策略必须给出原因。 |

Harness/revision service 是唯一 parser/compiler 所有者：读取 source bytes 后执行 `parsePlanDocument(source)` 与 `compilePlanToIR(plan)`。Main 与 Plan Runner 只传 `planPath` 或受信 revision identity，不能提交 IR JSON、hash、Task 图或编译结果。compiler 对 v3 结果递归冻结；外部对象不能成为权威 IR。

## 单一持久领域 IR

每个 `pi-plan.v3` revision 只编译为一份不可变 `plan-ir.v3`。它是唯一具有版本、hash 和持久身份的 Plan 领域 IR；不另存调度 IR、执行 IR 或运行时 packet。

```json
{
  "version": "plan-ir.v3",
  "source": {"schemaVersion": "pi-plan.v3", "revision": 1, "parentPlanHash": null, "planHash": "<sha256>"},
  "title": "示例计划",
  "instructions": "批准的计划级约束",
  "nodes": [{"id": "task-1", "sourceOrder": 1, "hashes": {"scheduling": "<sha256>", "semantics": "<sha256>", "full": "<sha256>", "effective": "<sha256>"}}],
  "hashes": {"context": "<sha256>", "verification": "<sha256>", "graph": "<sha256>", "full": "<sha256>"},
  "hash": "<sha256>"
}
```

| 区域 | 完整字段 |
| --- | --- |
| 根身份 | `version`、`source.schemaVersion/revision/parentPlanHash/planHash`、`hash`。 |
| Plan 合同 | `title`、`instructions`、`executionPolicy`、`verification.commands/requiredGates`、`resourceCapacities`。`executionPolicy` 固定 attempt worktree、仓库指令、外部副作用 Attention、`plan-attempt-result.v1` 与单一非 merge commit 要求。 |
| 节点 | `id`、`sourceOrder`、`title`、完整 `body`、`dependencies`、`allowedPaths`、`resources`、`execution`、`acceptance`、`hashes`。dependency 固定要求已 integrated 并声明 receipt 类型。 |
| 图 | `edges` 从依赖 Task 指向下游 Task；`nodes` 按稳定拓扑序排列，`sourceOrder` 只处理同一 frontier 的稳定优先级。 |

## Hash 覆盖矩阵

所有 hash 均对确定性 JSON 值计算 SHA-256。

| Hash | 覆盖内容 | 用途 |
| --- | --- | --- |
| 根 `hash` / `hashes.full` | 完整根合同与派生 context、verification、graph、节点 hash，排除根自身 hash 字段 | revision 的 IR 身份。 |
| `hashes.context` | `title`、`instructions`、`executionPolicy` | Plan 级执行上下文。 |
| `hashes.verification` | 完整 verification commands 与 required gates | 验证合同。 |
| `hashes.graph` | resource capacities、edges、全部节点 scheduling hash | 调度/授权图。 |
| 节点 `semantics` | `id`、`title`、`body`、`execution`、`acceptance` | Task 局部业务语义。 |
| 节点 `scheduling` | `id`、`sourceOrder`、dependencies、allowed paths、resources、`execution.agent` | frontier、路径和资源调度。 |
| 节点 `full` | 整个节点，不含其 `hashes` | accepted/integrated Task 的不可改写合同。 |
| 节点 `effective` | context hash、verification hash、节点 full hash | 当前 revision 下实际派发的 Task 合同。 |
| `dispatchContextHash` | Coordinator 生成的 execution prompt、attempt ID、base commit 与 dependency receipts | dispatch 的传输上下文绑定，不是第二领域 IR。 |

只改 Task body 会改 `semantics/full/effective` 与根 hash，不改 `scheduling`；改依赖、路径、资源、source order 或 agent 会改 scheduling、graph、full/effective 与根 hash；改 Plan 指令或验证命令会改 context 或 verification、所有受影响 effective 与根 hash。

## Selector 与消费者

selector 是从完整 IR 临时投影的只读、递归冻结 view。它没有 `version`、hash 或持久 identity，不能写盘、不能作为事件身份，也不能绕过 compiler。

| Selector | 输出 | 消费者 |
| --- | --- | --- |
| `selectSchedulingView(ir)` | capacities 与每节点 id、deps、paths、resources、agent | frontier、资源锁、Integration Queue。 |
| `selectExecutionView(ir, taskId)` | Plan title/instructions/execution policy 和完整节点 | Coordinator prompt 与 Executor。 |
| `selectVerificationView(ir, taskId)` | Plan commands/gates 与 Task acceptance | Task command registry 与 Gate。 |

Coordinator 在动态派发时再合入当前 attempt ID、base commit、输出路径和已 integrated 依赖 receipts。receipt 只包括 `taskId`、result commit、integrated head、changed paths 与 command verification summary。它们、workspace、run binding、Attention、Gate 轮次、cleanup debt、Attempt context 和 transport request 都是运行事实或传输请求，不是另一份持久领域 IR。

structured verification 只从批准 command registry 通过 ID 解析；v3 命令使用安全的仓库相对 `cwd` 和边界内 `timeoutMs`。未注册 command ID、非法 cwd 或无效命令结构均 fail closed，不能让自由 shell 文本替代批准验证。

## Revision store 与事件提交

revision store 位于 `stateRoot/var/plan-runs/<planId>/`，不在 Plan worktree 内：

```text
revisions/
  000001/
    source.md
    plan-ir.json
    manifest.json
current.json
```

`source.md` 保存收到的精确 UTF-8 bytes；`plan-ir.json` 为编译后 canonical JSON；`manifest.json` 记录 source bytes hash、规范化 plan hash、IR hash、artifact hash、task hashes、initiator、reason 与创建时间。store 先写私有 candidate 目录、回读重验，再原子 rename；正式 revision 永不覆盖，冲突 fail closed。

`plan.created` 和 `plan.amended` 是 revision 已提交的唯一事件事实。`current.json` 仅含 plan/revision/manifest/IR identity 的原子缓存；它缺失、陈旧或 crash 在事件后写入前时，恢复按最后一个已提交 `plan.created` 或 `plan.amended` 对应 revision 调用 `reconcileCurrent` 修复。没有事件引用的 candidate/orphan 不得成为 current。

amendment 的三个 checkpoint：

1. **授权**：恰有一个已 resolved 的 blocking Attention request，request ID 未消费，source revision 链正确。
2. **CAS 提交**：service 验证 diff、不可变历史与资源约束，准备新 artifact，再以 `expectedProjectionVersion` 追加 `plan.amended`；该事件原子切换 revision 和 supersede intent。
3. **Supersede 收敛**：对 changed/rebound 的合同 Attempt 建立 late-start fence，取得 never-started 或官方 terminal proof，追加 `attempt.superseded`，再按 `superseded-cleanup` 或 `superseded-preserve` 释放 workspace/resource。cleanup 未完成时禁止下一次 amendment 与重派发。

accepted/integrated Task 的 `full` hash 不能改变或删除；pending Task 可 retire 但保留 tombstone，历史 ID 不可复用。

## 兼容边界

| 输入 | 输出与限制 |
| --- | --- |
| `pi-plan.v1` | 继续读取并编译为 `plan-ir.v1`，保留旧 hash/事件语义。 |
| `pi-plan.v2` | 继续读取并编译为 `plan-ir.v2`，保留旧 hash/事件语义。 |
| `pi-plan.v3` | 编译为完整 `plan-ir.v3`，进入 revision store，并允许受控 amendment。 |

新 launch 可具有 revision/event identity；但 legacy session 不会被重新解释为 v3 合同。legacy `plan.created` 仍可 replay；v3 `plan.created/plan.amended` 必须携带 revision identity。当前运行时仍是 `scripts/lib/plan/plan-host-runtime.mjs`；Host 退役和 flat runtime 不属于本合同已经完成的范围。
