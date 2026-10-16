# triggerTurn / RPC / supervisor 设计缺口调研（2026-10-14）

## 产物与证据边界

本文件由父会话根据 reviewer `ee683120-4f1a-4970-b080-0466c389f85c` 返回的完整报告整理落盘。reviewer 没有写文件权限，**其原报告所称 runtime 自动写入、changedFiles 仅本文件并未发生**；父层先确认目标不存在，再创建本摘要。完整报告保留在该 run 的返回结果中。本文件是设计研究，不是实现计划或生产修复。

reviewer 报告现场 HEAD 为 `a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`；上游 `pi-subagents@0.75.0` 的 notify.js、result-watcher.js、extension/index.js 源哈希与 Q1 记录一致。证据模式为静态源码核对，未启动 Host/RPC/provider/网络/通知，未运行测试。下文新增事实为 reviewer 的静态发现，不是历史故障根因裁决。

## 1. triggerTurn：当前缺发送前的结构化逐项证明

### 调用链

上游 `src/runs/foreground/subagent-executor.js` 写 workflow receipt/result → background result-watcher parse/observeCompletion → notifier.deliver → buildCompletionDetails → batcher/ownership/sendRegistry claim → sendCompletion → `pi.sendMessage({customType:'subagent-notify', content, display}, {triggerTurn: items.some(item => item.triggerTurn)})` → 本仓 `runtime-membrane.ts` 透传 options → accepted 后 watcher 发 `subagent:async-complete`。

关键位置（上游目录为 package 内 node_modules/pi-subagents）：
- `src/runs/background/notify.js:425-433,606-709`
- `src/runs/background/result-watcher.js:343,478-536`
- 本仓 `src/subagent-dispatch/runtime-membrane.ts:156-173`

### 新增精度与不足

content 中的 `Workflow receipt:` / `Workflow run:` / `Child runs:` 行与实际 claimedItems 同源，不是完全无关联；但它们是未版本化展示文本，不是安全 selector 合同。非 workflow 通知缺 runId，文本不能证明 structuredOutput、workflow.value/emits 或相对 tool result 的新增业务产出为空；聚合 `.some()` 也隐藏逐项 triggerTurn。后置 async-complete 不能替代发送前关联。

**结论：**在不修改上游、不替换原 sender、不新增第二 sender 的约束下，现接点不足以 fail-closed 实现纯派发唤醒抑制。可做本地取证设计，但不能用文本解析冒充可靠生产判定。

### 需要的公开合同

message 的版本化 per-item 身份（runId/workflowRunId/receipt identity/session owner）、status/source/scheduleOrigin/per-item triggerTurn，以及可信业务增量事实；或等价公开 beforeSend/notifier 合同。缺失字段时必须保留原唤醒行为，混合批次有真实完成时继续唤醒。

### 可本地实施的后续设计

- send-message trace 补充本层实际可见的枚举/布尔字段；不得编造不可见 runId。
- content parser 只作取证辅助，不作抑制条件。
- 取证 send 与 async-complete 的数量/批次关系只能证伪一一关联假设，不能建立权威关联。

## 2. RPC：复合错误标签与诊断路径不对称

### 调用链与静态发现

本仓 `src/subagent-dispatch/extension.ts` coding 路径 rpc.ping 后直接 assertSpawnCapabilities（约 :828-835）；generic 路径若有 capabilities envelope，会先 negotiateCapabilities/assertSpawnAllowed 再统一断言（约 :1036-1044）。

`rpc:v1/session` 是 version、spawn method、sessionId、lifecycle identity、session.cwd、cwd 相等六条件的复合错误标签，不足以确定哪个条件失败。

reviewer 静态收窄：带前缀 `pi-subagents RPC capability negotiation failed; missing: rpc:v1/session` 的形态可来自 coding 路径，或 generic 缺 capabilities envelope；generic 有 envelope 时的部分身份失败可能先抛细分错误。上游 sessionData(ctx) 在 ctx 缺失时给 `{}`，lastUiContext 在 session_start 后设置、失效时清空；这是候选可达形态，**不是原个案已证实根因**。

