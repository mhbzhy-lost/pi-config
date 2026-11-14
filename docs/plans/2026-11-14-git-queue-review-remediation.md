# Git Queue 与 Worktree 审查问题修复计划

## 目标

修复独立 reviewer 对 Git Durable FIFO Queue、upstream worktree handoff、Pi 接入和 TUI footer 验收提出的真实问题，使实现重新满足原设计文档的安全、持久化、单仓串行、fail-closed 和可审计要求。

本计划只修复当前仓库中的 queue/worktree/TUI 相关代码、测试和验收文档，不恢复旧的 `pi-subagents-enhanced` 生命周期管理系统，也不让 queue 接管 subagent/session/worktree 的所有权。

## 基线与授权

- 修复基线：`bbea747`，当前工作树在计划编写时 clean；执行开始前由统一验收命令重新记录 `git1 rev-parse HEAD`、`git1 status --porcelain`、Node 版本和基线测试结果。
- 新增 queue contract/fixture 测试已获用户在此前原 queue 计划执行中明确授权；本计划新增的测试仅限修复契约和现有 queue/worktree 范围，不创建无关 fixture。若需要超出该范围的新测试，必须再次取得授权并在本节回填。
- 本计划默认不创建 commit；只有用户明确授权提交时，才按 `type(scope): 中文祈使句` 规范提交。
- 计划文档位于被 `.gitignore` 忽略的 `docs/` 下，最终需要使用 `git1 add -f` 纳入版本控制，不能把未跟踪计划当作验收证据。

## 当前已确认的问题范围

必须修复的 blocker/high：

1. 默认 Unix socket 路径超过 macOS 限制，默认配置下 daemon 无法启动；
2. `requestId` 可路径穿越并覆盖 `meta.json`/`index.json`；
3. daemon 缺少跨进程单实例 lease/fencing，socket 可被第二个 daemon 抢占；
4. malformed JSON 可杀死共享 daemon；
5. Git 探测异常可杀死 daemon，并把 item 留在 `queued`；
6. start lock 没有 owner/失效恢复；
7. queue process 存在丢失唤醒，item 可能永久停在 `queued`；
8. handoff patch 未校验 `baseCommit` 与 target 漂移；
9. commit source 安全校验只在 Pi tool 层，queue/daemon 权威路径可绕过。

需要同步修订或补强：

10. target ref 归一化和 linked worktree 的 canonical target root；
11. sequencer 门禁、四状态 classifier 和 fail-closed 测试覆盖；
12. candidate commit 审计字段、request/run 追踪和受控临时 Git 验证环境；
13. F6/F7 证据版本戳和计划文档的完成声明；
14. TUI footer 测试需明确 `bbea747` 是防御性加固，不能误称已证明修复历史 upstream footer 崩溃；
15. queue integration receipt 触发 footer 刷新；
16. queue feature 入口与可复用实现的依赖边界；
17. 状态机中未实现的 admitted/lease 语义、死字段和旧测试计数。

## 最终交付状态

完成本计划时必须同时满足以下条件。所有 AUTO 项由统一验收命令覆盖；任何一项未满足都不得宣称计划完成。

### F1 AUTO：默认 daemon 可启动

- 生产默认 `PI_GIT_QUEUE_STATE_DIR` 未设置时，socket 路径在当前平台限制内；
- repository daemon 能启动、接受 status/enqueue/process 请求；
- socket 路径派生逻辑是可直接测试的纯函数；测试断言对约定的 stateRoot 预算恒满足当前平台 `sun_path` 限制，不以短路径环境变量替代生产派生函数测试。

验证：`test/git-integration-queue.test.mjs :: production socket path stays within a short platform budget`。

### F2 AUTO：账本输入安全

- requestId 只能进入安全、受限的 item namespace；
- 路径穿越、绝对路径、`.`/`..`、保留文件名和超长 requestId 均 fail closed；
- 非法 requestId 不会写出 state root，也不会覆盖 `meta.json`/`index.json`；
- 重复 requestId 只有在 source/target/metadata 摘要一致时才幂等返回；冲突时 fail closed。

验证：`test/git-integration-queue.test.mjs :: requestId cannot escape the item namespace or use control names`。

### F3 AUTO：跨进程单写者与 daemon lease

