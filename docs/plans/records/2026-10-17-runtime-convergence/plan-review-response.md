# Runtime 收尾计划首轮意见处理记录

- 日期：2026-10-17。
- 首轮 reviewer：`c11bc121-9a61-4369-a819-903a2b037f59`。
- 审阅原文：[plan-review-1.md](plan-review-1.md)。
- 修订对象：[技术执行计划](../../2026-10-17-runtime-convergence-policy-closeout.md)。
- 处理方式：主会话 inline 修订；没有自动派发第二轮 review。以下“已修订”仅指计划文案和执行合同，不表示生产修复、行为验证或复审已通过。

| 意见 | 处理 | 修订落点 |
| --- | --- | --- |
| Important 1：严格 ledger schema 无 settlement identity/release，WritePaths 缺失 | 已修订。保留 ledger.v2 顶层键；pendingAction 增加精确可区分子格式，冻结原子 prepare 字段和旧六字段合法读取策略；workspace-only prepare 可被恢复发现并补建 coordinator intent，不依赖 raw token | T22、T25A、T25B；明确加入 ledger.ts |
| Important 2：coordinator 丢失公共错误结构 | 已修订。保留字符串 error，并加入严格可选 errorInfo；只投影 code/detail/keypath，状态 detail 结构固定。server 编码、client 还原、protocol schema 和新 codec 明确分工；不扩角色/operation | T22、T29、T25C、T26 |
| Important 3：no-payload 基线含糊，可能删除有效提交 | 已修订。自动判定固定为匹配可信 proof/binding、clean、HEAD=request.baseCommit、descendant 且 aheadCount=0、无 sequencer/integration intent/receipt；执行前再核 HEAD。可变 authorizedWorkspaceHead 和 !hasCommits 均禁止作替代，零净 diff 但有提交保留 | T22、T25A、T25C、T27 |
| Important 4：T21 存在修复前后反向依赖 | 已修订。T21 仅做前置事实/缺陷归档；新增 T28 依赖 T16/T19，主会话在合法同 owner、当次 typed token 和接口可用时处理真实现场，无出口则明确 blocked-recovery | T21、T28、DAG/Waves |
| Important 5：T25 太大且新增故障点未定义 | 已修订。拆为 workspace prepare/apply、queue settlement/receipt、server/recovery/proof/listen 接线三节点；明确新增 fault phase 与 readiness 屏障；普通 listen 与 EADDRINUSE 后重听共用恢复流程 | T25A、T25B、T25C、T27、DAG/Waves |
| Minor 1：M4 未显式映射，R13/R14 易反填 | 已修订。新增 M1–M9 对照；M4 保留 scope-unverified fail-closed 张力和 inspect 缺失，禁止自动放宽 gate；固定 R13→T11 ceiling、R14→T10 resource-isolation | T0、T6、T13、T17 |
| Minor 2：既有检查被笼统要求再次授权 | 已修订。副作用审计后的既有纯检查可在已授权诊断范围内执行；只有写测试/fixture 行为和额外真实 Host/provider/危险实验遵守相应授权，既有运行不授予写测试权限 | T11、T14、全局约束 |
| Minor 3：共享写路径漏列 | 已修订。补 T5/T24 的 supervisor wire 文件、T8/T14 的 heartbeat fixture、T4/T24 的 extension 与 T8/T9 的 provider；使用隔离集成或精确子合同/短锁，不给整条分支造假依赖。T25C 消费 T29 的实际 codec 接口后再写同 server | 并行写冲突表、T25C Deps |

修订后的计划有 33 个 DAG 节点。测试编写和测试专用 fixture 行为修改全部保留为建议、待用户明确授权并回填“已授权”；选定执行方式不自动授权这些步骤。现有纯检查、类型检查和静态核对独立处理。

首轮修订时的父会话静态自检：33 节点无环、无未定义节点引用；Wave 与 Deps 一致，唯一最终叶节点是 T18；各节点的 WritePaths/Resources/Files/接口契约齐全；六份规划文档无尾随空白，`git diff --check` exit 0。计划当时共 1430 行，SHA-256 为 `40fea3c3bdc03829cd941627f5973d0b7b94518da00080fe8c63e931b06580ae`。这是该稿的计划结构检查，不是 production 行为测试或修订稿再次 review。其后用户单独授权并完成 footer 空行调整，计划只同步其当前进度，以上 hash 保留为首轮修订快照，不作为最新文档 hash。

本轮只更新计划和规划证据；生产代码、测试、当前 Host、真实 managed workspace、原 dirty handoff、crashes 文件和 models 备份均未由本轮修订改动。整批执行方式仍待用户选择。
