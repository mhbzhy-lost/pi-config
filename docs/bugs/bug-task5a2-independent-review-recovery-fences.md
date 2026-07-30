# Bug: Task 5A2 独立审查发现 intent 身份与恢复门禁未闭合

## 症状

Task5A2 当前 20 项聚焦测试全部通过，但独立审查发现：pending replay 只验证持久合同与持久 `toolHash` 自洽；Integration Queue 返回 cancelled 或 drain 期间计划终态后仍可能分配 workspace；allocator 成功与 `attempt.workspace-allocated` 事件之间 crash 会遗留不可重试 lease；Coordinator 未显式核对 revision 中可由当前 IR 证明的全部身份字段。

## 影响

被同时改写 contract 与 `toolHash` 的 durable event 可返回未获当前 Plan 批准的写路径、risk 或 cwd；取消中的 Plan 可创建无事件授权的 workspace；进程在 allocation event 前退出后，同一 attemptId 永久因 existing lease 失败；合成或损坏 projection 中自相矛盾的 revision 字段可能绕过 Coordinator 层 current revision fence。

## 复现

1. 生成合法 pending intent，同时修改 contract risk 和由该合同重算的 `toolHash`，保持现有 `dispatchContextHash`；当前 prepare 接受。
2. integration `drain()` 返回 `{state:"cancelled"}`，或 drain 中追加 `plan.cancelled` 后返回 waiting；当前代码 refresh 后继续进入 allocator。
3. `allocateAttemptWorkspace(input)` 成功后模拟进程在 Event Writer append 前退出，再以相同 input 重试；当前抛 `Attempt workspace already exists`。
4. 保持 projection `irHash` 等于当前 IR，单独改写 `irVersion`、revision number、planHash、Task full hash 或 Task key 集；当前 `ensureRevision()` 不拒绝。

## 根因

实现把 canonical 编译误当成授权来源，没有从 current IR 重建 expected dispatch contract；integration 分支只特判 blocked；物理 workspace allocator 被设计为严格一次创建，但领域事件在它返回后才提交，二者之间没有幂等恢复桥；revision 检查只选了 dispatch 使用的 effective/scheduling hash，没有闭合事件 revision 与 IR source/full identity。

Event Writer 没有 hash chain，因此不能把“事件已存在”当成内容完整性证明。另一方面，`manifestSha256` 与 `sourceBytesSha256` 不属于 compiled IR，Coordinator 无法独立证明它们；这两项继续由 revision store/dependency assembly 校验，不在本修复中伪造比较。

## 修复

pending replay 从 current execution view、attempt ID、base commit、authoritative workspace、`outputForAttempt()` 和 current integrated receipts 重编译 expected contract，同时验证持久 source contract 的 canonical hash、expected hash、toolHash、output/receipts/context 全部一致，并在全部 pending 校验完后统一返回。

Integration drain 对 cancelled 直接返回空终态；任何 drain 结果后 refresh projection，再次执行 lifecycle 与 revision fence，终态不进入 allocation。

`allocateAttemptWorkspace()` 在 authoritative lease 已存在时读取并严格核对 plan/task/attempt/origin/state/base/path/branch，确认 worktree 存在且归属一致后返回原 lease；任何字段不一致、缺失 workspace、只有未授权 path/branch 的情况继续 fail closed。Coordinator 测试模拟首次 append crash，证明重试复用 lease 并补交事件。

Revision fence 额外核对 `irVersion === ir.version`、`number === ir.source.revision`、`planHash === ir.source.planHash`、精确 Task key 集及每 Task full/effective/scheduling hash。manifest/source bytes identity 仍由上游 revision store 负责。

## 验证

先分别提交 tests-only RED：自洽合同替换、第二个 parallel pending 篡改原子拒绝、drain cancelled、drain 中并发终态、allocation-event crash 重试、真实 allocator exact lease 幂等与冲突拒绝、revision 字段矩阵。每项必须命中目标缺失行为而非 reducer/fixture。

修复后运行新增聚焦、全部 Task5A2、完整 Coordinator、Attempt Workspace、Plan Events/IR/dispatch IR 回归；确认 cancelled 路径零 allocation/append，pending 拒绝零副作用，allocator 只对 exact authoritative lease 幂等，prepare 仍不 spawn/bind。