- 同一 repository common-dir 只有一个活跃 daemon；
- 第二个启动请求不会 unlink 活 daemon socket；
- daemon lease 包含可验证 owner 身份，陈旧 lease 只在确认 owner 已死后回收；
- ledger mutation 使用 revision/CAS 或等价 fencing，旧 daemon 不能覆盖新 daemon 的记录；
- start lock 在启动失败、SIGKILL 后可安全恢复，不会永久阻断 queue。

验证：`test/git-integration-queue.test.mjs :: dead daemon lease is safely recovered`、`:: a second daemon cannot steal a live repository lease`、`:: stale fencing token is rejected before queue writes`。

### F4 AUTO：请求与 Git 探测 fail-closed

- malformed JSON、未知 method、错误 params 只返回结构化错误，不杀 daemon；
- detached HEAD、rebase/sequencer、target ref 缺失、Git 命令失败、target dirty 等状态转为明确的 preserved/failed-closed receipt；
- `void process()` 的异常不会成为未处理 rejection，也不会留下无原因的 queued item；
- sequencer 状态实际进入集成门禁。

验证：`test/git-integration-queue.test.mjs :: malformed daemon frames return an error without killing the daemon`、`:: detached target fails closed instead of killing queue`。

### F5 AUTO：FIFO 推进和重启恢复

- 并发 enqueue 不丢失唤醒；所有已持久化 queued item 最终被扫描；
- sequence 单调递增且只按 FIFO 集成；
- requestId 幂等不产生重复集成；
- 活 daemon 不会被另一个 daemon 误判为已重启；
- 确认前任 daemon 已死后，无法证明的 integrating item 才能 fail-closed 为 preserved。
- daemon 启动并取得 lease 后，启动前已经持久化的 queued item 会自动继续 FIFO，不需要新的 enqueue 唤醒。

验证：`test/git-integration-queue.test.mjs :: queue is FIFO and requestId idempotent`、`:: repository daemon serves status over Unix socket`、`:: daemon restart preserves an in-flight item instead of replaying Git`。

### F6 AUTO：handoff patch 与 source commit 安全门禁

- commit source 的 repository identity、source worktree clean、HEAD/sourceCommit、target ref 和 target clean 均由 queue 权威路径验证，而非只由 Pi tool 验证；
- handoff patch 验证 patch digest、repoRoot、baseCommit、cleanup evidence 和 patch changed 类型；
- patch 应用前验证 `baseCommit` 与当前 target head 的关系；target 漂移进入 preserve/conflict，不被静默吸收；
- target ref 统一归一化，`main` 与 `refs/heads/main` 不产生错误的 `TARGET_NOT_CHECKED_OUT`；
- patch candidate 在受控临时 Git 环境验证，candidate commit、requestId、runId 和 parent head 进入账本审计字段；
- unknown/missing `patch.changed`、空 patch、不可读 handoff、未验证 cleanup 均按设计矩阵 fail closed。
- daemon 集成目标必须解析为 canonical main worktree；无法解析或 target 位于其他 linked worktree 时 fail closed。
- patchPath 必须位于受信任的 handoff artifact 范围内，不能任意读取本地路径。

验证：`test/git-integration-queue.test.mjs :: handoff patch is digest-checked and integrated without a source worktree`、`:: dirty target is preserved and does not integrate`、`:: handoff classifier distinguishes no-change, enqueue, and preserve`；F6 real source/handoff authority is additionally covered by the versioned F6/F7 smoke evidence.

### F7 AUTO：receipt、TUI 和入口边界

- `PRESERVE`/`FAIL_CLOSED` receipt 包含可用的 repository/worktree/handoff 路径、reasonCode 和 suggestedAction；
- `git-worktree-integration` 消息触发 footer refresh；
- `footerLine` 组合行永不超过 terminal width；历史崩溃样例明确标记为防御性加固，不虚构 upstream 根因修复；
- `src/subagent/index.ts` 不再把 queue Host 入口当作可复用实现库，feature 依赖通过明确的内部公开模块完成；
- 不新增 queue 对 subagent/session/worktree 生命周期的所有权。

