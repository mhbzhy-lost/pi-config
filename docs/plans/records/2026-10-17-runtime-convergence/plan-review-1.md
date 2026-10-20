# Runtime 收尾计划首轮 Review（2026-10-17）

- Reviewer run：`c11bc121-9a61-4369-a819-903a2b037f59`。
- 对象：`docs/plans/2026-10-17-runtime-convergence-policy-closeout.md` 的首稿，1283 行、29 个 DAG 节点；下方行号属于审阅时快照。
- 判定：0 Critical、5 Important、3 Minor，需父会话 inline 修订。仅此轮自动计划 review；该报告不代表修订稿已经复审，也不授予实现、测试编写或额外 review 权限。

总体判定：**范围与修复方向正确，但尚不宜按原稿直接派发全部实现节点。** 本轮没有发现 Critical；确认 **5 项 Important、3 项 Minor**，主要集中在 T22–T26 的持久化接口、错误传输、无 payload 判定和任务划分。应由父会话 inline 修订这些位置，再按既定流程交用户选择执行方式；本报告不构成实施或第二轮审阅授权。

已完整分段读取计划 **1283 行**、全部指定输入及当前 handoff；源码只针对计划主张定向核对。静态检查确认：**29 节点无环、Wave 与 Deps 一致、唯一叶节点为 T18**。当前 HEAD 为 `92b0302`，暂存区为空。本轮未修改文件、创建测试或启动 Host/provider/network/kill。

**Important 1：T25 的持久化方案缺少必改 schema 文件，无法在现有 WritePaths 内落实。**

- **路径／计划行号：** [计划:1064](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1064)、[计划:1167](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1167)、[计划:1190](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1190)。
- **证据：** 计划要求先在 workspace 侧建立 durable pendingAction/settlement identity，再写 coordinator intent，随后支持无 raw token 重放。但 [ledger.ts:305](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/ledger.ts:305) 对 pendingAction 使用精确六字段校验，只接受 `integrate/discard/preserve`；record 顶层同样精确校验。现有 pendingAction 没有 `settlementId`，也不支持 `release`。T25 未声明 `ledger.ts` 写权限。
- **影响：** 增加字段会被 `MANAGED_WORKSPACE_SCHEMA` 拒绝；只把 identity 写在 coordinator 侧，则覆盖不了“workspace prepare 已落盘、coordinator intent 尚未落盘”的首个崩溃窗口。不能把该窗口降级为重新取 token 或人工拼台账。
- **最小修订：** 在 T22 明确 workspace 侧持久化结构及旧记录读取策略，把 `src/workspace/ledger.ts` 加入对应实现节点。冻结 prepare 的原子写入内容：已接受的绑定与证明、结算身份、动作和执行 HEAD；明确 release 使用何种结构。恢复必须能发现 workspace-only 的已授权准备记录，并校验后补建同一 coordinator intent。不要通过放宽整个 record schema 或借用无关字段容纳结算数据。

**Important 2：T26 要求保留公共错误码，但现有 coordinator transport 会丢失错误结构，相关文件未纳入实施范围。**

- **路径／计划行号：** [计划:1211](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1211)、[计划:1234](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1234)。
- **证据：** [coordinator-server.ts:487](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:487) 只序列化 `error.message`；[coordinator-protocol.ts:36](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/coordinator-protocol.ts:36) 的 Reply 只允许字符串 `error`；[coordinator-client.ts:62](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/coordinator-client.ts:62) 将失败重建为普通 `Error`。public tool 则依赖 `error.code/detail/keypath`。
- **影响：** 改走 coordinator 后，`CHILD_OWNS_INTEGRATION`、`MANAGED_WORKSPACE_TERMINAL`、状态允许动作等可能统一退化为 `MANAGED_WORKSPACE_ERROR`，无法满足计划要求的既有拒绝语义。只给 tool 增加 `await` 无法修复。
- **最小修订：** T22 冻结兼容现有字符串错误的结构化错误投影，明确允许的 `code/detail/keypath` 字段；把 `coordinator-protocol.ts`、`coordinator-client.ts` 及 server 编解码修改纳入精确 WritePaths。客户端恢复错误属性，tool 按原有公共错误合同返回。保留已有 `binding.register` 的 dispose/release operation，无需另造调用协议或扩大角色权限。

