# Q1：纯派发回执 `triggerTurn` 有限接点门禁

## 终态与范围

- `taskId`: Q1（执行合同 `dispatch-96740cda`）。
- `status`: **blocked-upstream**；静态门禁记录已产出，**纯派发不唤醒功能未实现、未验证**。
- `Q2`: **not-applicable**，本次不具备 selector 实施资格，不创建函数或测试。
- `Q3`: 待父层后继记录上游限制、未实施和原语义保留；本文件不替代 Q3 acceptance。
- `nextAction`: 保留现有 sender 和 `triggerTurn`。在“不改上游/fork/patch”的用户决策下，不继续实施 Q2；最终总账应将 Q 分支计为 blocked、整体按实际缺口记 partial，不以门禁记录冒充功能完成。
- 主管已确认：仅写本文件；禁止用后置 event、替代 notifier 或文本推断绕过阻塞，其他独立分支继续。

消费：[统一执行计划](../2026-10-13-remaining-runtime-execution.md) Q1–Q3、[历史决策](../../decisions/2026-10-11-dispatch-receipt-trigger-turn.md)。本次补足历史决策所保留的“本仓 options 接入是否存在可信关联”问题，不修改历史决策或计划。

本次只有静态源码、类型、manifest/lock 与 git 核对。未启动 Host、RPC、provider、网络、通知或真实派发；未执行测试/typecheck，未访问 credential/settings/models、session 正文、authority 或 `.state` 数据。阅读源码中的文件/global 操作不等于执行它们，本次未读取私有 runtime global 或 result/receipt 文件。

## 版本与可复核定位

调查起点 HEAD：`a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`。

下文路径缩写仅用于引用，均指本次现场源码：

| 缩写 | 精确路径 |
| --- | --- |
| U | `packages/pi-subagents-enhanced/node_modules/pi-subagents/` |
| P | `packages/pi-subagents-enhanced/` |

锁定依据：`P/package-lock.json:14` 固定 `pi-subagents: 0.75.0`，`:2001-2005` 记录官方 registry 的 0.75.0 安装物；`U/package.json:4` 实际安装版本为 0.75.0。安装物仅作为权威源码证据读取，未修改。

| 文件 | SHA-256（本次静态读取） |
| --- | --- |
| `U/src/runs/background/notify.js` | `9fa4ec50da0d41b4256349befe86c5d8e8eaaba122817a4c9a71c303fa45089f` |
| `U/src/runs/background/result-watcher.js` | `667ddcc95906b332a6eaffcddb78da28e2d1e9f86d72ed2eb58f998f18ebb0fb` |
| `U/src/extension/index.js` | `29813cd2fda10c3eee1d8356c31d88dc14f7e30b85729b84bc24436a0531868e` |

## 权威字段与调用链

### 1. 原始 result 的来源，不是标题模拟

`U/src/runs/foreground/subagent-executor.js:5718-5743` 在 workflow 执行结束后：

1. 保存真实 `workflow.value/trace/emits/console`，生成 `workflowChildren`。
2. `terminalWorkflowReceipt(...)` → `writeWorkflowReceipt(asyncDir, receipt)`，生成 `workflowReceipt = { path, receipt }`。
3. `writeWorkflowResult(...)` 发布包含 `runId/toolCallId/sessionId/completionOwnerId/mode/success/state/results/workflow/workflowChildren/workflowReceipt` 的结果，随后刷新 result delivery。

失败/暂停/停止路径在同文件 `:5750-5805` 也生成 receipt、结果和可能的 `terminalOutcome/activityState`；receipt 写入失败时可合法缺少 `workflowReceipt`，不能为此制造 production 兼容或认定是纯派发。

`U/src/workflows/workflow-receipt.js:28-76` 的 `buildWorkflowReceipt(input)` 返回 `version/workflowRunId/state/createdAt/entries`，以及可选 `argsDigest/resource/hostSteps/workflowChildren/terminalOutcome`。同一 receipt 可表达真实产出、恢复或失败；**receipt 存在、`state: complete` 或 child 正在运行均不是“相对已返回 tool result 无新增业务结果”的专用证明**。

来源分类：这里缺少关联是正常 production 路径的 API 信息边界，不是测试制造的缺字段异常。下方矩阵只做合同反例，不把手工对象当 production 样本；本次未调查真实业务异常。

### 2. Async 正常发送顺序

`U/src/extension/index.js:314` 内部创建 `registerSubagentNotify(pi, state, { batchConfig, ownership })`；`:427-435` 内部将同一 notifier 注入 `createResultWatcher(...)`。其 `observeCompletion` 仅接到内部 `scheduledRunManager.handleAsyncCompletion`，不是传给本仓的 callback。

