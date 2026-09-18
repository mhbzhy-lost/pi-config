# FIFO 重放测试超时根因诊断

- Task：`pi0851-fifo-test-diagnosis`
- 范围：只读诊断；唯一写入本报告。
- 结论：现有“大 FIFO”测试的 64s 失败不能归因于 terminal-proof replay。该测试在队列完成之后才发送 proof，因而没有等待“重放结算”的场景；它的可观察等待点是 5s 轮询，最外层 Node test timeout 是 60s。重放实现确实是 fire-and-forget，但它对该测试主流程既不是同步前提，也不是触发缺失点。

## 1. 测试全文与精确等待点

文件：`test/subagent-auto-integration-real-git.integration.mjs`。

- L68：大 FIFO 测试声明 `{ timeout: 60_000 }`。已知现场报错的约 64.28s 是 Node test 的 60s 测试超时加上 teardown/报告开销，不是 `waitFor` 自己配置的 64s。
- L63：`settle()` 先 await `agent_end`，再发出 `agent_settled`；只有 `agent_end` handler 完成后才继续。
- L64：所有 `waitFor` 每 10ms 轮询，默认总等待 5,000ms；条件为 truthy，否则抛出 `timed out waiting for <description>`。
- L83-85：先等待 gated first child 的 `prepareAutoIntegration` 完成，随后准备另外两个 queue item，要求三者均为 `queued`。
- L89-93：释放第一个 child 后，等待 L92 的 `inspectIntegrationState(...).queueState === "completed"`，并要求 integration receipt。
- L95-101：第二个 child settle 后，L96 等待 `resolving-conflict`；第三个 child settle 后 L98 立即断言仍为 `queued`，并断言不会唤醒模型。
- L103-108：第二个 child 两次冲突解决。L104 等待第二次 follow-up 消息（条件仅 `messages.length === 2`）；L107 等待其 queue state `completed`。
- L110-114：第三个 child 被 FIFO 放行后，L110 等待 `resolving-conflict`；L114 等待 `completed`。
- L117-121：队列完成、Git clean、手动调用 `proof()` 三次并直接 await RPC receipt；这里没有 `waitFor`，也没有 early/pending proof。

因此，若失败消息是内部 `waitFor`，精确候选是上述六个描述：`first completion`、`second first conflict`、`bounded second conflict`、`second completion`、`third FIFO admission`、`third completion`（实际报错文本应以现场完整 stderr 为准）。现有代码/本次复现没有显示某一个固定条件永久不满足；单独运行该测试三次均通过，耗时约 38.7-39.8s，说明它本身是较长路径但未稳定超过 60s，而非确定性 replay 死锁。仅凭“64.28s 失败”而没有原始 failure message/stack，不能从六个内部轮询中再唯一指定一个；能够精确指定的是最外层 L68 的 60s deadline。

## 2. coordinator 触发链与 outbox 语义

### 2.1 完成队列时的触发

`packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts`：

1. L157-179 的 `advanceAutoIntegration()` 在 admission/rebase 成功后调用 `publishRebasedCandidate()`。
2. L82-94：`publishRebasedCandidate()` 准备 candidate、完成 workspace integration intent，并在 L94 `integrationQueue.completePrepared(...)` 将 item 置为 `completed`。
3. L95-101：完成之后调用 `void replayTerminalProofs().catch(() => undefined)`。这是明确的 fire-and-forget：调用方不会 await replay；队列提交不会被 replay 阻塞；replay 的异常被吞掉。
4. L244-247：`replayTerminalProofs()` 仅在三项依赖存在时调用 `proofOutbox.replay(deliverTerminalProof)`。
5. L227-242：`deliverTerminalProof()` 只接收已完成 queue item、匹配 run/ownerScope 的 proof；workspace 已 released 时返回幂等 receipt，否则执行 record/status/issue/discard。

### 2.2 proof 到达与 replay 语义

`packages/pi-subagents-enhanced/src/subagent-dispatch/coordinator-proof-outbox.ts`：

- L60-70 `enqueue()` 先持久化 pending；已有 receipt 时不重复入列。
- L83-102 `replay()` 在同一个文件锁内逐个尝试 pending proof；成功则写入 `receipts` 并移除 pending，失败则保留 pending；最终持久化整个状态。
- L12-19 的 `fileLocks`/`serialized()` 使同一 outbox 文件的 enqueue/replay 串行，故 fire-and-forget 不会产生文件级 read-modify-write 丢失，但可能排队等待前一个 replay/写入完成。
- coordinator 的 `record_terminal_proof` 路径（`coordinator-server.ts` L253-262）是同步等待：enqueue 后立即 `await replayTerminalProofs()`，若仍无 receipt 则抛出“terminal proof delivery remains pending”。这就是测试中 early proof 的预期 reject 行为。
- coordinator 启动时 L394-396 也会 await 一次 replay，作为崩溃窗口恢复。

