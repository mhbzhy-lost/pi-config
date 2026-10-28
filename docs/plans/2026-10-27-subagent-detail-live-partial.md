# Subagent 详情实时 Partial 显示实施计划

> **For agentic workers:** 用户选择执行方式前不得实施。目标是让本地 Pi detached subagent 在 `message_end` 前持续更新详情，同时不改正式 session、runner 完成语义或 agent 收到的数据。采用累计快照与持久 entry 锚点，不引入 delta 重放或第二套会话状态机。

**Goal:** 普通 async 与 typed/Goal 的本地 Pi child 在生成 assistant 消息期间，详情以约 50–150ms 的显示合并周期更新；异常时回退现有 message_end + 500ms 链，不影响执行、完成、proof 或集成。

**Architecture:** 显式 child extension 通过公开 `pi.on("message_update")` 取得累计 partial，在权威 sessionFile 旁写原子 sidecar。parent 从 browser 已定位且处于现有 native trusted roots 的 sessionFile 派生路径，用 watch 触发 ActivitySource 刷新。renderer 复用 Pi AssistantMessageComponent；native entry 分支是最终权威，sidecar 只补尚未持久化的 assistant。

**Tech Stack:** Pi 1.4 公开 extension/session API、Node 22.19+ 原生 TS、原子 JSON、fs.watch、既有 native conversation/background activity；只扩展既有测试，不新增测试文件，不调用付费真实 provider。

## 0. 范围与权威边界

- 首版仅支持：**browser 已定位 sessionFile，且该文件处于现有 native trusted roots 内的本地持久 Pi child**。无 session、超出 trusted roots、远端/external runner、bash_async 保持原行为。
- 不修改 Pi core/pi-subagents、SessionManager、diagnostic/transcript、模型消息、completion/proof/integration。sidecar 是显示缓存，不是 raw session entry。
- parent BrowserChild.sessionId 是 **parent 所属身份**，不是 child UUID，禁止用于匹配 sidecar childSessionId。child UUID 由受信 native session header 核验；缺 header 时暂缓接受 partial。
- sidecar 路径只能由 parent 从当前受信 sessionFile 派生，不信任 sidecar/status 自报路径，不扩大 trusted roots，不新增 run→path 索引。
- writer/watcher/codec 故障只失去实时增强，不能影响 child；不为展示截断 raw message，超资源上限明确 unavailable 并回退。
- 调查报告仅作只读依据，结论写 T3 summary；本计划不要求追加调查报告。

## 1. 冻结身份、对账与读取协议

### 1.1 快照 `subagent.detail-partial.v1`

仅含：schema、childSessionId、`baseEntryId`、累计 assistant message、单调 revision、updatedAt、streaming/ended 状态，以及显示诊断所需的有限元数据。

- child 在 session_start 固定自己的 sessionFile/sessionId；在每次 assistant `message_start` 用公开 `getLeafId()` 固定 **baseEntryId**，即该 assistant 之前的持久分支叶。message_update 缺少有效 base 时不发快照。
- 不把 message_start 本地序号/timestamp 当持久身份，不改 BrowserChild 所属 sessionId。entry ID 是 Pi 持久事实，extension 本地序号仅可作诊断，不参与最终匹配。
- sidecar 使用同目录临时文件 + rename，mode 0600；parent O_NOFOLLOW、regular file、大小上限、trusted root、header child UUID 与 base entry 全部校验。

### 1.2 最终对账

1. native 读取时保留原始 entry id、parent/branch 与 role，不再只保留转换后的 message。
2. 对某个 partial，沿 native 当前分支从 baseEntryId 向后找**第一条 assistant message entry**：它就是对应该消息生命周期的最终 entry；streaming 与 ended 快照都必须在其出现后抑制。message_end replacement 仍只有这一条 final entry，因此不依赖 timestamp/正文相等。
3. baseEntryId 不存在、分支不衔接或身份不符时，不接受“旧 native + 新 partial”组合；保留上一次已确认显示，等下次刷新。不得显示跳过中间 final 的新 partial。
4. 不依赖 turn_end 才去重；turn_end.messageEntryId 仅可作额外诊断。工具执行期间也能凭分支 assistant entry 对账。
5. ended 快照不立即删除；下一条消息以新的 baseEntryId 建立衔接。retry/fork/compaction 导致锚点失效时 fail-closed 回退 native，不猜测身份。

### 1.3 跨文件读取顺序