正常 owned、非已投递结果的顺序如下（其他去重、intercom 或 ownership 拒绝分支可能不发送，不能将它们强制当成一次 send）：

```text
result-watcher.handleResult
  → parseResult(raw)                                      result-watcher.js:309
  → deps.observeCompletion({...data, runId})              :343（内部 scheduler）
  → 所属 session/owner/epoch 检查与去重、可能的 intercom
  → await notifier.deliver({...data, runId, triggerTurn,
                           intercomDelivered, results...}) :478-497
      → ownership / intercom / seen / pending 检查         notify.js:646-679
      → buildCompletionDetails(result)                   :680
      → item={key, details, sessionId, completionOwnerId,
              triggerTurn, resolve}                      :685-691
      → foreground 立即 emit；非 completed 先 flush 再 emit
        completed 经按 session 分组的 batcher             :695-709
      → emit(items)：再次 ownership 校验、claim 去重       :605-628
      → sendCompletion(pi, claimedItems)                 :629
          → 格式化单条或分组 content                     :425-427
          → pi.sendMessage(message, options)             :429-433
      → settle claims/items，resolve accepted             :630-633
  → notifier accepted 后检查 owner/epoch 与 payload 替换
  → markDeliveredNotification                            result-watcher.js:507
  → pi.events.emit(subagent:async-complete, {...data})     :517-536
  → 后续检查与结果索引清理
```

重点：`workflowReceipt` 在更早的 `data/result` 上存在，但不意味着在本仓 `sendMessage` 拦截时存在。正常 result-watcher 路径的 async-complete 是 **await delivery 之后** 的观察事件，不能充当发送前关联证明。notifier 本身也订阅 async/foreground completion（`notify.js:711-718`），但不能把另一种事件来源的先后顺序外推到 result-watcher 链。

### 3. 真正 sender 的两个参数

`U/src/runs/background/notify.js:422-438` 的 `sendCompletion(pi, items)`：

```text
message = {
  customType: "subagent-notify",
  content: formatSingleCompletion(details[0]) 或 formatGroupedCompletion(details),
  display: details.some(source === foreground || status !== completed || scheduleOrigin 存在)
}
options = { triggerTurn: items.some(item => item.triggerTurn) }
```

message **没有 `details`、发送 token、结构化 item 列表、receipt 或 run identity 字段**。此处 `details` 只是 sender 的局部数组，不是 message.details。

`notify.js:447-583` 的 `buildCompletionDetails(result)` 虽可投影 `workflowReceiptPath/workflowRunId/childRuns/childOutputs/reconciledFromDetachedChild/watchdogBlockers` 等，但只把 `result.workflowReceipt.path` 留为路径（`:472-475`），不保留完整 receipt、workflow value/emits、tool-result 增量证明；到 `sendCompletion` 又仅格式化为文本。

每个 item 的上游唤醒事实为 `result.triggerTurn !== false && scheduledCompletionTriggersTurn(result.scheduleOrigin, details.status)`（`:689`）；聚合后才成为 `.some(...)`。quiet schedule 的成功通知可以已有 false，不能强制回 true（`:226-228`）。失败、paused、stopped 会先 flush held completed 项再单独发，不应虚构“失败必在同一 batch”来测试（`:700-703`）。

batcher 的 pending 数组、timer flush 和 grouped emit 见 `U/src/runs/background/completion-batcher.js:62-119`；foreground 立即发送，claimedItems 可能因去重而少于 acceptedItems。因此，即使提前知道一个 result，也不能凭“最近 result/FIFO”证明这次 send 的全部 items。

### 4. 本仓确实能拿 options，但不能拿 exact 同次 result

`P/src/subagent-dispatch/runtime-membrane.ts:156-173` 的 proxy 获取 `(message, options)` 并调用 `target.sendMessage(visible, options)`；options 当前原样传递。默认未开 force display 时 message 本身也保持引用。

实际接线：`P/extensions/subagent-runtime.ts:311-348` 只传 `bootstrap: upstreamSubagentRuntime`、`afterBootstrap: registerBuiltinAgents`、workspace reminder 等，**未传 completionNotifierFactory**；`P/src/compat/pi-subagents-0.75.ts:11-15` 将 public root `pi-subagents` 注册转发为 `upstreamSubagentRuntime(pi)`。

