# D-CLEANUP-RECHECK：复核历史债务处置安全门

## 范围、来源与结论

本节点依统一 DAG 对 `D-INTERFACE-DESIGN`、`E-PI-ISOLATION`、`L-ORPHAN-WIRING` 三个前驱及指定历史记录作只读复核。只读取仓内报告、`packages/pi-subagents-enhanced/src/workspace/administration.ts` 与 package `exports`；**没有读取 live `var/workspaces`**，没有访问凭据、输出 proofId/runId/token/完整敏感路径，没有执行源码、配置或 live state mutation。

**结论：blocked；不得进入任何历史 proof debt mutation。** D-PROVENANCE 的 529 是冻结快照历史数，不是 live 数；完整身份链可证明清理候选为 0。接口目前只是设计草案，E-PI attention/supervisor transport 未验证，仓外 coordinator-process loader 未证实。用户先前泛指的“方案 B/执行剩余任务”不是针对已识别对象的具体 live mutation 授权。任何单项授权即使另行取得，也不能替代其余安全门。

本次适用 test-driven-development Skill 的纯文档豁免：仅撰写只读验收报告，不改变 production、配置、测试或行为，无可用的 RED→GREEN 实现目标；因此不新增测试。报告以逐项证据门审查和限定路径检查验证。

## 安全门表

| 安全门 | 判定 | 证据文件/事实 | 解除条件 |
|---|---|---|---|
| 权威 provenance（official terminal、root owner、完整事件链） | **未证实** | `D-PROVENANCE.md`：历史快照 529 条；成功 spawn 精确匹配 528 条，但无可核 official terminal 原文/owner receipt 完整链；**完整身份链可证明清理候选 0**，全部 529 来源未证实。`D-AUDIT.md` 同样声明仅基于快照且 fail closed。 | 仅对明确识别的单项，由权威 Host/AuthorityStore、official terminal、同期 owner/workspace/queue/receipt 持久记录核实身份、作用域及事件顺序；缺失则保持 blocked。不得用 reason、缺失 records 或 session 叙述替代。 |
| owner / lease / workspace / terminal / 事件顺序 | **未证实** | `D-PROVENANCE.md`：缺 Host owner receipt、同期 owner-scoped binding、lease/workspace receipt 与 terminal→owner→workspace→queue/receipt 顺序；快照中 P2–P4 records absent 不能推断无绑定。`L-ORPHAN-WIRING.md`：仓外 owner/loader 无证据。 | 对每一项取得可交叉校验的权威 owner、有效 lease/revision、workspace 绑定、official terminal 及 queue/receipt 顺序证据；不能完整证明即不 mutation。 |
| 单项 proof-debt typed API（非 workspace release） | **仅设计** | `D-INTERFACE-DESIGN.md` 提议 get/prepare/apply 与状态/错误形状，明确未来实现 WritePaths；无已实现、TDD 通过的单项 proof-debt typed API。package `exports` 仅含 `./workspace/admin` 等，未见 proof-debt export。 | 另立 coding 任务，先断言级 RED，再实现单项 typed API 并 GREEN；公开导出、类型、校验和调用边界经 review，证明不触发 workspace release。 |
| durable audit-first、幂等 / 崩溃恢复 | **仅设计** | `D-INTERFACE-DESIGN.md` 设计 audit durable、CAS、专用幂等键、intent/execution-unknown 与恢复状态，但未实现。`D-CLEANUP.md` 的 fixture RED（独立审计投影缺失）及既有 workspace cleanup GREEN 只证明 workspace API 既有行为，不证明 proof-debt audit/recovery。 | 建立独立 durable projection/audit；测试 audit 写失败不触发 effect、同 key 幂等/冲突、审计后崩溃及 effect 后回执前崩溃恢复；临时隔离 fixture 真实 RED→GREEN。 |
| 幂等与崩溃恢复测试 | **未证实** | `D-INTERFACE-DESIGN.md` 第 5 节只是未来 fixture 矩阵；报告明确未运行 RED/GREEN。`D-CLEANUP.md` 仅有 workspace release fixture，不覆盖 proof-debt 单项恢复。 | 对 proof-debt typed API 在临时 origin/state/coordinator 下逐项 RED→GREEN，覆盖重放、冲突、崩溃点、外部 effect 结果未知；确认无 live 依赖。 |
| 隔离真实 Pi lane | **未证实** | `E-PI.md`：attention lane 超时，真实 supervisor lane 未验证，环境受限。`E-PI-ISOLATION.md`：未运行 attention；隔离启动门尚未证明，结论 BLOCKED；普通 RPC 窄子集通过不等于 attention/transport 通过。DAG 标记 A-ENV degraded。 | 先完成隔离 process-group harness 与临时 cwd/state/HOME/XDG/TMP 绑定，启动前证明不连接 live coordinator；在有界可回收 lane 中实际验证 attention/supervisor resume。未验证仍不可解除此门。 |
| 针对具体 live mutation 的用户授权 | **未证实** | `D-CLEANUP.md` 将“执行剩余任务”解释为 mutation 意图，但明确实际未 mutation，且授权不替代安全条件。本次任务约束指出泛指“方案 B/执行剩余任务”不是针对已识别对象的授权。 | 待安全门全部通过后，另由有权用户对明确对象/范围、动作、风险、保留/回滚边界作具体 live mutation 授权；不得将历史泛指授权扩张解释。 |

