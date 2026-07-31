# deterministic provider 未识别投影后的 lifecycle follow-up

## 1. 现象

真实 Pi 将 Root 发出的 custom lifecycle follow-up 投影到 deterministic provider 后，Plan Runner 没有调用 `plan_status`。因此计划状态中没有新的 `plan_status` 结果，两个任务仍为 `pending`、attempt 仍为 `active`，尽管两个 Executor 的 command、commit 与 acceptance 都已验证通过。

这不是 queued push 仍在 pending。真实 Harness 已进入 queued-push revival 的第三代，队列已由新 generation 成功 flush；其后的 `revival.blocked` 原因是 `wake-missing`，是另一条后续 wake 缺口。

## 2. 真实证据/反证

证据见 [task63au-flat-harness-queued-push.md](../../.pi-subagents/artifacts/verification/task63au-flat-harness-queued-push.md)：HEAD 为 `e7fe05306dd1d2e21978a4de61f1f5c1c14c00e5`，exact Harness 仅运行一次即 RED。initial、plan-opened、queued-push 三代均为有限且独立的实际 run；两次 dispatch 各仅一次，两个 Executor 均执行已声明 command、完成 commit，并有 verified acceptance。

第三代由 queued-push 成功 `resume` 与 `grant` 后终止；随后的官方 proof 后，Root 两次记录 `revival.blocked` / `wake-missing`。这反证了“队列仍 pending、尚未 flush”这一解释。该次受管 root cleanup 后 `realpath` 返回 `ENOENT`，五个 PID 的零信号探测均为 `ESRCH`，因此不存在可继续读取的 raw Harness 根目录。

源码链路也完整：`pi/child-extensions/root-owned-subagent.ts` 以 `customType: "pi-root-subagent-lifecycle-v1"` 发送 exact content `A lifecycle update arrived. Call plan_status.`，并指定 `triggerTurn: true`、`deliverAs: "followUp"`。pinned Pi core 的 `convertToLlm()` 把 custom 转为 `role: "user"`，只保留 `content` 与 `timestamp`，丢弃 `customType`、`details`。

## 3. 根因

`test/fixtures/deterministic-provider-state.mjs` 的 `latestPushIndex` 只扫描 `role === "custom"` 且 `customType` 为 lifecycle 或 supervisor request 的消息。真实 provider 输入已经是 user 文本，故该索引找不到 lifecycle，不能优先调用 `plan_status`。

现有 unit test `provider stream polls plan_status when a lifecycle follow-up arrives` 也直接构造 custom 消息，模拟的是投影前的 session 消息而不是 provider input，因而得到假 GREEN。另一个细节是：真实 projected message 成为 latest user 后会使 `latestPrivateWake` 为 false；但历史 bootstrap 仍已合并在 `userText`，状态机仍能进入分支，缺失的仅是 latestPush ordering 识别。

## 4. 正确修复

修复只应位于 deterministic provider state，保留 exact fixed marker 常量或同等清晰实现：`A lifecycle update arrived. Call plan_status.`。`latestPushIndex` 应识别两种合法形态：

1. 内部消息或旧 fixture 的 `role: "custom"` 且允许的 lifecycle `customType` 形态。
2. Pi 投影后的 `role: "user"`，其 `textParts(message)` 精确等于该 fixed marker 的形态。

不得全文模糊匹配，不得只搜索 `plan_status` 一词，也不得将任意用户输入当作 lifecycle。不得改动 production `root-owned-subagent`、pinned Pi core、Broker 或 Capsule；不得试图保留 Pi 已丢弃的 custom metadata，也不得加入 polling、sleep、retry 次数。

## 5. TDD 验证

授权修复时，先将 `provider stream polls plan_status when a lifecycle follow-up arrives` 校准为真实 projected 输入：`user("A lifecycle update arrived. Call plan_status.")`。现代码应单项 RED，结果为 waiting 而不是 `plan_status` tool use；其余 33 项保持通过。随后为 state fixture 实施上述 exact marker 双形态识别，使该测试 GREEN，并保留 custom 形态兼容测试，或由既有 `decide` tests 覆盖该形态。

本次为 docs-only 六要素门禁，未修改 tests、fixtures 或 production，故不运行会改变或验证未授权实现的 TDD 命令。真实 Harness 已有且仅有一次 RED 证据，不能将其表述为修复后的 GREEN。

## 6. 影响边界

影响仅限 deterministic provider 对真实 Pi provider input 的 lifecycle 排序判断：它会令已完成 Executor 之后的 Plan Runner 未拉取状态，造成 `plan_status` 缺失及 attempt 持续 active。它不证明 queued push 未送达，也不改变 Root 的 official proof、FIFO flush、dispatch 去重、Plan Runner bootstrap 或 private wake 语义。

修复后仍需独立验证真实 Harness 的完整后续链路。特别是本证据中的 `wake-missing` 是 queue flush 之后出现的 Root revival 问题，不应由此 provider marker 修复掩盖或替代。
