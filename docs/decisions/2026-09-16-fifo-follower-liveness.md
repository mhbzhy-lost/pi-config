# T4 FIFO follower 续轮可行性探索

日期：2026-09-16

## 结论

在当前约束下，没有可证明的 FIFO follower 续轮机制，记录为 blocker。本结论基于以下不可变前提：不修改或升级 `pi-subagents@0.62.0` 与 Pi 0.85.1 upstream；维持 child-owned integration（冲突由 child 解冲突并 publish）；不使用真实 LLM probe；trusted binding、child 解冲突以及 proof/release 门禁必须同时成立。

四个候选中没有一个同时满足这些门禁，因此本文不选定可实施机制。下游续轮实现、五 child 真实验收和 T13 均 gated on 用户对本文“需用户决策的冲突点”的明确决策。

## 证据边界与 runner 事实

runner 的 final drain 事实是可证明的：

- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/subagent-runner.ts:921-932` 固定 `FINAL_STOP_GRACE_MS = 1000`，并维护 final-drain、hard-kill、watchdog-tail 计时器。
- `subagent-runner.ts:1068-1089` 的 `startFinalDrain()` 在 child watchdog active 时只启动 watchdog tail，不启动 1 秒 final drain；否则设置 1 秒计时并随后发送 `SIGTERM`，再在 hard-kill 窗口发送 `SIGKILL`。
- `subagent-runner.ts:823-851` 只对被识别且被接受的 `subagent.watchdog.status` 事件更新 watchdog 状态；active 时清除 final-drain/hard-kill 计时器并 arm watchdog tail，非 active 时重新进入 final drain 判断。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/watchdog/child-status.ts:167-184` 定义了事件识别和 active 判定。事件必须是 `type: "subagent.watchdog.status"`，具有整数非负 `seq`、有限数值 `ts`、合法 `phase`、布尔 `followUpPending`；`followUpPending: true` 或 `phase: "reviewing" | "autofollow" | "settling"` 才会被判定为 active。
- `child-status.ts:186-204` 还要求身份字段（若 runner 提供 `runId`、`agent`、`childIndex`）匹配且 `seq` 单调递增。通过后才生成 runner 使用的状态快照。

因此，“status 事件能取消 final drain”本身有 upstream 证据；问题在于 managed coding child 能否无门禁副作用地稳定产生它，以及产生后能否证明其续轮、冲突解决和最终 proof/release 仍由受信 child 完成。

## 候选 1：child watchdog keepalive

### 可证明的正向部分

配置入口和事件契约均存在：

- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/watchdog/child-status.ts:3-6` 定义配置环境变量 `PI_SUBAGENT_WATCHDOG_CHILD_CONFIG`、事件名 `subagent.watchdog.status` 以及合法 phase。
- `child-status.ts:137-165` 从该环境变量解码配置；要求 `enabled: true`，并要求 `watchdogTailTimeoutMs`、`agentEndTimeoutMs`、`maxWarnings`、LSP、auto-follow 和 `stalemateRepeats` 等字段满足完整 schema。`child-status.ts:75-76` 仅提供 JSON 编码函数。
- `packages/pi-subagents-enhanced/node_modules/pi-subagents/src/watchdog/register-child.ts:56-73` 读取该环境变量，启用后以递增 `seq`、当前时间 `ts`、phase 和 `followUpPending` 写出 JSON 行；输出类型是 `subagent.watchdog.status`。
- `register-child.ts:89-110` 在 session start 发出 `idle`，在 `agent_end` 先发 `reviewing`，等待 `runtime.handleAgentEnd` 完成后再发 `failed`、`stale` 或 `idle`。这与 runner 侧 `subagent-runner.ts:823-849` 的接受契约相连。
- runner 侧对 `phase: "settling"` 或 `followUpPending: true` 的接受和 drain 取消已由上节行号证明。

### 无法通过门禁的部分

不能证明“只为 managed coding child 注入 `PI_SUBAGENT_WATCHDOG_CHILD_CONFIG`，但不触发 upstream register-child 的模型 review 副作用”：

- `register-child.ts:56-58` 表明配置启用后必进入 child watchdog 注册路径。
- `register-child.ts:74-83` 无条件构造 `MainWatchdogRuntime`，传入 `createMainWatchdogReview(...)`，并设置 `reviewDescription: "child model review"`、`reviewChangesOnly: true` 与 warning 发送逻辑。配置不是纯 keepalive 开关；它把 review runtime 接入 child。
- `register-child.ts:102-110` 的 `agent_end` handler 发出 `reviewing` 后 `await runtime.handleAgentEnd(event, ctx)`，完成后才发出最终状态。也就是说，状态输出与 child model review 运行时绑定，而非一个独立、无副作用的 liveness emitter。
- `node_modules/pi-subagents/src/watchdog/runtime.ts:169-180` 记录传入 review 后 `reviewConnected` 为真；`runtime.ts:362-420` 在 agent end 处理变化签名和 review delta，并可能等待 review、标记 stale/failed 或继续状态机。该运行时并非只读心跳。
- `register-child.ts:15-36` 还将 child 配置提升为 enabled 的完整 resolved watchdog config，并把模型/thinking、auto-follow、LSP 等配置接入 runtime。当前现场没有一个公开的 child-only 参数可以让 `registerChildWatchdog` 保留 status emitter 而跳过 `createMainWatchdogReview` 与 `handleAgentEnd` review。
- runner 的 child 环境确实可以承载配置：`node_modules/pi-subagents/src/runs/background/subagent-runner.ts:754-760` 从 child 环境解码配置，`runs/shared/pi-args.ts:1028-1030` 将编码值写入 `PI_SUBAGENT_WATCHDOG_CHILD_CONFIG`。这只能证明“可注入”，不能证明注入后 review 副作用可接受。

因此候选 1 否决。事件契约能够取消 final drain，但在“不全局启用 watchdog review 副作用”的要求下，无法证明 managed coding child 的注入方案；若接受该副作用，则需要单独的产品/范围决策，不能在本只读任务中假设接受。

## 候选 2：Pi 续轮 API

候选 2 不能提供 runner 所识别的 `willRetry` 或 active 续轮机制。

- `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:429-441` 的 `_willRetryAfterAgentEnd(event)` 只在 retry settings 开启、重试次数未超限且最后 assistant message 满足 `_isRetryableError` 时返回 true；普通 queued follow-up 不会改变该判断。
- `agent-session.js:787-810` 的 `_handlePostAgentRun()` 先处理 provider retry 和 compaction，最后仅返回 `this.agent.hasQueuedMessages()`。这表示 agent 内部队列可能驱动 `agent.continue()`，但它不把普通队列转换成 `willRetry: true`。
- `agent-session.js:374-386` 显示队列消息在 `message_start` 被消费，随后 `agent_end` 对外发出的 `willRetry` 仍直接来自 `_willRetryAfterAgentEnd`，不是“是否存在队列”的结果。
- `agent-session.js:1099-1134` 的 `sendCustomMessage(...)` 本体是 `async` 并返回 `Promise<void>`；它可以把消息放入 `followUp`、`steer` 或 `nextTurn` 队列，但该 Promise 只表示 enqueue/处理路径完成，不是 runner 认可的 retry/active 租约。
- ExtensionAPI 对外绑定在 `agent-session.js:2011-2018`：`sendMessage: (message, options) => { this.sendCustomMessage(message, options).catch(...) }`，调用方拿不到该 Promise，绑定本身是 void/fire-and-forget。替换 session context 的 `sendMessage`（`agent-session.js:2812-2816`）虽然直接返回 `sendCustomMessage`，仍没有公开的 `willRetry` 控制，也没有 runner active 状态契约。
- 类型层仅公开 `sendCustomMessage(...): Promise<void>`，见 `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts:403-406`；`core/extensions/types.d.ts` 的 `ExtensionActions:1242-1249` 只声明 `sendMessage: SendMessageHandler`，没有将 `willRetry` 或 runner watchdog active 暴露给扩展。

背景中给出的“agent_end 时 queued follow-up 不使 `willRetry=true`”与这些行一致。因此候选 2 明确否决：在不改 upstream、不升级 Pi 的前提下，没有可 await 且被 runner 识别为 `willRetry` 或 active 的公开 Extension API。

## 候选 3：durable coordinator recovery + resumed child

候选 3 有一部分 durable recovery 能力，但现场不能证明它能完成 follower 续轮 admission 和冲突续轮。

### 已存在的 durable 部分

- `packages/pi-subagents-enhanced/src/workspace/coordinator-server.ts:209-225` 的 `reconcileIntegrations()` 遍历 durable queue；对 `queued`、`admitted`、`rebasing`、`resolving-conflict`、`prepared` 状态重建 trusted binding，并调用 `advanceAutoIntegration` 或 `publishRebasedCandidate`。失败时进入 `preserveIntegrationDebt`。
- `coordinator-server.ts:196-207` 的 preserve 路径把 queue item 标记为 preserve，生成 recovery intent，并通过 `options.recoveryEventSink` 尝试投递；sink 不可用或失败会记录 delivery debt，而不会凭空启动 child。
- `coordinator-server.ts:325-332` 暴露 `recovery.status`、`recovery.audit`、`recovery.preserve`、`recovery.recover` 和 `recovery.retry`。`recovery.recover` 强制 root authorization，并要求新 run/lease 与当前 trusted binding 的 run/lease 一致（`coordinator-server.ts:328-331`）。这些是 durable 状态变更接口，不是 resumed child admission 调度器。

### 缺失的可证明驱动点

- `coordinator-server.ts:201-203` 中 recovery event sink 的职责是接收 intent 并回写 delivery 状态。文件中没有从该 sink 自动创建、重启或 resume child run 的实现。
- `packages/pi-subagents-enhanced/child-extensions/root-session-owner.ts:73-80` 对 `recovery.event` 的处理只是向 root Pi session `sendMessage` 一条 `pi-root-recovery-event-v1` custom message；注释明确说 recovery notification 是 root owner 的 durable observation，broker 已持久化事件，且不需要 model wake-up。该代码没有调用 resumed child、admission 或 conflict continuation。
- `scripts/probes/repository-merge-queue-acceptance.ts:437-490` 的 `collectAcceptanceReady()` 只循环读取 public dispatch binding、audit 和 `${runId}.ready.json`，确认 child identity、worktree 和同一 base commit 后释放 barrier。它没有 follower 退出后的 resume/retry 入口。
- `repository-merge-queue-acceptance.ts:300-324` 的 barrier 只在所有 expected child ready 时 `release()`；`repository-merge-queue-acceptance.ts:357-364` 的 release writer 只原子写 `release.json`。`repository-merge-queue-acceptance.ts:496-528` 的 `waitForAcceptanceAudit()` / `settleAcceptanceHosts()` 只等待 queue/workspace/proof/release 的最终公共事实。barrier、release 和 audit 都是验收同步/观察点，不是 resumed child 的 admission 驱动点。
- 验收冲突证据要求 Git 事实（`repository-merge-queue-acceptance.ts:29-37`：非零 rebase exit、unmerged entries、sequencer、Git conflict digest），且 child dispatch contract 明确把 Auto Integration 作为 queue admission/rebase/conflict continuation/publication owner（`repository-merge-queue-acceptance.ts:85-94`）。但是当前 recovery 路径没有现场证据表明新/恢复 child 会带着原 trusted binding 被重新 admission，也没有证据表明其会继续在自己的 worktree 中解冲突并提交 terminal proof。

因此候选 3 否决。它证明了“coordinator 可以保留并 reconcile durable queue item”，没有证明“root broker recovery event 能驱动 resumed/retried child run”，也没有证明 acceptance harness 可以按该路径驱动 resume。若由 coordinator 直接代替 child 解冲突，则违反 child-owned integration；若只发通知等待 child 自行醒来，则缺少可验证的驱动与 proof 门禁闭环。

## 候选 4：其它机制

当前只读范围内没有发现第四种可证明机制：

- final-drain timeout 不能作为续轮机制；全局约束明确禁止仅延长 final-drain 或 acceptance timeout 来掩盖同步阻塞。
- 伪造 watchdog、`agent_end` 或 `willRetry` 不能作为机制；全局约束明确禁止。
- 直接修改 runner、Pi upstream 或其识别语义超出范围；全局约束要求 upstream 不升级、不修改。
- coordinator 自行 publish 或解冲突会违反 child-owned integration 和 trusted binding/proof 门禁。
- 仅依赖 TUI、模型文本、session custom message 或通知事件不能作为 queue completed、receipt、proof、release 的权威事实；全局约束要求这些事实来自 trusted coordinator/ledger。

候选 4 因缺少可引用的事件契约、驱动点和完整门禁证据而否决。

## 需要用户决策的冲突点（原样记录）

以下冲突无法在本任务中猜测或自行取舍：

1. 是否接受全局启用 child watchdog review 的副作用（候选 1），或是否允许在 managed coding child 路径注入 watchdog config 而抑制 `register-child` review。后者需要新的 upstream/集成边界探索，超出本任务的只读核对范围。
2. 候选 2 在不改 upstream、不升级 Pi 的前提下是死路；没有可供选择的公开 awaitable `willRetry`/active API。
3. 候选 3 是否允许在 follow-up 计划中扩展 acceptance harness，或扩展 root broker 的 recovery→resume 编排，使 recovery event 能绑定原 trusted workspace/lease/run 并启动 resumed child。该扩展必须保留 child 解冲突、Git conflict evidence、terminal proof 和 release 门禁；当前代码未提供可直接引用的驱动契约。
4. 若用户不接受候选 1 的 review 副作用，也不批准候选 3 的 harness/broker 扩展，则当前约束下不存在可证明的 FIFO follower liveness 路径，五 child 真实验收与 T13 不能解除该 blocker。

## 下游 follow-up 必须满足的接口契约

由于当前没有选定机制，以下是下一计划必须先获得用户批准的最小契约，而不是当前实现承诺。

### 若批准 watchdog 路径

managed child launch 必须提供等价于以下输入的受信配置注入：

```ts
interface ManagedChildWatchdogConfig {
  enabled: true;
  runId: string;
  agent: string;
  childIndex: number;
  watchdogTailTimeoutMs: number;
  agentEndTimeoutMs: number;
  maxWarnings: number | null;
  autoFollowBlockers: boolean;
  autoFollowMaxAttempts: number | null;
  stalemateRepeats: number;
  lsp: { enabled: boolean; timeoutMs: number; maxFiles: number; maxDiagnostics: number };
  model?: string;
  thinking?: string | false;
}
```

child stdout 必须发送满足以下 schema 的有序事件，且 runner 提供的身份字段必须完全匹配：

```ts
interface ChildWatchdogStatusEvent {
  type: "subagent.watchdog.status";
  runId: string;
  agent: string;
  childIndex: number;
  stepIndex: number;
  seq: number;              // 单调递增
  phase: "idle" | "reviewing" | "autofollow" | "settling" | "stale" | "failed";
  ts: number;
  followUpPending: boolean;
  reason?: string;
}
```

其中用于保活的事件必须在 runner final drain 前可达，并且 `phase: "settling"` 或 `followUpPending: true`。批准前必须额外证明 `register-child.ts:74-83` 的 review side effect 被接受或有不改变 upstream 语义的隔离方案。

### 若批准 durable recovery + resumed child 路径

root broker/recovery orchestrator 必须公开等价于以下契约：

```ts
type RecoveryResumeRequest = {
  recoveryIntentId: string;
  queueItemId: string;
  workspaceId: string;
  leaseId: string;
  originalRunId: string;
  ownerScope: { kind: "standalone-subagent"; rootSessionId: string };
  authorization: "root";
};

