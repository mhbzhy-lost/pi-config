# Plan Runner 全链路架构审计

> 审计日期：2026-07-29  
> 更新范围：Plan IR v3、revision、Harness 与运行时边界

## 结论

原审计中“调度图与执行合同分成两份领域 IR”的建议已过时。现行目标和已实现边界是：一套可 revision 的完整 `plan-ir.v3`，多个无身份 selector view；Harness/revision service 独占 parse/compile；Main 与 Plan Runner 只提交 source 或 revision identity。Attempt context、dependency receipts 与 transport request 是动态运行事实，不具有版本、hash 或持久领域身份，不能演化成第二份 IR。

这项收敛消除了原 v2 在编译时丢失 Task body、执行策略和验收合同的问题。完整节点已包含正文、依赖 receipt 要求、路径、资源、execution、acceptance 及 scheduling/semantics/full/effective hashes；Coordinator 通过 selector 获取最小消费者视图。

## 已落实证据

- 严格 v3 真实 Harness 已由 `6a20884` 迁移，fixture 使用 `pi-plan.v3`，并验证 Task prompt、hash、验收策略和 Gate 合同。
- amendment Harness 的 `c32241d` 覆盖了 `plan.amended` 事件提交后、`current.json` 写入前 crash；恢复依据事件提交 revision 修复 pointer，不重派旧 task hash。
- `plan.amended` reducer 以 resolved blocking Attention、revision 链、request ID、projection-version CAS、immutable Task 与 supersede fence 为前提；事件切换 revision 并持久化 supersede intent。
- supersede 收敛要求 never-started 或官方 terminal proof。已启动、dirty 或已产生结果的 workspace 使用 `superseded-preserve`，只释放逻辑租约而保留证据。
- Gate runtime inspection 已排除 preserve workspace，避免保留证据目录被当作 accumulator worktree 的未跟踪污染。
- 两份真实 Harness Task 已验证完整 prompt、effective task hash、structured verification 和 Gate 路径；资源串行 fixture 同时覆盖路径所有权与最终 Gate。

## 当前架构

```text
Plan source bytes
  -> Harness/revision service: parse + compile
  -> immutable revision store: source.md + plan-ir.json + manifest.json
  -> plan.created / plan.amended (事件权威)
  -> current.json (可修复缓存)
  -> selector views
     -> scheduling/frontier/integration
     -> execution prompt + dynamic receipts
     -> verification registry + Gate
```

`source.md`、`plan-ir.json` 和 `manifest.json` 位于 `stateRoot/var/plan-runs/<planId>/revisions/<revision>/`，不复制进 Plan worktree。revision artifact 通过 candidate 回读验证和原子 rename 发布，正式 revision 不可覆盖。`current.json` 缺失或过期时，只能由最后一条已提交 `plan.created/plan.amended` 的 revision 重新生成；orphan artifact 不能自动成为当前合同。

selector view 仅是从 v3 IR 生成的临时、递归冻结投影。调度 selector 提供依赖、路径、资源和 agent；execution selector 提供完整 Plan/Task 合同；verification selector 提供批准命令、Gate 与 Task acceptance。view 不带独立 version/hash/persistent identity。

## Amendment 与动态边界

amendment 依次经过三项不可跳过的 checkpoint：

1. **授权**：一个 resolved blocking Attention request 授权新 source，base revision 与 parent plan hash 必须连续。
2. **CAS**：revision service 重解析、重编译、验证 diff/资源/不可变历史，并以 expected projection version 追加 `plan.amended`。
3. **Supersede**：changed 或 rebound 的 active 合同 Attempt 先被事件标为 supersede-requested，取得官方停止事实后才 superseded 并释放 workspace/resource；未清理完成时禁止后续 amendment。

事件保存 revision identity、task hashes、diff 和运行绑定，不复制完整 IR。`dispatchContextHash` 绑定具体 prompt、attempt、base commit 和 receipts；它是传输审计字段，不是可持久化或可复用的领域模型。dependency receipts 同样只在派发时由已 integrated 事实构造，边界限定为 result commit、integrated head、changed paths 与验证摘要。

## 仍存风险与迁移边界

- `scripts/lib/plan/plan-host-runtime.mjs` 仍是当前 runtime。Host retirement、flat runtime 和确定性控制面替换是下一份计划，不应宣称已完成。
- Plan Runner 仍在现有 Host/Capsule 生命周期内推进部分控制流；v3 IR 收敛不等于完成 Host 生命周期、Gate repair/retry 或所有 recovery 迁移。
- v1/v2 继续兼容读取和 replay，且不会被重新解释成 v3；只有 `pi-plan.v3` 获得完整合同和 amendment 能力。
- Gate 的 workspace exclusion 解决 preserve evidence 污染，但不替代对生产 audit/review adapter 与 Host 终态回收的后续审计。

## 决策

- **[领域合同]**：一份完整、可 revision 的 Plan IR，消费者只读取 selector。
- **推荐**：`plan-ir.v3`，因为 Task 语义、调度与验证必须绑定同一批准 revision。
- **不选原因**：拆分持久领域模型会让 hash、replay 与 amendment 的身份关系漂移。
- **选错代价**：Task 修订或恢复时暴露，修复代价高。

- **[编译所有权]**：Harness/revision service 独占 parser/compiler。
- **推荐**：只接受 source/revision identity，因为 canonicalization 和 hash 必须由确定性代码产生。
- **不选原因**：Main 或 Plan Runner 直接传 IR 会绕过字段校验和不可变 artifact。
- **选错代价**：启动或 amendment 时暴露，修复代价高。

- **[运行时迁移]**：保留当前 Host，后续单独退役。
- **推荐**：维持 `plan-host-runtime.mjs`，因为 v3 文档工作未实现 runtime 生命周期替换。
- **不选原因**：提前宣称 flat runtime 会掩盖现有 Host、Gate 和恢复责任。
- **选错代价**：终态回收或恢复时暴露，修复代价高。

## Superseding Decision

- **[运行时替代]**：Task9 已实现并取代 Host-retirement 决策；Root 是唯一生命周期 owner，其他 Root 不 attach。
- **推荐**：使用 Root broker 管理同一 Root 内 Plan Runner 与 Executor 的派发、所有权和有序关闭。
- **不选原因**：其他 Root 接管运行会破坏 session-local handle 与官方终态证明的归属。
- **选错代价**：恢复或关闭时可能重复控制同一 Attempt，审计事实不再可靠。

## Final Runtime Status

上文“仍存风险”和“运行时迁移”保留 2026-07-29 审计时点的历史事实；`Superseding Decision` 及本节描述当前状态。生产路径不再包含 `plan-host-runtime.mjs` 或 shared `subagents-rpc-client.mjs`，parallel Host Harness 已由双 Plan flat Root Harness supersede。

- **[Harness 收敛]**：并行主路径与 amendment 崩溃恢复均只验证 Root-owned flat runtime。
- **推荐**：双 Plan Harness覆盖常规并行/Attention/关闭，独立 amendment Harness只覆盖 event-to-pointer crash，因为领域矩阵已由单元测试验证。
- **不选原因**：保留旧 Host Harness会制造第二套生命周期权威；把全部断言塞入一个真实场景会放大时序噪声。
- **选错代价**：runtime升级或崩溃恢复时暴露，修复代价中。
