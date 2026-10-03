# Bug：生产异步 subagent 完成通知被 membrane suppression 静默吞掉

- 发现日期：2026-09-29
- 发现方式：真实生产动态验证（升级后首批真实 typed dispatch，用户在 TUI 亲历）
- 严重级别：P0（主 agent 永远收不到 async subagent 完成通知，编排能力实质不可用）
- 分类：类别 1（预期 production 数据未被正确处理）——真实 Host 会话 `01a0ec00-2e4b-741f-949e-770a35da3ca1`、真实 provider（qoder-pool/GLM-5.3-0.6x）、身份/时间/资源事实全部有效

## 现象

2026-09-29 16:37 并行派发 3 个真实 subagent（7a2f7322/51e8db30/c3e551ca），三者在 16:55/16:58/17:02 全部完成（events.jsonl 含完整 `subagent.run.completed` + `subagent.run.process_terminal`，workflow-receipt state=complete，产物齐全），但主 agent 会话日志中**零条** `subagent-notify` 自定义消息，主 agent 未被任何完成事件唤醒。用户在 TUI 观察到 subagent 完成但无 complete 事件到达。

## 首个偏离点与完整调用链

删除前接线（本会话 15:10 启动时加载的升级后代码）：

1. `packages/pi-subagents-enhanced/extensions/subagent-runtime.ts`（旧版）向 `installHeadlessTypedSubagentRuntime` 传 `completionNotifierFactory`；
2. `src/subagent-dispatch/extension.ts:1678`：`suppressCompletionNotifications: typeof completionNotifierFactory === "function"` → **true**；
3. 上游 result-watcher 观察到 result 文件 → `notify.js` `registerSubagentNotify` → `sendCompletion`（notify.js:421-436）调用 `pi.sendMessage({customType:"subagent-notify"})`；
4. `src/subagent-dispatch/runtime-membrane.ts:209`：`if (suppressCompletionNotifications && message?.customType === "subagent-notify") return undefined;` —— **静默丢弃且不抛错**；
5. `notify.js` sendCompletion：`try { pi.sendMessage(...) } catch { return false } return true;` —— **不抛错 = 无条件报告成功**；
6. result-watcher 依 "accepted" 完成收尾：归档至 `async-subagent-results/output-archives/` + 写 `completion-replay/`（含完整 model/usage/artifact）+ emit `subagent:async-complete` + 删除 result 文件；
7. compat notifier（`createCompletionNotifier`，P1 删除前接线）经 `completionNotifierFactory(completionApi, ...)` 收到 membrane 代理并订阅 async-complete——但其转发守卫要求事件 payload 携带顶层 `message` 字符串（`typeof value.message === "string" && value.message.trim()`）；
8. 上游 result-watcher.js:517 `pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {...data, runId, triggerTurn, ...})` 的真实 payload 全程无顶层 `message` 字段（result 文件 schema 只含 agent/mode/state/success/results/summary/output/error 等；result-watcher.js 全文零 `message` 引用）→ 守卫永不匹配 → compat notifier **从未调用 sendMessage**，第 4 步的 suppression 从未作用于它（机制已于 2026-09-29 探针定案，见下方「机制修正」）。

**净效果：上游原生投递（路径 1）被 suppression 吞掉；compat 补投递（路径 2）死在自身 `message` 守卫上（从未发出）；文件层全程报告成功；主 agent 零通知。**（原记述「两条投递路径全部被 suppression 吞掉」不成立：completionApi 从不携带 suppressCompletionNotifications，路径 2 若真能发出则会直达。）

现场证据：
- `var/tmp/pi-subagents-uid-501/async-subagent-results/completion-replay/{7a2f7322,51e8db30,c3e551ca}.json`（时间戳 16:55/16:58/17:02，恰为完成时刻；retention 最后运行 15:11，排除 retention 归档）
- 三个 run 的 result 文件已按"投递成功"路径删除（async-subagent-results/ 根目录无这三个 run 的 .json）
- 主会话 `var/sessions/2026-09-29T07-10-29-963Z_01a0ec00-*.jsonl` 无任何 subagent-notify custom_message（仅 2 条 supervisor 控制面消息）
- 无扩展重载标记（会话启动后 pi 无 reload；jiti 缓存 `extensions-subagent-runtime.07d20e2b.mjs` 16:46:21 为测试运行产物，非 Host 重载）

## 根因

设计意图是「host 层 notifier 负责投递时抑制上游 native notify 防止双投递」，但两条投递路径以两种不同方式同时失效：

1. **路径 1（上游原生投递）**：bootstrap api 的 suppression 无法区分「上游 native 的重复投递」与合法投递，将其无条件丢弃；叠加上游 `sendCompletion` 以「不抛错」为成功判据（不检查 sendMessage 返回值），形成静默丢失。
2. **路径 2（compat 补投递）**：`createCompletionNotifier` 的转发守卫要求事件 payload 携带顶层 `message` 字符串，而真实 async-complete payload 从不携带该字段（仅测试用例手工捏造过）→ 守卫永不匹配 → 从未发送。原记述把路径 2 归因为「同一行 membrane suppression 再次丢弃」不成立：extension.ts:1736 构造的 completionApi 从不携带 `suppressCompletionNotifications`（注入点语义本身正确，2026-09-29 探针实证：completionApi 发送 subagent-notify 直达真实 pi.sendMessage）。

### 机制修正（2026-09-29 探针定案）