该 bootstrap 在 `P/src/subagent-dispatch/extension.ts:1894-1917` 获得 membrane proxy。因此可以在技术上改 options，不能据此声称已经持有 `provenReceipt`。

## 候选接点与拒绝依据

| 候选 | 真实可见性 | 不能采用的原因 |
| --- | --- | --- |
| membrane `sendMessage(message, options)` | exact 本次调用参数；`runtime-membrane.ts:156-173` | 缺 result/items/details；文本推断不能补足结构或业务增量证明。仅作为未来已证实关联的 options 边界，本次无实施资格。 |
| public root bootstrap DI | `U/index.d.ts:1-2` 只有 `(pi: ExtensionAPI): void`，`U/index.js:1-9` 转发同签名；`U/src/extension/index.d.ts:20` 同形态 | 未公开 notifier/observeCompletion/beforeSend 参数；notifier 创建在闭包中（`extension/index.js:314,427-435`）。不能替换 internal deps 或深 import 私有实现来绕过 exports。 |
| result-watcher 的 notifier/observeCompletion deps | `result-watcher.js:99,343,478` 确实有完整 result | 仅内部工厂 DI，不在实际 public bootstrap 中暴露。本仓无法合法接到该 result，更不能得到 claim 后 exact batch items。 |
| 本仓 `completionNotifierFactory(api,state)` | `extension.ts:1801,1972-1977` 有工厂回调 | `:1897` 一旦配置就使 bootstrap API suppress 原 completion；membrane `:158` 直接吞原 send。这是替代 sender/delivery 路径，不是唯一原 sender 的 options 关联；用户明确禁止，不能启用。 |
| async-complete public event / titleRegistry 队列 | `result-watcher.js:517` 后置 event；`title-registry.ts:67-69` 仅 root/leaf+success 判断 | 正常链已经 send 完毕；FIFO 无 batch/claim/retry 一一对应，root/leaf 与 success 不证明纯派发或无新增结果。`extension.ts:1958` 的 facade filter 仅属于备用 notifier API，不是生产原 sender 选择器。 |
| `parseSubagentNotifyContent`、receipt header、child count | `notify.js:203-222,256-328,331-352` 的显示格式与 parser | 单条 parser 只恢复展示字段，grouped 使用另一格式；即使 header 确属 sender slot，也只证明有路径，不能证明 receipt 身份、业务增量或 exact items。不能拓宽 regex 来“通过”。 |
| TUI completion observer / workspace reminder | `completion-notices.ts:18-44` 监听 message_end；entry `:331-340` 注册独立 workspace reminder | TUI 是发送后展示；workspace reminder 不是原 sender 元数据接点。不能让 observer 承担 sender，也不能新增 second delivery。 |
| public background-work/delegation 等出口 | `U/package.json:61-131` exports；`src/api/background-work.d.ts` 活跃工作快照；`src/api/delegation.d.ts` 委派事件 | public 类型未提供原 completion sender 的 beforeSend/items/result 绑定。活跃工作或另一路请求/结果，不是 exact 同次通知的可信关联。 |
| private global / receipt/result 文件 | 源码有内部 send registry 和 receipt 路径 | 本合同禁止读取或建立私有旁路；它们也不能直接证明这次 claim 后发送集合。未访问这些运行时数据。 |

## 静态正反例与 pass-through 合同

**以下是未执行的合同矩阵，不是新测试结果，也不是生产异常样本。** `T0` 指真实 sender 为该次调用生成的 options.triggerTurn。本次所有输入均原样透传 `T0`，不新增 selector，不翻转 false→true，不重送失败消息。

