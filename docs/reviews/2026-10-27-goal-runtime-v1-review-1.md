# Goal Runtime v1 一审

日期：2026-10-27。状态：审阅已完成；以下为原始结论，修订由主会话执行。

本轮一审完成，结论是 **修订后可执行**。8 个任务的 DAG、主要写路径和公开接口已具备实施基础；发现两处需要在执行前补齐的恢复合同缺口，不需要重写整体架构。

1. **高严重性：`plan_retry` 的准入条件遗漏了“child 已失败、尚未产生检查回执”的恢复路径。**

   **计划位置：** [第 314 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:314)、[第 334 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:334) 将 retry 限定为失败 check 的关联任务；[第 337 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:337) 又要求失败 child 复用 resume。第 245 行允许任务没有 checks，第 325 行要求 child 成功、集成并释放后才进入 verifying。

   **生产证据：** upstream [async-resume.js:506](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/async-resume.js:506) 区分 stopped 与可恢复终态，第 514 行包含 failed，第 615 行返回 revive。enhanced [extension.ts:1601](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1601) 的 resume 入口检查非空指导并准备 managed resume；[subagent-runtime.ts:478](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:478) 核对 owner、workspace 和合法 resume intent。这条恢复链不以 Goal check 失败为前提。

   **影响：** 首次 child 在验证前失败时，即使 adapter 能证明允许 typed-resume，Goal 也没有失败 check 可供 `plan_retry` 准入。严格实现第 334 行会拒绝恢复，直接放行则违反冻结合同，影响 F4/F5。没有 task checks 的合法任务尤其明确。

   **最小修订：** 保留五工具设计，将 `plan_retry` 明确分成两种准入：失败 check 关联任务的修复；当前 attempt 经权威 facts 确认失败、且具备合法恢复路径的续跑。后一种不要求 check receipt，仍须核对 revision、原合同、非空指导、无 live attempt，以及 T3 的授权和绑定条件。unknown、stopped、manual-integration 不因此放宽。同步第 314、334 行和 T4，并将“验证前失败、无 check receipt”的场景列入 T8 待授权验证矩阵。

2. **高严重性：append 失败后的 branch 不能直接当作持久化事实，当前 reload 恢复合同缺少这一处理。**

   **计划位置：** [第 448–451 行的 T2 合同](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:448) 要求 append 失败不更新内存事实、成功后回查 branch；[第 372 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:372) 则规定 session_start 从 `getBranch()` 恢复最新合法快照。第 444 行的恢复接口只接收 branch 和 sessionId。

   **生产证据：** Pi 1.4 的 [session-manager.js:815](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:815) 在 `_appendEntry()` 中先更新 `fileEntries`、`byId`、`leafId`，然后调用 `_persist()`；写盘异常没有回滚这些更新。[getBranch():1062](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:1062) 读取的就是内存索引。[agent-session.js:2998](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:2998) 的 `/reload` 重建 extensions，但保留同一个 SessionManager，并再次发出 session_start。

   **影响：** 一次真实写盘失败可以留下结构合法、但未持久化的 Goal entry。旧 store 即使正确拒绝更新自身内存，reload 后的新 store 仍可能从 branch 恢复该条目。例如失败的 completed 快照会重新被接受；随后真正进程重启又得到不同状态。evidenceId、payload hash 和 branch 唯一匹配只能确认条目身份，不能解决这个持久化差异，影响 F3/F5。

   **最小修订：** 在 T2/T7 明确区分“当前 branch 可见”和“已持久化”。append 抛错后使当前 store 阻塞，不允许仅凭 branch 回查解除；reload 恢复时需对选中的 state/evidence 及引用链增加现有 session 文件的持久化核验，或使用经过验证、能提供等价保证的 Host 能力。无法确认时保持 blocked。仍只使用现有 session 存储，不新增资源账本，也不回滚或改写原始 session。将“底层写盘失败但内存 entry 已插入，随后 reload/restart”的场景补入 T8 待授权矩阵，避免仅用“append 在任何变更前抛错”的 mock 验证。

其余重点核对项可以通过本轮静态审阅：

- **DAG 与写路径合理。** T2/T3/T5 可在 T1 后并行；T4 无须等待 T5，注入接口避免隐式依赖；T6/T7 共享文件有顺序依赖。引用的既有检查文件均实际存在。
- **T3 已覆盖 package 出口同步。** [第 459 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:459) 明确包含 manifest、verify-package 和既有测试断言，覆盖了 [verify-package.ts:174](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/scripts/verify-package.ts:174) 的精确 exports 校验。`./execution` 是新增交付物，不是假路径。
- **派发与资源边界正确。** 普通 coding child 沿用 standalone owner；外层完整派发闭包与低层 `worktree:false` 不冲突。await allocation/binding 回调、unknown 不重派、proof/集成回执/released 分别核对、no-payload 和人工集成接管边界均已明确。
- **T5 的正常取证路径正确。** [第 346 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:346) 已使用 `outcome.result.structuredContent.exit_code`，没有误用 outcome 顶层或 `details.exit_code`。nested tool 无独立 transcript entry、证据 entry 回查、候选漂移失效、完成前复验均已覆盖；上述第二项专指持久化失败后的恢复。
- **生命周期与 F9 范围完整。** compact 成功/失败、明确 cancel、switch/shutdown、旧 generation、fork/tree、队列优先及一次 continuation 均有对应合同。T7 写路径覆盖现有 context usage 的实现、reminder、文档和三个测试消费者；保留观测、退役手工 handoff，不误删 integration handoff。
- **配置与授权边界明确。** 自有配置默认关闭、child guard、model-only/sequential 工具及 bash 调用边界均已声明。用户撤回 resume 换模型已落实，不构成缺陷。

通用 managed resume 修复已落盘，主会话提供了类型检查和既有 56 测试通过的信息；本轮没有复跑，也不据此认定 fresh Host 恢复通过。计划应继续保留该运行门槛，可将第 80 行环境说明同步为“修复已落盘、静态及既有检查通过、fresh Host 待验证”。

下一步由主会话修订上述两处合同，再按现有用户执行方式选择流程推进。本次结论不构成实现、新增测试或 Host/provider 验证授权。