「已退役 compat notifier 从未投递」的真实机制按三候选核实（探针复原 pre-P1 接线，源码逐字取自 P1 delegate 转录 efb0acb4/run-0/session.jsonl 的 read 结果；jiti 缓存仅存 P1 删除后版本，Host 15:10 加载版不可用）：

- **(a) 成立**：async-complete payload 无顶层 `message` 字段 → 守卫不匹配 → 零发送。三层证据：静态（pre-P1 守卫源码 + 上游 result payload 全仓无顶层 `message` 构造）、真实数据（completion-replay 真实 completion 对象键为 runId/agent/mode/state/success/results/archivePath）、动态（探针以真实形状驱动 → pi.messages 零条）。
- **(b) 排除**：订阅非死订阅——同一 wiring 下捏造形状（含 `message` 字段）立即触发发送，证明经 captureEventSubscription 的订阅在 session_start 后已激活。
- **(c) 排除**：compat notifier 是事件订阅直调 `pi.sendMessage`，不经 notify.js 的 process-global send registry；且一旦守卫匹配，发送直达真实 pi.sendMessage（completionApi 无 suppression），不存在 send_joined 吞并。

被删测试用例「completion notice keeps the raw event payload in a display-only message」手工捏造了 `message: "Status: completed"` 字段（属 AGENTS.md 分类 2：测试制造的非预期数据），曾让该守卫看起来可达，是路径 2 被误归因的来源。

## 处置

1. **生产修复已随 P1 notifier 删除任务落地**（var/upgrade/p1-notifier-removal.md，2026-09-29）：删除 compat notifier 后生产不再传 factory → `suppressCompletionNotifications=false` → 上游原生 notify 经 membrane 正常投递。**本缺陷的实际影响窗口 = 升级完成至 notifier 删除之间的所有真实生产 async 派发**（今日 3 例全部命中）。
2. **残留风险 1（footgun，2026-09-29 复核修正）**：extension.ts 仍保留 `completionNotifierFactory` 注入点（测试 harness 用）。再传入 factory 会经 :1678 重新抑制**上游原生投递**（suppression 只挂在 bootstrap api 上），此时完成投递完全依赖 factory 自身实现；已退役的 compat 实现（`createCompletionNotifier`）从未在生产投递成功（见「机制修正」：(a) 守卫永不匹配）。注入点语义本身经复核确认已正确：completionApi 不携带 suppression，designated notifier 发送 subagent-notify 直达真实 pi.sendMessage（探针 + 具名守卫用例双重实证）。守卫：test/subagent-runtime-membrane.test.mjs「the designated completion notifier api delivers subagent-notify while the upstream bootstrap api keeps its suppression」；上游 suppression 语义由 test/subagent-completion-notification.integration.mjs 对照用例守卫。
3. **残留风险 2（上游）**：`notify.js` sendCompletion 不检查 sendMessage 返回值、以不抛错为成功。属上游 0.71 行为，本仓 no-patch 政策不改；登记为上游回馈候选。
4. **验证缺口**：升级 T11 动态矩阵的 fresh spawn VERIFIED 未断言「通知消息到达主 agent 对话」；此场景此前从未被真实动态验证过。须补一个 fresh Host（fake provider）通知到达性探针，覆盖 `subagent-notify` custom_message 落入主会话日志的断言。

## RED（待实现行为缺失）

fresh Host 探针：派发一个 fake-provider async run → 等待完成 → 断言主 agent 会话日志出现 `customType==="subagent-notify"` 的 custom_message（当前升级后代码在删除任务前为 RED；删除任务后须先落探针证明 GREEN，防止回归）。已落地：test/subagent-completion-notification.integration.mjs 主用例。

单元级（footgun 注入点）：2026-09-29 复核后确认注入点语义已正确（completionApi 无 suppression，无需修复）；以具名不变式守卫用例替代原计划的修复型 RED：test/subagent-runtime-membrane.test.mjs「the designated completion notifier api delivers subagent-notify while the upstream bootstrap api keeps its suppression」（守卫型新增，立即 GREEN；检测力由同用例内对照分支 + 机制探针证明，详见 var/upgrade/footgun-injection-fix.md）。

## 验证闭环（2026-09-29）

回归守卫已落地：`test/subagent-completion-notification.integration.mjs`（2 用例全 GREEN，TMPDIR=/tmp）。主用例在 fresh Host + fake provider 下实证「删除 notifier 后生产接线投递成功且唤醒父 agent」——本缺陷修复有效；对照用例实证旧接线吞通知，守卫 footgun 复发。详见 var/upgrade/notification-arrival-test.md。

### footgun 注入点复核与机制修正（2026-09-29，bugfix-notifier-injection-footgun 任务）

- 零生产改动：extension.ts 与 runtime-membrane.ts 均未修改——注入点语义复核确认已正确（completionApi 不携带 suppression）。
- 机制定案：路径 2 从未投递的真实机制为「payload 无顶层 `message` 字段 → 守卫不匹配」（候选 (a)），非 membrane suppression 再次丢弃；证据链见「机制修正」节与 var/upgrade/footgun-injection-fix.md。
- 新增具名不变式守卫：test/subagent-runtime-membrane.test.mjs（65→66 用例全 GREEN）——designated notifier api 投递 + upstream bootstrap suppression 语义不变 + 同构造携带 suppression 的对照分支（检测力证明）。
- 聚焦回归：TMPDIR=/tmp node --test test/subagent-runtime-membrane.test.mjs → 66/66；TMPDIR=/tmp node --test test/subagent-completion-notification.integration.mjs → 2/2；npm run typecheck → 无错误。全量 npm test 由主会话统一执行。
