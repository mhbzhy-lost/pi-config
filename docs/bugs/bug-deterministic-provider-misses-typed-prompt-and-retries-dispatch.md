# Bug：deterministic provider 未识别 typed Executor prompt 并重试派发

## 1. 现象

真实 flat Harness 的 task63ad 在一次 revival 后只启动了一个 Executor。task-1 的首次
subagent 成功返回 exact `coding-dispatch-handle`，并已持久化 `attempt.bound`；因此
Boundary 不是首次失败根因。此后仍对同一 task-1 contract、同一 toolCallId
`deterministic-subagent-2` 重复派发 2,626 次，全部返回
`requested dispatch unavailable or missing`。revived Plan Runner 一共执行 2,627 次
`subagent`，而整个现场仅有一个 Executor。

## 2. 触发条件与证据

task63ad 的 persisted evidence 记录：`plan_continue` 只发生一次，revival generation
也只成功一次。首次 task-1 dispatch 已得到 handle 且绑定 attempt；后续请求却仍是同一
contract 和同一 toolCallId。Executor 实际收到的 prompt 开头为
`# Coding Dispatch Contract v1`，其可写路径位于 `## Declared Write Scope`，不是旧
fixture 所假定的文本形态。

对应的三项独立 RED 合同应为：

1. 用真实 `compile` 加 `renderCodingDispatchPrompt` 产生的 typed prompt，映射出
   Executor 命令。
2. private wake 含两个 dispatch，且仅存在已发出但尚无 result 的 assistant tool call A
   时，状态机选择 B。
3. provider stream 已有 assistant subagent tool call A 时，下一次 subagent 的
   toolCallId 必须不同于 A。

## 3. 根因

Executor 首次失败来自 fixture 的 prompt 解析失配：
`deterministicExecutorCommand` 只识别 `^Allowed paths:`，而真实 typed contract 将路径
声明在 `## Declared Write Scope`。它因而只返回 `deterministic`，completion guard 随后报
`executor completed without making edits`。

派发风暴来自 `decideDeterministicTurn`：它只统计 latest `plan_continue` 后 standalone
`subagent` toolResult，并假定真实 continuation 的 provider 上下文会保留这些结果。实际
上下文不满足该保留假设，已发出的 assistant tool call 也没有计数，状态机遂持续选择同一
dispatch。provider stream 又以 `toolResults.length` 生成 toolCallId，导致
`deterministic-subagent-2` 被重复复用。

## 4. 影响范围

该问题把一个本应成功绑定的 task-1 放大为同 contract storm：重复的 unavailable dispatch
掩盖了首个 Executor 的 prompt 解析失败，Plan 生命周期停在 running，无法进入后续任务或
验证。重试同一 contract 不会产生新的有效授权或有效执行，只会制造大量无效调用。

每个 dispatch contract 最多只能尝试一次；错误结果不得触发同 contract 重试形成 storm。
本 fixture 的目标是覆盖 happy path 的真实 provider transcript，不改变 production
Boundary、Broker、Plan 或 replay 语义，也不放宽 authorization。

## 5. 修复边界

仅修正 deterministic provider fixture 对真实 transcript 的适配：

1. `deterministicExecutorCommand` 从真实 `renderCodingDispatchPrompt` 生成的 typed
   `## Declared Write Scope` 识别 `README.md` 与 `worker.txt`，同时保留旧
   `Allowed paths:` fixture 兼容。
2. dispatch 序号取两类最大进度：latest `plan_continue` 后成功或失败的 standalone
   `subagent` toolResults，以及已经发出的 assistant `subagent` tool calls。
3. provider 的 toolCallId 以后续可见 assistant tool-call 数量生成，不能与已有 call ID
   重复。

不得修改 production Plan、Broker、Boundary 或 authorization；不得通过轮询或次数硬上限
掩盖错误。

## 6. 验证策略

按上述三项合同先独立 RED，再实现 fixture 适配并使 deterministic provider unit/stream
测试 GREEN。真实 Harness 随后应验证：一次 revival 后 task-1 首次 Executor 能依据 typed
scope 写入目标文件；每个 contract 只派发一次；不存在重复 toolCallId 或 unavailable
storm，并继续完成后续 task 与 validated。

本缺陷记录提交仅包含本文件，提交信息为
`docs(bug): 记录 provider transcript 形态失配`。提交后以
`git diff-tree --no-commit-id --name-only -r HEAD`、`git diff --check HEAD^ HEAD` 与
`git diff --cached --quiet` 验证单文件提交、无空白错误和索引为空。