- 始终 **先读取并固定 sidecar 快照，再读取 native session**，最后按 base 锚点组合。
- 若 child 在两次读取间从 A→B，B 的 base 应指向 A final；native 尚未包含该锚点时组合无效，保留上一次确认显示，不能组合成“缺 A 的旧历史 + B”。
- native 已含 final 时抑制对应 partial；native 未含时显示 partial，包括 ended，避免 message_end 与 appendMessage 之间出现空窗。

### 1.4 刷新成本

- writer 固定 50ms 窗口、单个在途写入、一个最新待写值，不是 trailing debounce；handler 不逐 delta await IO，JSON 序列化也只在窗口执行。
- parent watch 过滤目标 sidecar，在 runtime 统一 25ms 固定窗口合并；保留 500ms reconcile 作为路径发现与兜底。
- partial 更新只失效对应 source 行缓存，**不得调用 native.invalidate() 或清空 session 指纹缓存**。首版不改通用 detail-controller；非选中 source 的现有通知行为在 T3 测量，不提前新增过滤状态。

### T0: 身份/锚点 codec、child writer 与显式注入

- [ ] **Depends:** none
**WritePaths:** `packages/pi-subagents-enhanced/src/tui/detail-partial.ts`、`packages/pi-subagents-enhanced/child-extensions/detail-partial.ts`、`packages/pi-subagents-enhanced/src/subagent-dispatch/extension.ts`、`test/subagent-runtime-membrane.test.mjs`
**Docs:** 本计划冻结协议；调查报告；Pi message events 与 ReadonlySessionManager getLeafId/getBranch/getEntry；required-child 注入
**Resources:** 只写显示 sidecar，不写 session/transcript/events/status；不启用 requireForAllRunners

**Steps:**

1. 实现快照精确编解码、路径派生、安全读取与原子写入；parent/child UUID 分离，缺 native header 或 base 无效时拒绝。
2. child 入口在 session_start 固定身份，在 message_start 固定 baseEntryId，在 update/end 发布累计消息。无受支持 sessionFile 时 no-op。
3. writer 按 50ms 固定窗口写最新快照，单在途写入/单待写值；写失败仅显示诊断并退避，不影响 child。
4. 将入口加入现有同一个 registerRequiredChildExtensions 数组，普通与 typed/Goal 本地 Pi 共用，不承诺 external。
5. 在 membrane 既有文件覆盖：parent UUID≠child UUID、base 锚点捕获、多次 update、异常/超限/身份拒绝、写故障不影响执行、raw session 无额外 entry。

**Acceptance:** message_end 前产生带正确 child UUID/baseEntryId 的最新快照；handler 非逐 delta IO；身份与锚点合同可支撑 T2 对账。
**Stop conditions:** 需要改上游/正式 session、把 parent UUID 当 child、依赖 timestamp 去重或新增 run/path 索引时停止。

### T1: parent watch 与现有 source 刷新

- [ ] **Depends:** T0
**WritePaths:** `packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`、`packages/pi-subagents-enhanced/src/tui/detail-partial.ts`、`test/subagent-activity-provider.test.mjs`、`test/background-activity-details.test.mjs`
**Docs:** T0 协议；footer reconcile/persist/source subscribe；detail request fence
**Resources:** 保留 500ms 兜底与现有世代，不新增任务状态

**Steps:**

1. 从当前受信 sessionFile 派生 sidecar，验证 native header child UUID；对 session 目录建立去重、可清理 watch，过滤目标文件。
2. watch 经 runtime 25ms 固定窗口触发既有 source invalidate/detail render；沿用 request fence，不逐 delta 重建 overlay。
3. partial 更新只清对应 source 行缓存，保留 native session/fingerprint 缓存；无文件、旧代、畸形或 trusted root 不符回退现状。
4. child 完成、source replace、teardown/reload 清理 watcher；ended 不在 watch 层提前删除。
5. 覆盖 end 前多次 invalidation、旧代/退订、缓存、非选中 child 刷新计数与资源清理。

**Acceptance:** 本地受控更新约百毫秒级进入详情，native 历史缓存不被 partial 清空，旧 fence/滚动不回归。
**Stop conditions:** 需要扩大 trusted roots、每帧清 native 缓存或新增通用控制器状态时停止。

### T2: 持久 entry 对账与 native+partial 组合

- [ ] **Depends:** T1
**WritePaths:** `packages/pi-subagents-enhanced/src/tui/native-conversation.ts`、`packages/pi-subagents-enhanced/src/tui/footer-runtime.ts`、`test/subagent-native-conversation.test.mjs`、`test/subagent-activity-provider.test.mjs`
**Docs:** 本计划冻结对账/读取协议；native buildContextEntries 原始 entry；AssistantMessageComponent
**Resources:** raw entry/message 只读，显示文本独立