| 场景 | 正反判据（不靠标题） | 未来“可抑制”条件 | 本次结果 |
| --- | --- | --- | --- |
| 单条纯派发候选 | 一个 workflow root 成功；完整可信 result 能证明仅既有派发回执且相对 tool result 无新增产出/失败/决策 | 还必须有合法发送前 exact item/result/send 关联；当前不存在 | blocked；`T0` 原样（通常 true），功能未完成 |
| 多条全纯派发候选 | 每条都具备上述完整证明，且与 claim 后实际 items 一一对应 | 所有 items 都获可信证明才可能 false | blocked；不能因首条匹配而抑制整组 |
| 混合 completed：派发 root + 真实 leaf 完成 | 同组中至少一条有业务输出/structuredOutput/真实完成结果；completed 可合法合批 | 反例，不能抑制整组，保留上游 `.some` | `T0` 原样 |
| workflow 完成但仍有 child running，且有新增 value/emits 或产出 | `workflow.value/emits` 和 result outputs 可与 running children 同存，见 executor 成功路径 | 反例；child count、`taskInfo` 或“dispatch complete”字样均不够 | `T0` 原样 |
| 全部 child 已真正完成、需消费业务结果 | 完成结果不是仅派发 ACK，不论标题如何 | 反例；正常 completion 唤醒不可吞 | `T0` 原样 |
| 失败/暂停/停止/timeout 或 watchdog blocker | `success/state/terminalOutcome/watchdog` 等权威事实；non-completed 按实际调用先 flush 再单独 emit | 反例，不能抑制 actionable 通知，不能制造错误 batch | 每一次原 send 的 `T0` 原样 |
| 需决策/回复 | supervisor request 实际是独立 customType，含 requestId/runId/expectsReply；`native-supervisor-channel.js:698-715` | 反例；不可改独立 request 的 triggerTurn；completion 中的未解决 blocker 同样不是纯派发 | 原消息与 options 原样，不跨类型误伤 |
| receipt/header 可见但缺关联/缺增量事实 | 只有 path、parsed title、root/leaf mapping 或 success | 缺字段必须拒绝抑制，不能查文件补证 | `T0` 原样；blocked |
| result workflowReceipt 合法缺失（写入失败） | executor receipt 写入 catch 后仍可发布 result | 不把缺失默认成纯派发，亦不补 production fallback | `T0` 原样 |
| 缺 batch item 身份、旧 session/owner、awaitedByWorkflow、dedupe/intercom 已投递 | 内部有不发送或 joining 分支，event 与一次 send 不是一一对应 | 不以 event 数或最近 result 代替 exact send 关联 | 不新增 send/delivery，不改事件或上游已有过滤 |
| pass-through：message 有任意原 content/details，options 有 deliverAs 或 triggerTurn false/未定义 | 现有膜转发，不消费 completed 队列，不改 message.content/details | 无证明即不抑制；保留引用/所有原字段，不能为展示改 raw | 本次未改 production；既有代码行为保留 |
| sendMessage 同步抛错 | notify.js:434-437 返回 false；watcher.js:500-502 调度重试 | 不能通过第二 sender/假 accepted 矫正 | 原失败与重试语义保留；本次无真实实验 |

这里的未来正例只是**必要条件**，不冻结 `ProvenReceipt` 类型，不自造一个当前不存在的 `dispatchOnly` 字段。统一计划的 `shouldSuppressDispatchWake(message, provenReceipt): boolean` 仅为条件接口草案；Q1 阻塞后 **Q2 函数参数、写路径接入与执行命令均未获实施资格**。

## 验证、未验证与现场保护

已有测试的静态定位：`test/subagent-runtime-membrane.test.mjs:325-338` 断言 production 不接 compat notifier；`:339-382` 展示 factory 开启 suppression 的测试场景；`:416-444` 与 `:561-577` 覆盖 raw 单条/分组透传。它们支持边界阅读，**没有执行，不当作新的 selector 或 triggerTurn 回归通过证据**。本次未新增/更新测试（静态 gate，合同禁止测试/Host）。

实际执行的 shell 命令及退出码：

| 命令 | exitCode | 结果 |
| --- | --- | --- |
| `git status --short; git diff --cached --name-only` | 0 | 起点 index 无 staged 文件；已有非重叠文档 dirty 保留 |
| `git rev-parse HEAD; shasum -a 256 packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.js packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/result-watcher.js packages/pi-subagents-enhanced/node_modules/pi-subagents/src/extension/index.js` | 0 | 输出上述 HEAD 与三个源码摘要；未执行安装物 |
| `git diff --check -- docs/plans/records/2026-10-13-trigger-turn-contract.md` | 0 | 本记录无 whitespace 错误 |
| `git status --short; git diff --cached --name-only` | 0 | 本记录未 staged；既有 dirty 与其他未跟踪记录未触碰 |
| `grep` 精确核对 executor receipt/result、extension notifier 注入及 result-watcher 顺序 | 0 | 命中本记录引用的生产源码链；未运行 runtime |

最终文档检查：`git diff --check` 通过。工具 read/grep/find 仅用于上述限定源码与文档定位，不运行 runtime。

`unverified`：纯派发 selector、真实唤醒/持久化/投递行为、batch/actionable/send-failure 执行回归均未验证。记录确认的是现有调用链与 public 缺口，不是端到端功能成功。

`changedFiles`：仅本文件。未修改上游、node_modules、production、raw message/event/result/details/options；未增加第二 sender、delivery 或私有旁路；无 stage/commit/stash/reset。
