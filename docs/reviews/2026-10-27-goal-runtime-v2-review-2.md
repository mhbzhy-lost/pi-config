**结论：建议先收敛计划再执行。本轮未发现必须推翻方案的 Blocker，但有 4 项 High、2 项 Medium。** 单 broker、多 coordinator 本身合理；风险在于目前只冻结了“需要路由哪些动作”，尚未冻结路由事实来源、workspace service 分仓方式及失败清理边界。直接按当前 DAG 推进，容易到真实 smoke 才同时调试类型、分仓、proof 与恢复。

只读核对了 `~/taoappuse/`：根目录不是 Git 仓库，发现 **23 个直接子 Git 根**，此次枚举未见这些根为符号链接或 linked worktree。当前用户场景可以由“一层普通独立仓库”满足，无需同时解决仓库别名、linked worktree 和动态仓库拓扑。

1. **High｜T3 的薄路由还缺少可执行的身份来源与 service 分仓设计；只替换 broker 回调不够。**

   **路径：**[计划:128](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:128)、[subagent-runtime.ts:395](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:395)。

   **证据：**

   - Host 除唯一 `coordinatorRuntime` 外，还创建带固定 `storageRepositoryId` 的 workspace service，并套上绑定单一 client 的 disposition facade，见 [subagent-runtime.ts:405](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:405)。该 facade 的三种处置直接调用捕获的 client，见 [disposition-facade.ts:14](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/disposition-facade.ts:14)。
   - `coordinator.listOwned` **不是仓库归属证明**：[coordinator-server.ts:426](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:426) 直接转给 service；[service.ts:800](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/service.ts:800) 调用的 `ledger.listScoped` 会遍历所有 repository 分区，见 [ledger.ts:548](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/ledger.ts:548)。因此不能轮询各 coordinator，以“哪个查到 run”选择路由。
   - 可以复用的身份已经存在：`PlanRunRef` 包含 run/workspace/root-session 三元组；workspace receipt 包含 `originRoot`、owner、lease 和 run，见 [execution/index.ts:3](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/execution/index.ts:3)、[service.ts:105](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/service.ts:105)。
   - 关闭已有严格顺序：broker 先排空 integration requests、运行和 terminal proof delivery，再关闭 transport，见 [root-broker-server.ts:1408](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:1408)。仓库连接的现有 `close()` 又会清空全局 broker 回调，见 [subagent-runtime.ts:154](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:154)。

   **影响：**仓库选择、分配分区、处置 client 和 proof outbox 若分别推导，可能出现“workspace 在 A、queue/proof 在 B”的跨层失配。错误 client 的 `listOwned` 仍可能返回记录，不能指望这一层自动拒绝。多连接关闭失败、晚到回调和重载再初始化也不能交由各仓库分别修改全局回调。

   **建议：**把 T3 收敛为一份 Host 生命周期，加按 canonical repository identity 管理的连接上下文：

   - 首次分配从已验证的 request origin 选连接；已有 run 从唯一、同 owner 的持久 workspace receipt 取得 origin，再解析仓库身份。远端查询用于核验选定连接，不能反过来发现归属。
   - 明确分配、处置、inspect、resume、proof 全部使用同一选择结果；不新增持久 run→repo 索引，不扩展 proof 或 `PlanRunRef`。
   - broker 回调只安装、卸载一次；各仓库连接关闭不能清空它们。继续由既有 broker drain 和 shutdown-debt 机制拥有关闭顺序。
   - [T4:148](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:148) 的“每仓库校验 proof/coordinator/receipt/sidecar”应明确为**消费 execution.inspect 的结果**。校验实现仍归 package Host，不在 continuity 再复制一次。

   三种结构对照如下：

   | 结构 | 源码约束与判断 |
   |---|---|
   | 按仓库复制完整既有 runtime | 不推荐。execution 注册按 root session 覆盖，workspace 注册也按 session/API 覆盖；不是天然可并排的仓库实例。见 [execution/index.ts:91](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/execution/index.ts:91)、[registry.ts:86](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/registry.ts:86)。 |
   | 一份 Host＋各仓库既有 coordinator 上下文＋薄路由 | 推荐。Host 的授权、通知、重载、drain 各保留一份；每仓库复用现有 client/server、binding resolver、outbox 与 queue。新增的是连接集合，不需要新增业务生命周期。 |
   | 延迟连接 | 可作为上一种结构的连接策略：首次 dispatch/inspect 时按可信身份建立并复用连接。若含义是“永远只有一个连接，随当前任务切换”，则不适合真实并行及晚到 proof。 |

