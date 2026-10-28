首轮审阅结论：**当前计划尚不具备直接执行条件：发现 1 项 Blocker、4 项 High、1 项 Medium。** 核心问题是生产 Host 仍只连接 session cwd 对应的单个 coordinator；仅修改 Goal 的任务 cwd，无法完成多仓库集成与恢复。

1. **Blocker｜生产 coordinator 接线不支持非 git 超级根，T2/T3 写路径不足。**

   **路径：**计划 [第 128 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:128)、[第 153 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:153)、[第 161 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:161)。

   **证据：**真实 Host [subagent-runtime.ts:395](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:395) 用 `sessionManager.getCwd()` 初始化唯一的 `coordinatorRuntime`；[第 54 行](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:54) 遇到非 git cwd 直接返回 `undefined`。随后 [第 510 行](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:510) 的 `planExecution.inspect` 强制要求该 coordinator，否则返回 `PLAN_EXECUTION_FACTS_UNAVAILABLE`。C 修复的持久 proof 重建也在这里，依赖同一个 coordinator 的 workspace/integration 事实。`broker.coordinatorRequest`、`recordTerminalProof` 则是 [第 120 行起](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/extensions/subagent-runtime.ts:120) 绑定的单仓库闭包。

   **影响：**`executeCoding` 接受独立 cwd 的事实成立，但它只证明可以选定分配来源，不能证明超级根 Host 的集成、proof delivery、inspect、typed resume 和新 Host 恢复可用。T3 修改 continuity/index 无法修复这个生产入口；逐仓库重复调用现有连接函数还会覆盖 broker 回调。

   **最小建议：**将生产 Host 的仓库路由纳入一个明确任务及 WritePaths：复用既有 coordinator 协议，按可信 workspace/run 的仓库身份选择连接，覆盖集成、proof、inspect、resume 和关闭清理。保留“不改证明及集成语义”，撤销“不改 subagent 包”的绝对限制；不要新增第二套账本或状态机。

2. **High｜writePaths 的超级根坐标与 child 仓库坐标未转换，显式 repoId 规则仍有歧义。**

   **路径：**计划 [第 79 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:79)、[第 135 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:135)。

   **证据：**当前 [scheduler.ts:511](/Users/leshi.zhy/pi-config/src/goal-runtime/scheduler.ts:511) 原样传递 `task.writePaths`；[extension.ts:981](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:981) 再原样形成 workspace policy；[git-worktree.ts:263](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:263) 将它与仓库相对 changedFiles 匹配。

   **影响：**计划路径 `repoA/src/a.ts` 配合 `cwd=/super/repoA` 后，policy 仍会授权 `repoA/src/a.ts`，正常修改 `src/a.ts` 会被拒绝，或 child 按提示创建错误的重复目录。显式 `repoId=A` 时，“只排除其他仓库前缀”也没有明确 `src/a.ts` 与 `A/src/a.ts` 的不同解释；合法的仓库内目录名恰好等于另一个 repoId 时会误拒绝。

   **最小建议：**冻结一种确定文法，例如：无 repoId 时所有路径必须带同一仓库前缀，派发投影剥除一次；有 repoId 时所有路径均按该仓库相对路径解释，并校验 repoId 存在。原合同及其 hash 保持原值，child prompt、dispatch writePaths、policy 使用一致的派生投影。明确拒绝混用及剥除后非法路径。

3. **High｜复合主体的类型、持久化解码和完成判定没有任务承接，T1/T2 并行仅在文件层面成立。**

   **路径：**计划 [第 98 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:98)、[第 104 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:104)、[第 126 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:126)。

   **证据：**`GoalSubject` 和 `CaptureSubject` 实际定义于 [contract.ts:58](/Users/leshi.zhy/pi-config/src/goal-runtime/contract.ts:58)、[第 138 行](/Users/leshi.zhy/pi-config/src/goal-runtime/contract.ts:138)，后者只接受字符串。持久化 [session-state.ts:373](/Users/leshi.zhy/pi-config/src/goal-runtime/session-state.ts:373) 精确解码三个旧字段，会拒绝新增 `repositories`；receipt 与 evidence 均调用它。调度器 [第 623 行](/Users/leshi.zhy/pi-config/src/goal-runtime/scheduler.ts:623)、[第 650 行](/Users/leshi.zhy/pi-config/src/goal-runtime/scheduler.ts:650) 仍向捕获函数传超级根字符串，[第 626 行](/Users/leshi.zhy/pi-config/src/goal-runtime/scheduler.ts:626) 手工比较旧三个字段。

   **影响：**T1 仅能修改 verification.ts，无法兑现新签名、主体落盘与旧主体恢复；即使捕获成功，证据可能在写入前被拒绝，最终完成判定仍可能对非 git 超级根执行 Git。T0 目前只安排 binding 扩展，T2 只安排派发，遗漏这些改动。

   **最小建议：**T0 先冻结新旧主体类型、捕获接口及 session 解码；T2 明确承担两处捕获调用和候选比较迁移。接口冻结后再允许 T1/T2 并行，或改为串行。保留 v1 单仓库原算法和原主体可比性是必要的；`pathsByRepo` 还应明确只选择涉及仓库，仓库内部继续覆盖 v1 的完整 Git 可见候选，避免误缩成 writePaths 范围。