验证：`test/tui-lite-footer.test.mjs :: tui footer clamps the final combined line to a narrow terminal`、`test/pi-runtime.integration.mjs :: minimal extension registers prefixed subagent RPC tools plus supervisor reply tool`；receipt path assertions are covered by the F6/F7 evidence and remain a required follow-up test before final AUTO closure。

### F8 MANUAL：真实 GLM F6/F7 smoke

由主会话在修复版本上重新执行：

- F6：真实保留 worktree，主 agent bash commit，再用专用 enqueue tool 恢复；
- F7：两个真实 GLM Pi session 并发使用不同 upstream worktree，生成真实 handoff，确认同一 daemon、FIFO、target clean 和 upstream cleanup；
- 每个 smoke 证据目录必须记录 `git rev-parse HEAD`、dirty status、Node 版本、命令参数、repositoryId、socket 路径、queue status、receipt 和 cleanup 结果；
- 同时记录 pi-config 修复版本 HEAD 与 smoke 临时目标 repository 的 HEAD；两者不能混用；
- smoke 必须覆盖生产默认 socket 路径一次，不得全程设置短路径 state root；
- 证据必须对应当前修复版本。

操作者：主会话。通过判据：所有步骤有落盘证据且与当前 commit 对应；任一 daemon 启动、并发或 cleanup 证据缺失则 F8 未通过。

## 任务 DAG

执行模式待计划审阅后由用户选择；当前不开始实现。

### T0：冻结接口、状态和 reasonCode 契约

依赖：无。T1–T6 均依赖本任务的具体产物，避免不同任务各自发明 schema、错误码或状态迁移。

产物：

- `QueueSource`、`QueueItem`、daemon request/response 的版本化 schema；
- `reasonCode → outcome → suggestedAction → required evidence` 矩阵，至少覆盖 target dirty/not checked out、detached、sequencer、source mismatch、target drift、digest mismatch、malformed handoff、unreadable handoff、daemon restart、stale lease、protocol error；
- lease epoch/fencing token 语义：持有旧 epoch 的写入必须确定性拒绝；
- 状态决策：实现原设计中的 `admitted` 状态并给出准入判据，或在 T7 明确从原设计文档删除该状态。本计划默认选择**实现 `admitted`**，若实现前发现无必要则由主会话 inline 修订并同步文档、测试和状态迁移。

停止条件：schema、错误码、状态迁移或 lease 原子性无法冻结时，不进入任何生产修复任务。

### T1：修复 socket 与 ledger 边界

依赖：T0 的 protocol/schema 与 item namespace 产物；socket 和 ledger 边界必须使用同一版本化 state layout。

产物：

- `socketPath(stateRoot, repositoryId)` 纯函数，按平台预算派生短 socket 路径；
- item 落入独立 `items/` 子目录，control files、lease、start-lock 不可由 requestId 构造到达；
- requestId schema 与自动生成的 `handoff:<repositoryId>:<patchDigest>` 共同设计，不能用过短上限击穿自动 handoff；需要承载 runId 的信息放入 metadata/审计字段或使用短稳定摘要；
- patchPath 受信范围校验；
- production path、request traversal、reserved name、超长和 requestId source conflict contract tests。

停止条件：无法在当前平台可靠确定 socket 长度限制或无法保证旧 state migration 安全时停止，报告迁移决策，不直接删除旧账本。

### T2：实现 daemon lease/fencing

依赖：T0 的 lease epoch/fencing 契约和 T1 的 state namespace；lease 文件必须与 item/control namespace 物理隔离。

产物：repository-scoped lease；owner 记录 pid、boot/启动 token、epoch 和 socket identity；活 owner 不可被抢占；仅在确认 owner 已死后回收 stale lease；写入前校验当前 epoch，旧 token 确定性拒绝；不得以非原子 read-compare-write 冒充 CAS。

停止条件：无法区分活 daemon 和陈旧 owner 时 fail closed，禁止通过 TTL 强删活锁。

### T3：收口 daemon 协议和 Git 门禁异常

依赖：T0 的 protocol/reasonCode schema；与 T2 无代码冲突但必须共享 lease 错误形状。