2. **High｜T0 不是可独立验收的完整增量；T1/T2 的并行仍依赖尚未交付的共享行为。**

   **路径：**[计划:59](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:59)、[计划:102](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:102)。

   **证据：**T0 要改 `GoalSubject` 联合和 `CaptureSubject`，但不能修改主要消费者。现有 [verification.ts:99](/Users/leshi.zhy/pi-config/src/goal-runtime/verification.ts:99) 和 [scheduler.ts:626](/Users/leshi.zhy/pi-config/src/goal-runtime/scheduler.ts:626) 直接访问旧字段；scheduler 两次捕获仍传单个根路径。若新增变体不保留旧字段，T0 独立 typecheck 就要求同步迁移这些消费者。若为通过检查给新变体补虚构字段或放宽类型，又会制造额外兼容形状。

   此外，T0 只说“冻结接口”，尚未明确统一 subject 比较函数的 owner；现有比较分别存在于 verification 和 scheduler。T2 还要求迁移 `GOAL_QUEUED` 重放，但本次在 Goal runtime、execution、相关测试及架构文档中未找到该标识。

   **影响：**独立任务可能各自实现比较、仓库排序和归一化，再在集成时返工；T0 的“绑定可用”验收也早于超级根 Host 支持，容易将局部类型通过误报为端到端可用。

   **建议：**

   - T0 先限定为纯归属规则、binding 最小扩展及旧记录不变；发现放在绑定入口，投影是共享纯函数，避免让 scheduler/verification 反向依赖 `index.ts`。
   - 将 subject 类型、精确解码、捕获和两个消费者的迁移组成一个可 typecheck 的串行增量；或者先交付兼容的单仓库原语及新聚合辅助函数，再迁移公共类型。不要加入过渡持久化格式。
   - 默认采用 **T1→T2**；只有比较函数、捕获输入、成员排序和 binding 等价函数已实际交付后才考虑并行。这里省去一次返工比文件级并行更有价值。
   - 将 `GOAL_QUEUED` 改为真实的持久 dispatch intent/run 恢复入口，不为这个未找到的名称新增机制。

3. **High｜“按 repo root 建连接”与现有 common-dir 权威身份存在边界不一致；应缩小准入，而非扩展别名状态机。**

   **路径：**[计划:51](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:51)、[计划:129](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:129)。

   **证据：**[repository-identity.ts:18](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/repository-identity.ts:18) 用 Git common-dir 生成 coordinator identity，用主 worktree 根生成 storage identity；linked worktree 还返回 migration debt。相比之下，dispatch 的 [defaultCanonicalOrigin:752](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:752) 使用当前 Git top-level。计划目前只约束子目录 realpath 在超级根内，没有排除同 common-dir 的两个子 worktree，也未定义其 repoId 与存储身份关系。

   **影响：**两个目录 repoId 可以对应同一 coordinator；一个超级根内的 linked worktree 也可能对应超级根外的主仓库。按路径建两个连接会让启动、所有权和关闭互相影响，新增的归属映射还可能与实际存储分区不一致。

   **建议：**本版限定直接子目录为 canonical 普通仓库根；对 linked-worktree migration debt、同 common-dir 重复候选及路径别名明确拒绝或排除并诊断。repoId 仅作计划中的目录标识，不能替代既有 `repositoryId/storageRepositoryId`。这能覆盖此次看到的 23 个用户仓库，不需要新增别名迁移、跨根重绑定或额外恢复状态。

4. **High｜验证全部后置，会把最难定位的 Host 接线问题再次留到真实 smoke；当前取证链还有明确缺口。**

   **路径：**[计划:156](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:156)、[计划:175](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:175)。

   **证据：**

   - 当前 runtime 测试用的是 [adapter():27](/Users/leshi.zhy/pi-config/test/goal-runtime-runtime.integration.mjs:27)，RPC 测试也注入 [合成 execution:40](/Users/leshi.zhy/pi-config/test/goal-runtime-rpc.integration.mjs:40)。它们能验证 Goal 消费行为，不能证明生产 coordinator 路由。
   - 计划服务调用 executeCoding 时传入的是空 trace，见 [extension.ts:2192](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:2192)；普通工具调用则有真实阶段 trace。Goal 派发失败容易只剩“启动结果不明”，丢失最有用的首个偏离阶段。
   - 现有 smoke [第 337 行](/Users/leshi.zhy/pi-config/scripts/probes/goal-smoke.ts:337) 仅由 `--keep-artifacts` 决定保留；失败本身不会阻止删除。计划没有固定该选项或失败保留行为。
   - 预算也未对齐：计划写“每实例最多 6 次 assistant”，现探针 [budget():87](/Users/leshi.zhy/pi-config/scripts/probes/goal-smoke.ts:87) 对 child 限 6 次、对主 Host 限 16 次。

   **影响：**T0–T4 全部完成后才发现问题，候选根因会横跨投影、存储分区、连接身份、proof、关闭及 subject。若现场已删，后续只能凭摘要修复，恰好重复 v1 恢复缺陷的高成本路径。

   **建议：**把既有文件内的相关验证前移到所属增量，T5 保留最终联合回归。T3 至少使用真实生产连接装配和既有 coordinator 接口验证 A/B 路由、错身份拒绝、连接失败和关闭顺序；不能以两个 adapter 返回正确 facts 代替。复用现有阶段 trace，不建新日志系统。真实 smoke 固定失败保留证据，成功或归因结束后再清理；先对齐主/child 的预算含义。