**门槛规则：** 所有门必须有真实实现/证据产物并通过，且针对具体 mutation 的授权明确，才可建议后续 mutation。当前每项至少有一项未通过，故结论只能是 **blocked**，不派发、不执行 mutation。

## 能力边界复核：workspace release 不等于 proof-debt cleanup

只读核对 `packages/pi-subagents-enhanced/src/workspace/administration.ts`：

- `inventoryManagedWorkspaces`、`auditManagedWorkspaces` 是 workspace inventory/operational view；`planManagedWorkspaceCleanup` 生成 workspace release actions；`applyManagedWorkspaceCleanup` 校验 plan hash/state root/current actions 与显式 workspace lease authorization，随后通过 service `issueRelease`/`release` 逐项释放 workspace，返回 release receipts。
- package `exports`（`packages/pi-subagents-enhanced/package.json`）公开 `./workspace/admin` 指向上述 administration 模块；没有 proof-debt administration export/API。
- 该能力是已实现的**workspace release**，不是具有 proof debt 身份链、单 debt revision/idempotency、durable audit-first、崩溃恢复的 proof-debt disposition。不得将现有 release API、lease 授权或 fixture GREEN 误当作 proof debt cleanup 的安全证明，也不得由 proof-debt 处置隐式释放 workspace。

## 最早断点与下一步最小任务

最早阻断点是 **D-PROVENANCE：没有任何一条历史 debt 的完整权威身份链，清理候选为 0**。因此不应读取 live state 来推测快照数据，也不应继续 mutation。随后接口、审计恢复、Pi 隔离与授权门同样未通过。

最小可做下一任务：保持只读，先对一个可审计的历史样本（如能从已授权、既有持久证据中定位）建立端到端 provenance 证据清单，确认官方 terminal、owner、workspace/lease、queue/receipt 的同一性与时间顺序；不得访问 live `var/workspaces` 或补写数据。若权威历史来源不存在，记录不可恢复并停止。独立并行的实现准备可另立 TDD/隔离任务：只在临时 fixture 实现 proof-debt typed API 与 durable audit/recovery 测试；不得把设计草案标成实现，也不得对 live 数据试跑。

## 需用户政策裁决（与技术证据分开）

技术证据不能替代以下政策决定：

1. 是否允许 `abandon` 历史 debt，还是只能保留 `blocked-unknown`；不可恢复证据标准是什么？
2. 哪个主体有权批准 abandon 或具体 live mutation；批准是否需双人/分权？
3. 处置审计、原始证据及关联资源的保留期限、到期处理与复核机制是什么？

在这些问题裁决前，不得自动 abandon。政策裁决也不能弥补缺失的 provenance 或未实现 API。

## 验收边界

本次唯一写入为本报告；未新增/修改测试，未改源码或配置，未触碰 live state。文档 TDD 豁免如上。最终执行 `git diff --check` 并确认仅目标报告新增、无 staged 文件；若检查显示额外变更或既有现场不能可靠区分，停止并如实报告，不清理现场。