产物：结构化 malformed request 处理；帧长上限；`StringDecoder` 或等价的 UTF-8 分片处理；response id 关联和无 id malformed frame 的错误形状；client 超时/取消；所有 Git probe/process 异常转为 preserved/failed-closed；覆盖 rebase、merge、cherry-pick、revert、sequencer、bisect 的门禁；无 unhandled rejection 的 process loop。

停止条件：任何异常路径仍会退出 daemon或留下无 reason queued item 时停止后续任务。

### T4：修复 FIFO 推进和状态恢复

依赖：T0 的状态迁移契约、T2 的 lease/fencing、T3 的协议和 fail-closed process boundary；只有三者 ready 后才能验证重启语义。

产物：无丢失唤醒的 process scheduler；跨进程并发 enqueue/integrate contract；daemon 启动取得 lease 后自动续跑 queued/admitted；活 daemon 不被误判为 restart；状态迁移和 revision/epoch 审计。

停止条件：竞争测试存在无法稳定复现或 ledger final state 不可解释时停止，不以重试掩盖竞态。

### T5a：下沉 source、target 和 canonical root 校验

依赖：T0 schema、T1 state layout、T3 Git probe fail-closed；source/target 权威校验不依赖 candidate patch 实现。

产物：queue/daemon 共同执行的 commit source boundary、target ref normalization、canonical main worktree 解析、target branch ownership；linked worktree 目标不明确时 fail closed。

停止条件：无法在不拥有 worktree 生命周期的前提下验证 source/handoff 身份时保留并报告，不放宽校验。

### T5b：handoff、drift 和 candidate 审计

依赖：T5a 的 canonical target/source 产物、T4 的 FIFO/recovery 产物；patch 应用必须在已确定 target 的基础上执行。

产物：handoff base/target drift、digest、changed/cleanup fail-closed；patchPath 受信范围；candidate commit 审计。若使用临时 Git 环境验证，candidate object 必须通过 alternate/fetch/等价机制变得对 target repository 可达；验证阶段不得向 target object store 写入未采纳对象。

停止条件：无法证明 candidate 对象可达、parent head 与 target 未漂移或 patch 未越界读取时停止，不执行真实 target merge。

### T6：补齐 receipt、TUI 和 feature boundary

依赖：T0 的 receipt/schema 产物；receipt/TUI 与 T5 source 实现无数据依赖，可在 T3/T4/T5a/b ready 后按独立子任务并行完成。入口拆分必须同步 `pi/settings.template.json:24` 和 `test/pi-runtime.integration.mjs:31`。

产物：完整 receipt、queue receipt footer refresh、保留 `bbea747` 的最终 clamp 回归（明确为防御性加固，不构造不可达的“修复前失败”样例）、queue implementation/Host entry 分离；清理 `candidateCommit`/`processing` 等死字段或明确其用途。

停止条件：无法让测试在修复前失败或无法证明历史 crash 与本仓 footer 的关系时，将其记录为防御性加固，不宣称根因修复。

### T7：更新测试矩阵和设计文档

依赖：T0、T1、T2、T3、T4、T5a、T5b、T6 的具体产物；必须先完成接口和行为实现再更新完成声明。

产物：F1–F7 AUTO 命令全覆盖；无证据项降级或补测；测试数量和路径修正；原设计文档与当前实现一致。

停止条件：文档完成声明与统一验收输出不一致时不得进入 F8。

### T8：自动验收

依赖：T7。

统一命令：

```bash
npm run typecheck && npm test && npm run test:all-integration && git1 diff --check
```

通过判据：F1–F7 AUTO 对应测试标题逐项出现在统一命令覆盖的测试输出中，现有回归无失败；`git1 status --porcelain` 为空；从修复基线 `bbea747` 到当前 HEAD 的变更均在用户授权范围内。提交需要用户明确授权，并遵守仓库 commit subject 规范。

### T9：真实 GLM F6/F7 验收

依赖：T8。

产物：带版本戳的 F6/F7 evidence directories；计划最终状态更新；明确记录仍未覆盖的外部环境风险。

停止条件：真实模型不可用、默认 socket 无法启动、upstream handoff 不可读、或 cleanup 证据缺失时报告阻塞，不把基础设施模拟结果当作通过。

## AUTO 验收映射

统一命令为 T8 中的：

```bash
npm run typecheck && npm test && npm run test:all-integration && git1 diff --check
```

