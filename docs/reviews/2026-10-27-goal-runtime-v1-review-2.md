# Goal Runtime v1 二审：闭环与复杂度

日期：2026-10-27。以下为用户明确授权二审的原始结论；主会话据此修订，不表示实现或新增测试获准。

**结论：修订后闭环。** 当前设计已具备轻量 v1 的实施基础，没有发现必须恢复旧 Goal Engine 抽象才能解决的核心问题。一审两项 High 已得到实质修订；本轮仍发现四处需要明确的推进合同，其中前两处会让正常可恢复流程停住。建议主会话 inline 补齐这些边界，保持八任务、五工具和单 session 存储。

以下问题属于计划合同缺口；尚未实现的模块本身不构成缺陷。

1. **High｜检查失败后的资源释放及修复任务可达性未闭合。**

   **路径：** 计划 [249 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:249)、[331 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:331)、[338 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:338)。

   **触发时序与首个偏离点：** A、B 是独立任务，共用容量为 1 的资源 R；A 的任务检查 C 指定 `repairTaskIds:[B]`。A 已取得成功 proof、集成回执并释放 workspace，进入 verifying，占用 R；C 失败。计划允许修复 B，却没有规定失败后 A 如何退出 verifying、何时释放计划资源。若按“verifying 期间仍计入占用”保留 A，B 永远无法取得 R。另一种合法引用是 B 依赖 A：A 等 C 通过才能 accepted，B 又等 A accepted 才能修复 C。普通 DAG 无环检查不能发现这条修复循环。

   **Authority／影响：** Goal policy 有权管理计划资源与任务阶段；原 runtime 的 workspace 已释放，不能替 Goal 消除这个业务自锁。严格校验资源／依赖会拒绝 `plan_retry(B)`，放行则违反现有合同，影响 F2/F4。

   **最小改法：** 明确一次检查结束失败后，任务进入 blocked，保存失败原因；检查执行期间的计划资源占用结束。实际 live／unknown／integration 债务仍按权威事实保留，不因业务 blocked 擅自释放。契约校验再保证任务检查至少有可达的修复归属；最简单的 v1 限制是任务级 check 必须包含本任务作为修复入口，禁止只能靠受其 accepted 阻挡的下游修复。终态 checks 可继续关联多个已交付任务。无需增加修复状态机。

2. **High｜“允许恢复”已补齐，但失败与无 live 的 pending 状态还缺明确的下一动作和唤醒保证。**

   **路径：** 计划 [288 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:288)、[330 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:330)、[367 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:367)、[369 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:369)。

   **触发时序与首个偏离点：**
   
   - child 在验证前失败，没有 check receipt；adapter 已确认可合法恢复。`plan_retry` 现在允许，但 §5.4 请求修复 continuation 的条件仍写“检查失败”，没有覆盖这个状态。没有 ready 任务、active child 或待终态验证时，下一步仍依赖模型自行猜出 retry。
   - 成功 child 的 terminal 通知到达，首次 inspect 看到集成／释放仍 pending；随后权威处理完成。当前源码 [root-broker-server.ts:708](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:708) 先接受 terminal，再启动异步 lease release 和 coordinator proof delivery；[736 行](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/root-broker-server.ts:736) 才等待 delivery 结果。因此原 terminal／completion 通知不证明最终资源事实已经可接受。计划尚未规定这次后续变化由谁再次唤醒，`subscribe` 的函数签名本身也不提供该保证。

   **Authority／影响：** adapter 才能确认 proof、integration 和资源状态；Goal 可以请求下一模型回合，但不能推断资源闭合。只等待已消费过的完成通知，可能长期挂住；反复请求 continuation 又会把正常异步处理变成空转，影响 F4/F5/F6。

   **最小改法：** 给 `decideNextAction` 补一个小型穷举规则：权威失败且可恢复 → 提示主 agent 提供指导并调用 `plan_retry`；任务待检查或 stale → `plan_verify`；有明确处理者且尚在执行的资源 pending → 等待对应完成通知；没有处理者／唤醒来源 → blocked，列出事实与现有 typed 诊断入口。T3 的订阅合同明确覆盖绑定完成及 proof delivery／集成释放结果可见后的复查，订阅建立后立即 reconcile 一次。优先在现有 Host 异步闭包完成处发一次失效通知；不新增轮询 daemon，也不让通知直接派发。