coding 统一断言错误缺 operation，现 catch 可能只返回 `{code}`；generic RPC 错误已有更完整的结构化失败投影。

### 可本地实现的最小诊断合同（尚未实现）

在失败 details 增加：

```text
negotiation: {
  stage, dispatchPath, capabilitiesEnvelopePresent,
  missingCapabilities, versionOk, spawnMethodOk,
  sessionIdPresent, lifecycleIdentityPresent,
  sessionCwdPresent, cwdEqual
}
```

仅枚举、布尔及既有 capability 名，不输出 cwd、sessionId/sessionFile 值或任务正文；trace 补实际 stage。不得改变准入判断或默认值。

**分类：**本仓诊断补强不需要上游改造；原故障修复仍需真实失败样本。raw ping debug 可能含身份值，不应作为默认取证入口。

## 3. supervisor：提交、队列、消费不是同一事实

### 调用链

child contact_supervisor 写 request 并等待 reply → parent native channel 发送带 requestId/runId/childIndex 的 request message → 本仓 capture correlation/register durable pending → parent executeReply 写上游 reply → 本仓 commitDelivery 记录 queued、consumed=false → child 命中 reply → child process-terminal 后按 observed terminal proof、session/toolCallId/body digest/时间顺序对账 → receipt delivered/consumed=true、request replied → steer gate 才可据 pending 清除而开放。

关键本仓文件：`src/subagent-dispatch/supervisor-control-plane.ts`、`supervisor-consumption.ts`、`extension.ts`；Host 绑定在 `extensions/subagent-runtime.ts`。

### 新增静态事实

- 上游 child 默认等 reply 10min，本仓 durable request 默认注册后 20min；不能把任一时间点当成绝对 gate 自动解除保证。
- 本仓消费权威观察在 terminal 对账，mid-run 没有公开消费确认事件。
- reviewer 发现 supervisor 诊断事件可能不在 trace sink 白名单，导致登记/消费拒绝等诊断无法默认持久化；此项是本地可观测性设计缺口，尚未以真实失败复现验证。
- reply 成功文本不附本仓 queued/consumed receipt 投影，易混淆提交成功与消费成功。

### 可本地实施的后续设计（尚未实现）

1. 为 supervisor 诊断事件建立显式、安全的 trace schema/白名单，不直接放行任意正文。
2. 增加按 requestId/runId 过滤的只读 provenance：receiptStatus、consumed、generation、时间戳与成员存在性；不含请求/回复正文、correlation 路径或凭据。
3. reply 回执附提交与消费状态的明确投影，文案说明 queued 不等于 delivered。
4. 保持 durable pending、owner 三态、SUPERVISOR_REPLY_REQUIRED 原门禁，禁止 TTL 捷径或猜测消费。

**分类：**上述诊断本地可设计；mid-run 权威消费确认需要上游合同。历史 NOT_PENDING/已消费仍 gate 的个案需要 requestId/replyTo/runId/时间序列/receipt 事实，不可凭静态 TTL 差异判为 bug。

## 4. 决策矩阵

| 项目 | 本地可补设计/实现 | 必需上游合同 | 必需真实样本 |
| --- | --- | --- | --- |
| triggerTurn | 安全 trace、取证 parser、selector 契约草案 | 发送前 per-item 身份及业务增量，或 beforeSend | 纯派发、混合批次、quiet、失败重试行为 |
| RPC | 布尔级 negotiation details 与 stage trace | 当前诊断方案不需要 | 历史错误根因裁决 |
| supervisor | 安全诊断 trace、只读 provenance、receipt 投影 | mid-run 消费确认 | 历史 NOT_PENDING/消费/gate 个案 |

## 5. 现状不升级

- Q1 仍 blocked-upstream；R/V 历史根因仍 blocked-evidence。
- 本报告没有实现、测试或修复任何生产行为。
- 不得以“缺样本”宣称系统能力不可能，也不得以“本地能加诊断”宣称已解决历史故障。
- idle 系统通知不在本轮调研范围。