**Important 3：自动 no-payload 结算的比较基线不够明确，存在把有效提交判为空交付的实施歧义。**

- **路径／计划行号：** [计划:1070](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1070)、[计划:1193](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1193)。
- **证据：** T22 写“clean/无提交增量”，T25 改成“相对授权基线没有 payload”。实际 queue 的 `authorizedWorkspaceHead` 会在 child 提交后刷新，见 [coordinator-server.ts:173](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:173)。此外，[git-worktree.ts:299](/Users/leshi.zhy/pi-config/packages/pi-subagents-enhanced/src/workspace/git-worktree.ts:299) 的 `hasCommits` 要求提交数和净变更文件数都大于零，因此 `hasCommits === false` 不等于“没有提交”。
- **影响：** 若把当前授权 HEAD 当作基线，或仅检查 `!hasCommits`，带未发布提交的 clean workspace 可能被自动 cancelled/released；删除 managed branch 后会丢失正常提交引用。这与计划“有未发布提交保留现场”的要求冲突。
- **最小修订：** 在 T22 固定首批自动 no-payload 条件，例如可信 terminal、精确绑定、clean、`HEAD === request.baseCommit`、提交增量为零，并再次校验执行 HEAD。明确禁止用可变 `authorizedWorkspaceHead` 或单一 `!hasCommits` 替代。净 diff 为零但存在提交、HEAD 已变基、已有 integration intent 的情况单列保留／人工合法处置分支，不能落入自动空交付删除。

**Important 4：T21 混合前置诊断与修复后真实处置，形成验收反向依赖，且后置执行落点不明确。**

- **路径／计划行号：** [计划:1010](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1010)、[计划:1037](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1037)、[计划:1047](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1047)。
- **证据：** T21 明确把现场处置放到“修复后的受控 Host 验收阶段”，验收又要求本次工作区最终 public 处置或工具阻塞证据；但 T22→T23→T25 的修复链依赖 T21。T27 只规定 synthetic Roots／临时 Git 验证并记录真实工作区是否有出口，T16 也未明确承担该现场的处置动作。
- **影响：** 若把最终处置当作 T21 完成条件，会反向等待其后继；若用当前阻塞报告完成 T21，则修复后真实处置容易无人承接。静态 DAG 无环不能消除这两种执行歧义。
- **最小修订：** 将 T21 完成条件限定为基线、已知／未知事实及 H2/H3 输入归档；把“修复后尝试真实 public 处置”明确放入后置步骤，依赖 T19 的接口可用性结论和修复链结果，并单列资源授权、同 owner 身份与当次 token 条件。无合法同 owner 出口时保留 `blocked-recovery`，不为销账换 owner 或删除现场。

**Important 5：T25 仍是多阶段大任务，且建议恢复验收依赖的部分故障注入点尚不存在。**

- **路径／计划行号：** [计划:99](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:99)、[计划:1163](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1163)、[计划:1202](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1202)、[计划:1263](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:1263)。
- **证据：** T25 同时承担 service prepare/apply、结算记录存储、queue 精确终结、普通／recovery 路由、proof outbox、handoff 收尾与启动重放。现有 fault 回调虽可复用，但实际调用点主要属于 publication 或旧 dispose；现有 queue 测试的 crash phases 是 `after-prepared/after-intent/after-merge/before-queue-complete`，没有新 settlement 的“queue 已提交但结算 receipt 未写”等完整阶段。
- **影响：** 原稿把设计、多个状态机实现和恢复接线塞进一个 coding 派发，不符合自身约定的精确变更／约 30 分钟粒度；T27 也不能直接靠“已有 hook”证明新增崩溃窗口。
- **最小修订：** 将 T25 至少拆为有明确接口产物的三步：workspace durable prepare/apply；queue settlement／receipt 与 handoff 关闭；server 普通／recovery／proof／启动接线。同步更新 Deps、Wave 和 T27 前驱。复用现有 fault 回调机制，但在实现合同中明确新增结算阶段的注入位置；测试编写仍全部保持建议待授权。启动接线还应覆盖 `EADDRINUSE` 后重听分支，并明确重放完成前如何阻止相关新 mutation 进入。

**Minor 1：M4 尚未被显式映射，R13/R14 的回填顺序也容易反置。**