3. **Medium｜typed-resume 的准入条件与执行后置条件写成了循环。**

   **路径：** 计划 [303 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:303)、[339 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:339)。

   **触发时序与首个偏离点：** inspect 需要返回 `recovery:"typed-resume"`，resume 才可调用；但第 303 行又要求“该分类必须证明新进程的 Host 授权登记与……重绑均已闭合”。新进程尚未启动，无法拥有这些事实。真实控制链在 [extension.ts:1629](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts:1629) 附近先建立 binding waiter，在收到新 binding 后执行 register／activate，随后才返回 resume 成功。

   **影响：** 按字面实现会永远无法进入 resume；把测试曾经成功当成本次授权事实也不正确。

   **最小改法：** 明确区分两个时间点，不增加状态枚举：inspect 准入证明旧 attempt 已终止、身份及合法 pending resume intent 有效，且当前 Host 接线具备执行能力；resume 返回和 `onBound` 则必须证明**本次新进程**授权、workspace／queue 重绑完成。任一步失败仍 blocked／unknown。当前类型检查与既有 56 测试只能作为已有验证信息，fresh Host 门槛继续保留。

4. **Medium｜严格磁盘核验需要明确豁免正常“尚无 Goal 的空会话”。**

   **路径：** 计划 [379 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:379)、[451 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:451)、[572 行](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:572)。

   **触发时序与首个偏离点：** fresh Host 打开普通新 session，触发 session_start，但用户尚未发送消息。Pi [session-manager.js:786](/Users/leshi.zhy/pi-config/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js:786) 的 `_persist` 合法地延迟建文件，直到出现 user／assistant message。若按“缺文件均 blocked”初始化并设置不可写状态，后续第一次 `plan_execute` 就可能被拒绝，直到重新初始化。

   **影响：** 把正常默认 session 行为误认为恢复失败，给首次使用增加不必要的死路。计划虽已要求区分“无记录”和“无法证实”，但尚缺这个具体分支。

   **最小改法：** 明确 branch 无 Goal entry、且属于正常尚未落盘的新持久会话时，restore 返回 null，不创建 Goal、不设置存储失败 latch；首次执行仍须确认 intent 实际落盘后才派发。已有 Goal entry、已有会话文件异常丢失、解析失败及 `--no-session` 保持严格阻断。无需创建空 session 文件或调用私有 persist。

候选 hash **没有被现有算法必然锁成永远 stale**，但建议补一段收尾顺序，避免实现时自行制造循环：

- 第 251 行的 checkbox 豁免只适用于 `contractHash`；第 347 行的 `contentHash` 仍包含计划正文和未忽略的报告文件。
- 以当前 T8 的 [WritePaths](/Users/leshi.zhy/pi-config/docs/plans/2026-10-26-goal-runtime-v1.md:582) 为例：写验收报告 → 主会话更新计划步骤记录 → 冻结这些仓库写入 → 捕获候选 → 运行只读终态检查 → 将 evidence／completed 写入 session → 在对话中引用最终 receipt。这条顺序可以收敛；本计划仍由现有编排执行，不要求新 runtime 执行自身。
- 如果每次终态检查后又把该次 receipt／输出写回报告，再要求报告包含下一次“当前候选”的最终 receipt，就会每轮改变 hash。应明确报告引用前序实测材料，最终候选的完成权威保留在 session；若必须再改报告，就再验证一次，并停止继续改写。不要为此排除整个 docs 目录或另建证据存储。

可简化但不阻塞的部分：

- 给无进展计数固定采样点：比较一次自动推进后的有效成果，避免把同一失败修复中的 `running → verifying → blocked` 往返当成持续进展。候选只在既定验证点捕获，不为 settle 另加仓库扫描。
- 恢复时完整核验当前分支；普通提交可只确认本次新增条目及其所需引用，复用本代已核验事实。无需每次重新解码全部历史 Goal payload，也无需新增持久 index。
- T8 可以用少量组合场景覆盖：正常并发至完成、无 check 的失败恢复、检查失败并重修 accepted 任务、资源 pending 与重复通知、compact/reload/restart 及写盘失败、暂停与非 Goal 上下文观测。新增测试仍待具体授权；这不否定计划的静态可执行性。

已经足够简单、建议保留的设计包括：五工具没有完成 setter；短写队列之外执行长操作；业务状态与资源事实分属明确 authority；`onAllocated/onBound` 保留可追溯边界；旧证据留存但不作为当前通过依据；unknown／身份／权限／人工集成接管明确未完成；普通会话沿 Pi 默认 compaction，`context_usage` 仅保留观测。

本轮只读，没有修改文件、运行测试、启动 Host/provider 或控制 workspace。F1–F9 的划分可观察、可验收；真实事件唤醒、fresh Host 恢复与磁盘失败时序仍须在获授权后的 T8 取得运行证据。本结论不授权第三审或实现。