type RecoveryResumeResult = {
  recoveryIntentId: string;
  queueItemId: string;
  resumedRunId: string;
  state: "recovered" | "retry";
  trustedBinding: { workspaceId: string; leaseId: string; runId: string };
};
```

并且必须同时证明：

- resumed child 通过 trusted `workspaceId`/`leaseId`/`ownerScope` 重新 admission；
- coordinator 仅提供 FIFO queue、rebase/admission/proof/release 门禁，不代替 child 解冲突或 publish；
- child 在自己的 worktree 解冲突，并产生 `rebaseExitCode`、unmerged entries、sequencer 和 `digestSource: "git"` 的公共 conflict evidence；
- terminal proof 的 `runId`、workspace、owner scope 与恢复后的 trusted binding 一致；
- acceptance harness 能以公开接口驱动恢复并在最终 audit 中观察 queue completed、proof observed、workspace released，而非只观察 notification 或模型消息。

在上述契约获批准并有实现证据前，不能宣称 FIFO follower 续轮可行。

## 决策状态

状态：**BLOCKER；无选定机制。**

本文仅记录只读证据与决策边界，不修改 upstream，不运行真实 LLM probe，不伪造 watchdog/`agent_end`/`willRetry`，也不把通知、barrier 或模型文本当作权威完成事实。
