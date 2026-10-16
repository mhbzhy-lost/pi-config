# Q3：纯派发不唤醒 blocked-upstream 收口记录

## 终态

- `taskId`: Q3（执行合同 `dispatch-31c9461c`）。
- `status`: **blocked-upstream**。本任务仅为记录收口：**纯派发选择性不唤醒功能未实现、未验证**。最终总账（Z）应将 Q 分支计为 blocked、整体按实际缺口记 **partial**；本文件不以任何静态证据、合同矩阵或收口记录冒充功能完成。
- 上游条件登记（以 Q1 实际证据为准，非本分支新调查）：
  - Q1：`status: blocked-upstream`，静态门禁记录已产出并经父层全文验收；纯派发不唤醒未实现、未验证。
  - Q2：`status: not-applicable`。Q1 未取得“发送前 exact result 关联”的合法接点，Q2 未获 selector 实施资格，未派 coding：未创建 `packages/pi-subagents-enhanced/src/subagent-dispatch/dispatch-receipt-policy.ts`，未创建/修改 `test/dispatch-receipt-trigger-turn.test.mjs`，未触碰 membrane/extension 写路径。
- 本分支资源：未占用 `unit-runner`（该资源由 F1 等实施分支持有）；blocked 分支无 coding、无测试执行资格。

## evidenceLinks

| 证据 | 路径 | SHA-256（本次静态计算） |
| --- | --- | --- |
| Q1 门禁记录（父层已全文验收） | `docs/plans/records/2026-10-13-trigger-turn-contract.md` | `5a1227d4def4b68570b0dbc86c7118ed6d4f032edb0a6748d670e90f6c14db66` |
| 统一执行计划 Q1–Q3 条目 | `docs/plans/2026-10-13-remaining-runtime-execution.md` | `6c7fb464839913244b3ef3ea820acbaabfd5f3587e7ecedbecff0626b0c619af` |
| 历史决策（仅引用，未修改） | `docs/decisions/2026-10-11-dispatch-receipt-trigger-turn.md` | `65f79d84f55d8e81188607349efb8993c67eea6b713e8c274006c3d7d0dfae32` |
| Q3 实施分支集成测试（存在；未读、未改、未运行） | `test/subagent-completion-notification.integration.mjs` | `9a6f90c3f1869a0823cb8ed45dc484a18b5f444289228cd175fd664f7444b8fd` |

调查起点 HEAD：`a9875d62a75a0d5ee2893646ea5a96e89bbf8e27`（与 Q1 记录起点一致）。

## 上游限制（blocked 依据，均为 Q1 已验收记录的引用）

1. 真实唯一 sender `sendCompletion(pi, items)`（`U/src/runs/background/notify.js:422-438`）的消息仅含 `customType: "subagent-notify"`、格式化 `content`、`display`；`options` 仅聚合 `triggerTurn: items.some(...)`。消息无 `details`、无 receipt、无 run identity 字段，无法从发送侧证明“仅既有派发回执且相对 tool result 无新增业务结果”。
2. result-watcher 正常链（`U/src/runs/background/result-watcher.js`）先 `await notifier.deliver(...)` 完整 data → `sendCompletion` → settle → `markDeliveredNotification`，之后才 emit `subagent:async-complete`。该事件是发送后观察事件，本仓不能将其用作发送前关联证明。
3. 本仓 membrane proxy 只见 `(message, options)`（`P/src/subagent-dispatch/runtime-membrane.ts:156-173`），看不到 result、items、claim 后 batch 身份；标题、文本 parser 或 child count 推断不构成可信关联，也不能为此拓宽 regex。
4. public bootstrap（`U/index.d.ts:1-2`）只有 `(pi: ExtensionAPI): void`，未暴露 notifier/observeCompletion/beforeSend/metadata；`completionNotifierFactory` 一旦配置即 suppress 原 completion sender，属替代 delivery 路径，不是原 sender 的 options 关联，用户明确禁止启用，亦不新增第二 sender。
5. 用户决策：不改上游、不 fork、不打 patch。在不越界前提下不存在合法接点，Q1 据此 blocked-upstream，Q2 not-applicable，Q3 本分支仅记录收口。

