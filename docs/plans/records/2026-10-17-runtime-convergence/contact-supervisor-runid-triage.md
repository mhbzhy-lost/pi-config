# contact-supervisor “resume runId 漂移” 取证：前提被整体否证

取证 child：delegate `54844904-c44c-4b0a-a3d6-ab66d6c547d5`（纯静态 + 只读现场，未修改文件、未启动进程、未联网）。完整原文见其 async dir 与 session 文件。

## 主会话前提的三处错误（必须先更正，否则后续会追不存在的代码）

| 我此前记录/派发的说法 | 现场核对结果 |
| --- | --- |
| 场景 `[managed] child waits for an explicit supervisor reply and resumes in place` | **不存在**。本仓 managed lane 只有 `真实physical parent/Node detached supervisor: managed`（`test/joint-upgrade-contact-supervisor.integration.mjs:11`），断言集是 `:64`（`root-owner-ready`）→ `:82`（`status.state==='complete'`），**没有任何 resume 断言** |
| `managed` 在门禁失败清单里 | **不在**。`integration-gate-baseline.md:57`/`:79` 记录的失败集是 `empty`、`invalid-reply`、project-workflow×2、session-owner、completion-notification、root-broker-startup、steer-text-insertion；`:42` 单独记 `invalid-reply`。`invalid-reply` 是同文件另一个 scenario，被我混为一谈 |
| 同一 child 存在 `rcp-…`（superseded）与 `rsm-…`（active）两条持久记录、root provider 用旧 runId 调 resume 被拒 `NOT_FOUND` | **全部 0 命中**：`test/fixtures/joint-upgrade/contact-provider.mjs` 全文无 `resume`；所有 `joint-contact-e2e-*` 现场里 `subagent_run_resume`、`NOT_FOUND`、`rcp-`、`rsm-` 均 0 命中；生产代码与 node_modules 里也没有 `rcp-`/`rsm-` 前缀语义 |

我指定的两个现场（`joint-contact-e2e-w1LyzG`、`-VsZWmv`）是 **2026-10-18 23:50 的过期现场**，而 `agents-shared.ts` 的 symlink 是 `7d80165`（2026-10-20 17:07）才加进 `:13` 行的；这两份现场里 `agent/extensions/` 目录根本不存在，失败码是 `CAPABILITY_NEGOTIATION_FAILED`（`missingCapabilities:["rpc:v1/session"]`、`sessionIdPresent:false`）与 `WORKSPACE_SERVICE_UNAVAILABLE`，并带 `extension_error: Required child extensions 'agents-shared' … ENOENT` —— 即**已修的 agents-shared 同根因**，与 runId 无关。其首个偏离点是 `test/joint-upgrade-contact-supervisor.integration.mjs:47` 的 `assert.equal(spawnResult.isError,false,…)`。

## 权威事实：runId 在各层的载体（后续任何恢复/接管工作都应以此为准）

- **完成通知消息不带结构化 runId**：`packages/pi-subagents-enhanced/node_modules/pi-subagents/src/runs/background/notify.js:421-434`（`sendCompletion`）只发 `pi.sendMessage({customType:"subagent-notify", content, display})`，**没有 `details`**；现场实测该 message 的 keys 恰为 `content,customType,display,role,timestamp`。runId 只出现在**正文文本**：`notify.js:120-131`（`- key=<workflowKey> run=<runId> status=<status>`）、`:175-182`（`formatCorrelationLines`：`Workflow run:` / `Child runs:` / `Retention-managed async directory`）；生产提供正文回读解析器 `notify.js:255 parseSubagentNotifyContent(content)`。
- **事件层带结构化 runId**：`…/src/runs/background/result-watcher.js:517-522` 的 `subagent:async-complete` = `{...data, runId, triggerTurn, intercomDelivered}`，其中顶层 `runId` 是**属主/wrapper run**，子 run 在 `results[].runId`；`subagent:process-terminal` 的 `runId` 是**子 run**。
- **durable 记录**：目录名就是裸 UUID runId、无前缀 —— `<tmp>/pi-subagents-uid-501/async-subagent-runs/<runId>/{status.json,events.jsonl,…}`，`status.json` 顶层有 `runId`；另有 `supervisor-channels/<childRunId>-<agent>-<index>`、`nested-subagent-events/<parentRunId>-<childRunId>`、`async-subagent-results/result-pending/<runId>`、`.terminal-runs/<runId>`。**不存在 superseded/active 双记录语义**；观测到的“两个 runId”是**父 wrapper run + 子 run 两个不同角色，均 active**。
- **typed 工具回执是权威新身份**：`subagent_start` → `details.runId` + `details.asyncDir`；`subagent_run_resume`（`src/subagent-dispatch/operation-tools.ts:268`、`:277` 固定 `action:"resume"`、`:359-362` 委托 → `extension.ts:1442 executeControl`）→ 回执 `details.runId`，缺省 `details.asyncId`：上游 `subagent-executor.js:1665` `const resumedRunId = resumed.details.runId ?? resumed.details.asyncId;`，enhanced 侧同源 `extension.ts:1531`。
- **resume 的唯一身份拒绝路径是 host session 绑定**：`…/src/runs/background/async-resume.js:491-495`（`Async run '<id>' was not found in the active session.`，判据是 `status.sessionId !== options.sessionId`），**不是** runId 版本/superseded 比较。