5. **Medium｜持久化可以再收窄：应固定参与仓库，避免把发现结果、任务映射和执行事实各存一遍。**

   **路径：**[计划:70](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:70)、[计划:71](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:71)。

   **证据：**计划明确 subject 只覆盖参与仓库，但 binding 的“仓库集”尚未说明是全部发现结果还是实际参与集合。现有 binding 在同代内不可改变，见 [session-state.ts:1266](/Users/leshi.zhy/pi-config/src/goal-runtime/session-state.ts:1266)；重复 execute 又会重新生成 binding。

   **影响：**若把全部发现结果持久化，用户增加一个与计划无关的兄弟仓库，也可能造成 binding 不等价。若每次恢复重扫并重新选归属，原本固定的执行目标又会漂移。

   **建议：**

   - 单仓库继续保留原 binding；多仓库仅保存恢复所必需的、计划参与仓库映射及固定身份，不保存全量目录库存。
   - task→repo、仓库相对 writePaths、标题和 checkpoint 的 repoId 均从原合同及 binding 派生；不新增 TaskState/run/checkpoint 的持久 repo 字段。
   - 保留单仓库 `captureSubject(string)` 的原算法作为内部原语；多仓库聚合复用它。主体只需要“旧单仓库＋一个多仓库封套”两种持久形状，成员复用旧主体字段。
   - 一个共享比较实现供 receipt、scheduler 完成判定使用。复合主体确有必要，不能用伪造的超级根 HEAD 或仅 writePaths 指纹替代。

6. **Medium｜双路径文法可以实现安全，但增加的是用户输入与兼容组合，应先确认是否需要同时保留。**

   **路径：**[计划:52](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:52)。

   **证据：**显式 repoId 使用仓库相对路径，缺省则使用超级根前缀；同一字符串在两种模式下意义不同。规则已经比首轮明确，因此这不是现成的正确性缺陷。但“拒绝混用”不能通过检查路径首段是否等于某 repoId 实现，否则会重新误拒合法仓库内目录。

   **影响：**两种输入模式均需覆盖派发、prompt、policy、重入、retry 和恢复；显式 repoId 还增加合同解码和 hash 的可选字段处理。

   **建议：**如果没有必须支持两种书写方式的用户要求，首版可只支持超级根前缀，运行时推导 repoId，直接省去 `GoalTask.repoId` 扩展；用户当前目录结构可以使用该方式。若维持已冻结的双文法，则只在一个纯解析函数处分支一次，输出统一视图，后续层不再感知模式。显式模式不得启发式剥前缀或猜测用户意图。

   **真实并行 smoke 应保留。**它直接检验共享 broker 的交错回调，价值高于新增路径语法组合；应将并行、恢复和 retry 分成可定位的场景，而非要求所有故障组合同时发生。

首轮六项的核对结果：

| 首轮问题 | 第二轮判断 |
|---|---|
| 生产 Host 单 coordinator | 已增加正确写路径和任务，但尚不能关闭：见本轮 High 1、3，尤其 service/facade 和真实仓库身份。 |
| 路径坐标与显式 repoId 歧义 | 规则层面已解决；需确保只有一次投影，且“混用”不变成目录名启发式。尚无实现证据。 |
| subject 类型、持久化和完成链遗漏 | 覆盖位置已补齐；交付顺序仍不可独立验收，见 High 2。 |
| 旧 binding 重入与 hash | 兼容方向正确：旧形状、不回填、可选键、语义比较；需补充参与仓库集合固定规则。 |
| 假测试路径与 helper | 三个 `.mjs` 文件均真实存在；`src/subagent-diagnostics/git.ts` 仅作为“不依赖它”的说明出现。新 smoke 报告是待产出文件，非假参考路径。 |
| smoke 并行、恢复、五工具不足 | 验收文字已补足；当前探针仍是顺序配置，且存在上述取证、预算问题，不能视为已经验证。 |

建议验收顺序为：**纯归属与旧记录兼容 → Host 单子仓库完整链 → 同 Host 双仓库路由及关闭 → subject 与 scheduler 串行接通 → compact/新 Host 只读恢复 → 真实双仓库并行、checkpoint/retry、单仓库回归。**前几步不需要真实 provider；每步保留 request origin、workspace/lease/run、canonical repository identity、queue/proof/receipt 的对应证据，失败定位到首个失配边界后再修复。

本轮未修改文件、未新增或运行测试、未启动真实 provider。审阅基于包含既有未提交改动的当前工作区；已查看相关 diff，没有覆盖现场。`git diff --cached --name-only` 为空。以上是实施计划审阅，不能替代修订实现后的验收。