## 语义保留声明（本分支零改动）

- `triggerTurn` 保持原样透传（T0）：未新增 selector，未翻转 false→true，未抑制任何完成唤醒，未重送失败消息。
- raw message（`customType/content/display`）、`content`、`details`、`options`、persistence、events 全部保持原语义；未改写 raw payload，未为展示目的改写消息结构。
- 未新增或拓宽 regex；未新增第二 sender、第二 delivery、私有旁路或后置 event 替代路径。
- 未修改上游、node_modules、production 源码、任何测试文件、历史决策与统一计划文件。
- `shouldSuppressDispatchWake(message, provenReceipt)` 仅为统一计划中的条件接口草案；Q1 阻塞后 Q2 未获实施资格，本分支亦未创建该函数或任何替代实现。

## 验证与未验证

**未验证（unverified）**：

- 纯派发选择性不唤醒：未实现，无任何实施或回归结果可报告。
- Q3 实施分支命令 `node --test test/subagent-completion-notification.integration.mjs`：**未运行**（blocked 分支不执行；exit 记为 unverified）。single/batch/actionable/send-failure 回归均未执行。
- 未启动隔离 Host、RPC、provider、网络、系统通知或 SIGKILL 实验。
- Q1 记录中的静态正反例矩阵是未执行的合同说明，**不是测试通过证据**；本记录不将其当作任何执行回归结果。

**已执行命令及真实退出码**：

| 命令 | exitCode | 结果 |
| --- | --- | --- |
| `git status --short; git diff --cached --name-only` | 0 | 起点 index 无 staged 文件；既有 5 处修改 + 10 处未跟踪 dirty 全部保留未触碰 |
| `git rev-parse HEAD` | 0 | `a9875d62a75a0d5ee2893646ea5a96e89bbf8e27` |
| `shasum -a 256 <evidenceLinks 表四个文件>` | 0 | 输出上表 SHA-256；仅计算校验和，未读取 session/credential/state 数据 |
| `git diff --check` | 0 | 全仓 tracked 变更 whitespace 检查通过，无错误输出 |
| `git diff --check --no-index /dev/null docs/plans/records/2026-10-13-trigger-turn-acceptance.md` | 1 | `--no-index` 模式“存在差异”的正常退出；输出为空即零 whitespace 错误。已用带尾随空格的对照文件实证校准：问题时 exit 3 并列出错误行，本记录无任何错误行 |
| `git status --short; git diff --cached --name-only`（收尾） | 0 | 收尾 index 仍无 staged 文件；本任务仅新增本记录一个文件。任务期间并行分支新增未跟踪 `test/fixtures/heartbeat-provider.ts`（H1 计划产物，非本任务创建），与既有 5 处修改 + 其余未跟踪文件全部保留未触碰 |

工具 read/grep/find 仅用于统一计划与 Q1 记录全文阅读、上表路径存在性核对；未读取 settings/models/auth/credential、session 正文、authority 或 `.state` 数据，未运行 runtime。

## nextAction

- 保留现有 sender 与 `triggerTurn` 原语义继续生产使用；Q 分支保持 blocked，不追加任何实施。
- 若用户解除“不改上游/fork/patch”决策，或上游提供 public beforeSend/metadata/发送前 result 关联出口，可重启 Q1 复核 → Q2（条件 coding）→ Q3（实施 + `test/subagent-completion-notification.integration.mjs` 的 single/batch/actionable/send-failure 回归）。
- 最终总账 Z 应将 Q 分支记为 blocked（Q1 blocked-upstream、Q2 not-applicable、Q3 本记录收口），整体交付按实际缺口记 **partial**，并申请解除具体阻塞；不得以本记录宣称不唤醒功能已完成。