- **路径／计划行号：** [计划:134](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:134)、[计划:886](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:886)。
- **证据：** 原成果 review 的 M4 是 `scope-unverified` 可能扩大 steer 阻断范围与 inspect 缺失之间的语义张力；计划覆盖 clear blocked，但未显式保留这一项。T17 将“R13/R14”与“T10/T11”并列，实际对应应为 **R13→T11 ceiling，R14→T10 resource-isolation**。
- **影响：** 最终矩阵可能只保留 clear 缺口而漏掉 M4 的行为边界，或回填错误证据。
- **最小修订：** 在 T0/T17 增加 M1–M9 显式映射；M4 归 T6/T13 记录现行 fail-closed 张力及解阻条件，不扩大成自动放宽 gate 的实现任务。写明 R13、R14 的准确对应。

**Minor 2：T11 对既有检查增加了笼统的再次授权要求。**

- **路径／计划行号：** [计划:656](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:656)。
- **证据：** “运行已有定向命令前取得验证授权”未限定额外副作用，与全局已区分“既有测试运行／静态检查”和“测试编写授权”的政策不一致。
- **影响：** 执行者可能把所有既有 focused 检查都变成新的询问门禁。
- **最小修订：** 改成先审计该命令副作用；已授权诊断范围内的纯既有检查可执行，只有 fresh Host、真实 provider、危险进程等资源另行取授权。类似 T14 的“类型／身份检查授权后运行”也按同样边界精确化。

**Minor 3：共享写路径治理说明漏列两组潜在并行冲突。**

- **路径／计划行号：** [计划:95](/Users/leshi.zhy/pi-config/docs/plans/2026-10-17-runtime-convergence-policy-closeout.md:95)。
- **证据：** 除已说明的 T4/T24、T8/T9 外，静态交叉检查还发现 T5/T24 共写 `test/supervisor-gate-wire.test.mjs`，T8/T14 共写两份 heartbeat fixture。后两组在测试／fixture 修改获授权后可能同时进入写入阶段。
- **影响：** 使用共享 checkout 时可能互相覆盖；分别隔离后仍需验证集成版本包含两边语义。
- **最小修订：** 补入写冲突表，规定隔离集成或精确子合同／短时文件互斥。无需为此给整条业务分支增加伪依赖。

本轮已通过的范围与方法判断如下：

| 核对项 | 判定 |
|---|---|
| 已完成／blocked／deferred 边界 | 保留 closeout、S0–S6、用户后验；clear、idle、triggerTurn、resume(model) 未被悄然重开 |
| H1 与 T24 | 两处 `intentId: toolCallId` 和 Responses `call_id\|item_id` 来源吻合；版本域、JSON 编码、69 字符结果满足现有安全 ID 范围；原 Host ID 保留要求正确 |
| M1 与 T5 | 准确覆盖 saveRoot 与事务重载前内存失效两处；没有误写成关闭 root 删除 durable 去重事实；明确考虑 receipt 掩盖 guard 缺失 |
| H2 与 T23 | 不止删除 shortcut，还要求合法 public 内部授权、统一 proof resolution、保留 unbound orphan 出口，方向可执行 |
| H3 总体架构 | 复用已有 client 和 binding operation、由 coordinator 收口 queue、区分跨 ledger 阶段，方向合理；需要修复上述具体缺口 |
| code_mode | 复用已证 model-only 边界，没有 ALL_TOOLS fallback、模型／child 权限扩张 |
| runtime 政策清理 | T3/T3E/T4 保留通用 criteria 与真实性标准，没有新建技术测试授权系统；三个外部个人 skill 路径存在，不因仓外而误判未授权 |
| schema／历史 incident | strategy 投影根因保持 unknown；H1 已证代码缺陷与本次历史失败是否同因分开 |
| T27 授权 | 测试均为建议，未运行须记 not-run；未以计划选择或既有测试通过替代测试编写授权 |

本轮未验证真实 workspace／queue 当前内部状态、真实 provider schema 投影、Host 运行行为、恢复故障序列及外部 skill 的 dirty 内容。这些不影响上述源码与计划冲突的结论，也不能据此声明三个 High 已修复或行为已验收。已核对的现有源码／测试路径真实存在；新 helper、facade、settlement 模块及新增记录属于计划创建项，不作为假路径报告。