4. **High｜旧 binding 的兼容策略会与现有同计划重入判定冲突。**

   **路径：**计划 [第 77 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:77)、[第 78 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:78)、[第 80 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:80)。

   **证据：**计划要求新单仓库 binding 也写入长度为 1 的 `repositories`，旧记录则无该字段。当前 [scheduler.ts:326](/Users/leshi.zhy/pi-config/src/goal-runtime/scheduler.ts:326) 用 `JSON.stringify(existing.binding) !== JSON.stringify(binding)` 拒绝重入；[session-state.ts:1266](/Users/leshi.zhy/pi-config/src/goal-runtime/session-state.ts:1266) 禁止本代改写 binding。另外 [contract.ts:283](/Users/leshi.zhy/pi-config/src/goal-runtime/contract.ts:283) 的 `exactKeys` 将 allowed 中每个键都视为必填，[第 678 行](/Users/leshi.zhy/pi-config/src/goal-runtime/contract.ts:678) 对解码后的完整合同计算 hash。

   **影响：**仅“缺字段时按 v1 解释”不足以保证兼容：恢复旧计划后再次 `plan_execute`，新旧 binding 仍不相等。若把推导 repoId 填回合同，或将 repoId 简单加入必填键集合，也会导致旧合同 hash 改变或旧计划被拒绝。

   **最小建议：**明确区分持久化原值与运行时归一化视图，更新 binding 重入等价判定；旧记录不回填改写。repoId 使用真正可选的严格解码，缺省时不产生新键、不进入旧合同 hash；推导归属只存在于运行时视图。增加“旧 session 恢复后重复 execute”及旧 hash 固定值的兼容验收。

5. **High｜三个测试 WritePaths 均不存在，执行会违反“不新增测试文件”。**

   **路径：**计划 [第 38 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:38)、[第 179 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:179)。

   **证据：**实际文件是 [goal-runtime-contract.test.mjs](/Users/leshi.zhy/pi-config/test/goal-runtime-contract.test.mjs)、[goal-runtime-runtime.integration.mjs](/Users/leshi.zhy/pi-config/test/goal-runtime-runtime.integration.mjs)、[goal-runtime-rpc.integration.mjs](/Users/leshi.zhy/pi-config/test/goal-runtime-rpc.integration.mjs)。计划列出的三个 `.ts` 文件均不存在。T1 第 100 行引用的 `src/subagent-diagnostics/git.ts` 也不存在；当前 verification 自带只读 Git 调用。

   **影响：**按 WritePaths 执行只能新增错误文件，或越界修改真实测试；既有回归不会按计划被扩展。

   **最小建议：**统一更正为真实三文件及对应运行命令；T1 引用现有 verification 实现即可。同时修正任务编号：测试扩展是 T4，真实 smoke 是 T5；第 92、121、147、168、169 行的 T5/T6/T8 引用存在错位。

6. **Medium｜smoke 的最低要求不足以证明声称的并行、恢复和五工具全链。**

   **路径：**计划 [第 206 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:206)、[第 208 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:208)、[第 231 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-27-goal-runtime-v2-multi-repo.md:231)。

   **证据：**T5 将并行写成“可并行”，恢复写成 compact **或**新 Host，单仓库只复跑 positive。现有探针 [第 152 行](/Users/leshi.zhy/pi-config/scripts/probes/goal-smoke.ts:152) 设置 A→B 依赖及容量为 1 的 writer，[第 178 行](/Users/leshi.zhy/pi-config/scripts/probes/goal-smoke.ts:178) 设置 `maxConcurrentTasks:1`；现有 compact 场景 [第 290 行起](/Users/leshi.zhy/pi-config/scripts/probes/goal-smoke.ts:290) 实际组合了真实压缩与换 PID 重启。T5 没有要求 checkpoint 或 retry 的成功真实回执。

   **影响：**顺序正向运行、仅同 Host compact 就可能被标成通过，却未覆盖最关键的跨仓库 coordinator 路由及 C 修复；也不足以支撑“五工具全链真实通过”。

   **最小建议：**在既有探针中固定要求一次 A/B 运行重叠并验证各自 origin、proof、receipt；组合真实 compact 与新 PID 恢复，核对两个仓库的旧 run facts。补充 checkpoint/retry 的明确实证，或收窄验收措辞。涉及 Host 恢复接线后，单仓库至少复跑对应 compact/resume 场景，不能只依赖 positive。

接口核对补充：计划引用的 `index.ts:302`、`scheduler.ts:512` 行号准确。实际类型名是 `GoalTask`、`PlanBinding`、`GoalState`，hash 接口是 `hashPlanContract/contractHash`；`executeCoding` 位于 [extension.ts:1028](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1028)，`execution/index.ts` 是服务接口及注册表。DAG 本身无环，T0/T3 对 index.ts 的写入已有依赖隔离；需要修正的是共享接口交付顺序。跨仓库任务仍须遵守全局 resources 容量，不能因仓库不同绕过现有互斥。

本轮仅做源码与计划对照，没有修改文件、运行测试或启动真实 provider；上述建议均限于既定多仓库目标。