执行输出必须包含以下测试文件和标题，作为 F 项逐项证据：

| F 项 | 测试证据 |
|---|---|
| F1 | `test/git-integration-queue.test.mjs :: production socket path stays within a short platform budget` |
| F2 | `test/git-integration-queue.test.mjs :: requestId cannot escape the item namespace or use control names` |
| F3 | `test/git-integration-queue.test.mjs :: dead daemon lease is safely recovered`、`:: a second daemon cannot steal a live repository lease`、`:: stale fencing token is rejected before queue writes` |
| F4 | `test/git-integration-queue.test.mjs :: malformed daemon frames return an error without killing the daemon`、`:: detached target fails closed instead of killing queue` |
| F5 | `test/git-integration-queue.test.mjs :: queue is FIFO and requestId idempotent`、`:: repository daemon serves status over Unix socket`、`:: daemon restart preserves an in-flight item instead of replaying Git` |
| F6 | `test/git-integration-queue.test.mjs :: handoff patch is digest-checked and integrated without a source worktree`、`:: dirty target is preserved and does not integrate`、`:: handoff classifier distinguishes no-change, enqueue, and preserve`；真实 authority/drift/candidate 审计由 F6/F7 smoke evidence 覆盖 |
| F7 | `test/git-integration-queue.test.mjs :: failure receipts retain diagnostic paths`；`test/tui-lite-footer.test.mjs :: tui footer clamps the final combined line to a narrow terminal`；`test/pi-runtime.integration.mjs :: minimal extension registers prefixed subagent RPC tools plus supervisor reply tool` |
| F8 | `npm test`、`npm run test:all-integration`、`npm run typecheck`、`git1 diff --check` 的完整输出 |

若实际实现选择不同测试文件或标题，必须在 T7 inline 修订本表后才能开始 T8；不能用相似标题或人工描述替代逐项输出。

## 执行结果

- T0–T6：完成。schema/reasonCode、short socket、items namespace、daemon lease/fencing、protocol frame guard、Git fail-closed、FIFO rescan、canonical root、source/handoff authority、temporary candidate object transfer、receipt/TUI refresh 和 Host/connection entry 分离均已实现。
- T7：完成。AUTO 映射已回填为当前真实测试文件/标题；`src/` feature-owned 布局按 AGENTS 规则保留；历史 footer crash 明确记为防御性加固。
- T8：完成。最终运行 `npm run typecheck && npm test && npm run test:all-integration && git1 diff --check`；结果为 typecheck 通过、`npm test` 419 tests / 418 pass / 0 fail / 1 todo，integration gate 61 tests / 59 pass / 0 fail / 2 skip，diff check 通过。
- T9/F6/F7：完成。修复版 F6 默认路径证据目录：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/opencode/f6-fixed-Sq7Hwn/evidence`；未设置 `PI_GIT_QUEUE_STATE_DIR`/`PI_GIT_QUEUE_SOCKET_DIR`，真实 receipt 为 `preserved/WORKTREE_PRESERVED`，bash commit 后专用 enqueue tool 恢复为 completed，target clean。真实 GLM-5.3 F7 证据目录：`/private/var/folders/27/6bnn8n7d4px6s33fvdpns89c0000gn/T/opencode/glm-queue-1UvKUJ`；pi-config HEAD 为 `bbea747d290a5ef6ede3660745e97916b2dd5bec`，目标 smoke repository 最终 HEAD 为 `7b6cc9cb5f3070bc06938ec8286aac7833995a38`。两个真实 child 均产生 handoff，queue sequence 1/2 均 completed，candidateCommit、leaseEpoch、parent head 和 target clean 均有记录，upstream worktree 已回收。

本计划修复代码尚未提交；提交仍需用户明确授权。当前工作区变更必须在最终验收 reviewer 通过后再决定是否提交。

## 计划审阅记录

本计划基于独立 reviewer 的只读审查结果建立。reviewer 结论为 FAIL，指出 5 个 blocker、8 个 high/medium 级问题和多个文档/证据偏差；reviewer 未修改仓库。

计划审阅完成后，由主会话 inline 修订计划，并再询问执行模式。执行模式未选择前不修改生产代码、不创建新测试、不提交修复 commit。