**Steps:**

1. native 保留原始 entry id/branch/role 元数据，并提供沿 baseEntryId 找后续第一条 assistant entry 的只读对账信息。
2. 复用 renderItems/AssistantMessageComponent 渲染累计 partial，保留 text/thinking/toolCall 外观；不实现 delta 拼接器。
3. 严格执行先 sidecar 后 native；final 未出现则追加 partial，出现后抑制 streaming/ended。锚点缺失时返回上一次确认显示，不产生跨空洞组合。
4. 覆盖 A 跨文件读取期间切 B 的受控 barrier、message_end/append 两种顺序、replacement、retry/fork、final 去重与 raw 不变。
5. expandedTools/hideThinking/theme/width/autoFollow 与缓存按 revision 工作，不改 ActivityRow/session/tool result。

**Acceptance:** end 前持续显示；跨文件 A→B 不缺 A；final 不重复；replacement/工具期间对账可靠；native 最终权威不变。
**Stop conditions:** 无法保留 entry 元数据、必须依赖 timestamp/turn_end 或修改正式消息才能对账时停止。

### T3: 真实 SDK 受控流与性能证据

- [ ] **Depends:** T2
**WritePaths:** `test/subagent-runtime-membrane.test.mjs`、`test/subagent-activity-provider.test.mjs`、`test/subagent-native-conversation.test.mjs`、`test/background-activity-details.test.mjs`、`docs/summaries/2026-10-27-subagent-detail-live-partial-verification.md`
**Docs:** T0–T2 实现与现有 joint/session fixtures
**Resources:** 在一个既有测试文件内使用带 barrier 的内存 provider，经真实 SDK 驱动 extension；真实 fs.watch/renderer，不调用付费模型

**Steps:**

1. 用 barrier 控制至少三次分时 message_update，再 message_end；parent UUID 明确不同于 child UUID。证明至少两次 end 前经过完整 extension→sidecar→watch→detail 链。
2. 在 membrane 既有文件承担真实 SDK/detached 边界；若现有 harness 不支持，停止上报，不用手调 handler/手写 sidecar冒充。renderer 跨文件竞态在 native 既有文件用 barrier 覆盖。
3. 记录 update、rename、invalidate、render 的单调时间；报告观察延迟与 CI 波动。统计长历史下 session open/snapshot 次数、writer 写入次数、非选中 child 刷新次数，验证 partial 不清 native 缓存。
4. 对比观察器启停基线：正常 message_end 落盘是预期，额外 raw entry/正文修改才是违规。验证 typed/Goal 本地 child、故障回退、资源清理。
5. 运行四个既有测试及必要回归、完整 typecheck、git diff --check；报告无新增测试文件/付费调用。

**Acceptance:** 真实 SDK 分时流在 end 前多次显示有证据；跨文件竞态、性能成本、raw 不变和清理均有实测。
**Stop conditions:** 需要新增测试文件、真实 provider或修改上游才能验证时停止。

### T4: 收尾

- [ ] **Depends:** T3
**WritePaths:** `docs/plans/2026-10-27-subagent-detail-live-partial.md`
**Steps:** 勾选实证任务，报告支持范围与帧率边界；commit/push 等用户明确指令。

## 全局验收

- 本地受信持久 child 在 message_end 前持续更新，常规合并周期约 50–150ms；其他路径明确回退。
- parent/child UUID 不混淆；baseEntryId + 后续 assistant entry 完成最终对账，streaming/ended 都不重复。
- 先 sidecar 后 native；A→B 跨文件竞态不产生历史空洞；锚点无效不拼错正文。
- 不改上游/raw session/模型/completion/proof；无 delta 重放、第二状态机或无限队列。
- partial 不清 native 历史缓存；真实 SDK 分时证据、性能计数、资源清理、typecheck/diff check 完整。

## 非目标

- bash_async stdout、无 session/超 trusted roots、远端/external runner、socket delta 协议、supervisor progress 通知。
- 每 delta 同步 IO/TUI、通过 message_end replacement 或修改正式持久化时机实现显示。

## 下一步

首轮报告：`docs/reviews/2026-10-27-subagent-detail-live-partial-review-1.md`。本版已前移身份/对账并冻结读取顺序。由用户选择 Subagent-Driven / Inline 或继续 reviewer；未获选择不得执行。