结论：事件 payload、typed 回执 `details`、durable 目录名/`status.json.runId` 三处使用同一 UUID 且互相一致；合法调用方应从 **resume/start 回执的 `details.runId ?? details.asyncId`** 取新身份，只有消费纯文本的渲染/提醒层才走 `parseSubagentNotifyContent`。

## 最近一次真实 managed lane 现场（通过，可作对照基线）

`…/joint-contact-e2e-EgC4SD`（2026-10-20 17:51）：`subagent_start` 回执 `details.runId = 5303d4e4…`；supervisor 请求 `details.runId = 5303d4e4…`、`childTarget = subagent-executor-5303d4e4-…-1`；`subagent:async-complete` 顶层 `runId = 578e582b…`（wrapper）、`results[0].runId = 5303d4e4…`；`subagent:process-terminal` `runId = 5303d4e4…`；durable 两个目录 `status.json.state = complete`；`workspace/supervisor-control/*.json` 里 `requests[0].runId = 5303d4e4…`、`state = replied`、`receipts[0].status = delivered`、`consumed = true`。非 managed 的 `9f1gHG`（17:51）同构（start `b72d3c0a` = terminal = request；complete 顶层 `de489616` + `results[0] b72d3c0a`）。

managed lane 完整调用链（正常路径）：`subagent_start` → `executeStart`（`operation-tools.ts:357`）→ workflow spawn（`workflow-spawn.ts`）→ 子 run 落 `async-subagent-runs/` → child `contact_supervisor` → `subagent_supervisor_request`（`details.runId=子 run`）→ 父 `supervisor_request_pending` → `supervisor_request_reply` → `createControlledSupervisorAdapter.executeReply`（`extension.ts:1572` 起）→ `commitDelivery` → receipt `delivered/consumed` → 子消费 → `subagent:async-complete` → `sendCompletion`（`notify.js:421`）→ 父收到 `customType:"subagent-notify"`（无 details）→ durable `status.json: complete`。

## 三分类判定

**类别 3（来源尚未证实），且提问前提被现场否定**：无首个偏离点（最近一次 managed 现场全程一致并通过）；给定两份现场的首个偏离点在更早的 `:47` spawn 阶段，码为 `WORKSPACE_SERVICE_UNAVAILABLE` / `CAPABILITY_NEGOTIATION_FAILED`，与 runId 无关，且属已修的 agents-shared 缺件类。

## 对 F8 的直接影响（必须带入后续设计）

`docs/plans/records/2026-10-17-runtime-convergence/f8-takeover-gap.md` 中“root 收到 handoff 后调 `subagent_run_resume`”的设计必须按本文的权威事实修正：root 侧**不能**指望从完成通知里拿机器可读 runId（通知无 `details`），只能从 handoff/事件 payload 或此回执链取；resume 被拒的唯一身份路径是 host session 绑定（`async-resume.js:491-495`），因此“resumed child 能否沿用原 workspace/lease”取决于 session 绑定与 coordinator activation，而不是 runId 版本比较。此外本文否证了 `rcp-`/`rsm-` 与 superseded/active 双记录的说法，F8 记录中若引用过该语义一律作废。

## 真正需要定性的失败：`invalid-reply`（已另行派发）

child 的旁证（越出其任务范围但可直接分流）：`invalid-reply` 现场实测为“期望 3 次全 `SUPERVISOR_REQUEST_NOT_PENDING`，实际 2 次成功 + 1 次 `NOT_PENDING`”（`…/joint-contact-e2e-xlUbIK` 2026-10-20 17:51；同形态 17:40 `twdY61`），即 `contact-provider.mjs:53` 中 `{to:'executor', message:'bad'}` / `{message:'bad'}`（**缺 `replyTo`**）被判成功投递，与 runId/resume 无关。已派 delegate 专项定性（判定 schema 校验是否生效、fixture 调用姿势是否绕过校验、`:42` 记录的期望是否过期）。