## 3. 该 FIFO 场景为何不能证明 replay 未及时结算

“大 FIFO”测试（L68-122）直到 L118 才调用 `proof()`。此时：

- L92、L107、L114 已分别确认三个 queue item completed；
- 每次完成已经触发过 L101 的异步 replay，但当时 outbox 没有该测试的 proof；
- L118 的 proof RPC 自己执行 L258 enqueue、L259 await replay，随后 L260 读取 receipt；它不依赖之前 completion 的 fire-and-forget replay。

所以这个测试没有“proof 先到 pending，前者完成后由异步 replay 自动结算”的验证路径。它验证的是 FIFO admission、两个冲突以及最后同步 proof handoff。若 64s 超时发生在该测试，生产 replay 不可能是该测试等待不到的直接原因；更合理的归因是长耗时 Git/coordinator 生命周期在 60s 外层预算内不稳定，或某个前述 5s 轮询在该次运行中耗尽。应先保留完整测试失败 stderr，确认是否为 `timed out waiting for ...` 还是 Node 的 `test ... timed out after 60000ms`。

文件中的专门 replay 测试反而明确覆盖了缺失场景：

- L146-164：proof 在 completion 前到达；L153 预期 RPC reject，L154 证明无 receipt；L158 完成 integration；L161 轮询 receipt，验证 fire-and-forget replay 自动释放。
- L166-196：FIFO follower proof 早到；L175-178 验证 follower 与 ghost 都 pending；L182-186 完成 head 后 follower 仍无 receipt；L188-191 完成 follower 后轮询 receipt；L194-196 验证 ghost 继续 pending 且重复 delivery 幂等。

这两个专门测试在本工作树组合运行 2/2 通过（下文验证），因此没有现场证据表明 replay 条件或时序在当前 v2 fixture 中错误。

## 4. 根因分类与精确修复点

### 分类

**当前证据支持：测试自身的等待/预算问题（性能预算或诊断可观测性不足），不是生产 replay 缺陷。** 具体地，大 FIFO 测试把多次真实 Git 操作、三 child 生命周期、两次冲突和 coordinator RPC 全塞进 60s，内部轮询仅 5s，且没有阶段计时/失败时 queue snapshot。已知单独复现约 38.7-39.8s 通过，历史现场约 64.28s 失败，表现为预算不稳定而非固定 replay 条件错误。

**不能把“fire-and-forget 未 await”本身判为缺陷。** 设计注释及代码 L95-101 明确要求 replay 不阻塞 queue commit；专门 replay 测试用 L161/L190 的最终 receipt 轮询承接该异步边界。测试若要验证异步 replay，必须在 proof 已 pending 后等待 receipt，而不是只 await queue completion 返回值。

### 最小修复建议

1. **测试（首选）**：将“大 FIFO”验收与 replay 语义分开。保持 L68 测试只验证 FIFO/Git lifecycle，并为其增加阶段计时和失败时 `inspectAutoIntegration`/queue state snapshot；不要把 replay 失败归因到该测试。若产品要求该测试覆盖 FIFO follower early proof，则应把 proof RPC 放到 L95/L97 之前，并用 L161/L190 模式显式轮询 receipt，同时断言 head completion 后 follower 仍 pending、follower completion 后 released。
2. **测试预算**：在确认失败点后再调大单测 60s timeout，或拆成更小的测试；不要先改 production 增加等待/重试。内部 `waitFor` 可保留 5s，除非现场明确指出某个条件需要更长的合法异步等待。
3. **生产（仅在新证据出现时）**：若专门 replay 测试在 v2 fixture 上复现“queue completed 且 proof pending，但 receipt 永久不出现”，再在 `publishRebasedCandidate` L101 处增加可观测的 replay completion/error 记录或返回可 await 的测试钩子；不应把 fire-and-forget 改成阻塞 queue commit，也不应为 v1 ledger 增加兼容结算分支。相关 v1/v2 确定性阻断已有记录：`docs/bugs/2026-09-15-workspace-v1-v2-allocation-fork.md`。

未发现需要重构 replay 设计的证据；停止条件未触发。

## 5. 验证证据

命令：

- `node --test --test-name-pattern='real Root Broker/coordinator/Git lifecycle preserves FIFO' test/subagent-auto-integration-real-git.integration.mjs`：首次通过，约 38.7s。
- 同命令再连续运行两次：2/2 通过，约 39.3s、39.8s。
- `node --test --test-name-pattern='a FIFO follower|queue completion auto' test/subagent-auto-integration-real-git.integration.mjs`：2/2 通过，组合约 31.0s。
- `nl -ba ...` 对测试与 coordinator 行号取证；`git status --short` 确认本报告之外均为既有工作树变更，未修改代码/测试。

未运行真实 LLM probe；未增加或修改测试。
