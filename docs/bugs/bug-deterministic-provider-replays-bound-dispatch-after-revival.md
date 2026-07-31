# Bug：deterministic provider 在 revival 后重放已绑定派发

## 1. 现象

Plan Runner revival 会启动新的 Pi 进程，并重新执行 `deterministic-provider.mjs` 的 provider registration。新的 provider 闭包不再知道前一 generation 已派发的 contract，因而在后续 generation 再次发出 `subagent` 调用。可靠现象是：跨 generation 已出现重复 `subagent` 调用，且整条链路没有 `integration`、`plan_verify` 或 `plan.validated`。

不能把现有报告中的精确总数当作事实。其文字同时称“gen1 两个、gen2/gen3 各两个”与“count four”，二者不相容；“all six directories”也不能证明每个 later duplicate 都形成了实际 executor。故本问题不以前后重复调用的精确计数、或 later duplicate 是否成功生成新 Executor 为根因前提。

## 2. 真实证据/反证

证据见 [task63ay-flat-harness-projected-lifecycle.md](../../.pi-subagents/artifacts/verification/task63ay-flat-harness-projected-lifecycle.md)。真实 Harness 仅运行一次且为 RED，基线是 HEAD `ba175f1` 加两批准、既有 dirty migration；迁移内容和 diff hash 在运行前后不变，index 为空。观察到四个有限的 Plan Runner actual generations：initial、明确 `plan-opened`、两次 `queued-push`，每代均有独立进程实例、PID 和 grant，且前代已按官方 `processTerminal.state: observed`、exit 0 终止。

projected lifecycle marker 已令 gen1 实际调用 `plan_status`，所以这不是上一项 marker 投影识别 bug。之后仍有跨 generation 的重复 `subagent` 调用，且未出现 integration、`plan_verify`、`plan.validated`、`validatedHead`、task acceptance/integration 或 workspace release。报告还确认 owned root 只由 Node 删除，后续 `realpath` 为 `ENOENT`，记录 PID 的 signal-0 探测均为 `ESRCH`，并且 migration hashes 不变、index 为空；不存在可供继续读取的遗留 Harness root。

上述证据反证“旧 marker 未被消费”是解释，但不支持将“count four”或“all six directories”外推为精确重复 dispatch 数量或 later duplicate actual executor 数。可靠结论仅为重复调用跨 generation 发生且计划未 validated。

## 3. 根因

`deterministic-provider.mjs` 中的 `issuedDispatchContractKeys` 是每次 `registerProvider` 创建的 closure 私有 `Set`。每个 revival 都是新 Pi 进程，重新 registration 本来就会重置该 Set；这符合 provider closure ownership，不能要求它跨进程持久化。

`deterministic-provider-state.mjs` 在 `dispatch-required` 分支先以 closure issued keys、当前 assistant `subagent` calls 与 standalone `subagent` results 推导 `attempted` 并选择 `nextDispatch`，之后才以 latest `plan_status` 的状态词分类。因此 new generation 即使已看到更新的 status，仍没有 binding identity 证据把 A 标为已派发，会从 dispatch 列表的 A 开始重放。

权威身份形状已足以恢复这一判断：`plan_continue` 的 dispatch envelope 含 `attemptId`、`dispatchId`、`contract`，真实 contract 顶层含 `taskId`；`pi-plan-status.v1` 的 `tasks[].attempts[]` 含 exact `attemptId`、`dispatchId`、`runId`、`status`。`attempt.bound` 后 `runId` 为非空，`validated`/`integrated` 仍保留该 binding；仍待派发的 `dispatch-requested` attempt 没有 `runId`。spawn 失败可对同一 intent 重试，而 supersede/new attempt 必须使用新的 `attemptId`/`dispatchId`。

## 4. 正确修复

修复只改 state fixture：结构化解析 latest `plan_status` JSON，且只采用比 latest `plan_continue` 更新的 status。对当前每个 dispatch，以 exact `attemptId` + `dispatchId` 匹配 status 内的 attempt；只有匹配 attempt 的 `runId` 是非空字符串时，才将该 contract key 加入 `attempted`，再与 closure-issued、assistant-derived、standalone-result 证据合并。malformed status、缺字段 status 或 identity mismatch 都不得推断已派发。

不得以 `latestStatusIndex > latestContinueIndex` 就让整个 wave 不派发：A 已 active 而 B 仍为 `dispatch-requested` 时，该规则会使 B 永久不派发。不得只按 `taskId`、status 词或数组位置匹配。不得改变 provider closure ownership，也不得加入 module global、process env、跨 session 文件、polling、sleep，或修改 production runtime、Broker、Capsule。

## 5. TDD 验证

授权 GREEN 前，新增三个独立 top-level 的真实 new-provider tests。每个测试都构造 A/B dispatch envelope（exact `attemptId`/`dispatchId`）及顶层含 `taskId` 的 contract，保留 bootstrap/open/dispatch-required 历史、projected lifecycle user marker、更新的 `plan_status`，且没有 assistant `subagent` calls、没有 `subagent` toolResults；均通过 `streamDone` 取得全新 provider closure。

1. A 的 matching attempt 有 `runId` 且为 active，B 为 `dispatch-requested` 且 `runId: null`：只派发 B。
2. A/B 的 matching attempt 都有 `runId` 且为 active：返回 WAITING，且没有 `subagent`。
3. A/B 的 matching attempt 都为 validated：调用 `plan_continue`，参数为 `{ reason: "integrate" }`。

现代码预期新增 3 项全 RED，即 focused suite `37 total / 34 pass / 3 fail`。随后仅修改 state fixture，focused 预期 `37/37`，provider + Capsule 预期 `90/90`。真实 Harness 必须另起任务，并且只运行一次；本次为 docs-only 门禁，未新增测试、未改 fixture 或生产代码，也未运行 Harness。

## 6. 影响边界

影响限于 deterministic provider 在新进程 revival 后无法从 authoritative plan-status binding identity 恢复已绑定 dispatch 的去重，从而重放已绑定 contract 并阻断 integration/validation。它不改变 attempt 的 spawn-failure 重试语义，也不阻止 supersede/new attempt 以新 identity 派发。

本提交只新增本文件，提交信息为 `docs(bug): 记录 revival 后重复派发`。本次 RED 证据来自既有的唯一真实 Harness；GREEN 测试、state fixture 修复和后续单次 Harness 验收均不属于本 docs-only 提交。残余风险是报告计数不一致仍未能确定精确重复数量，且在 identity 修复和独立 Harness 验收完成前，revival 后重复调用与未 validated 的风险仍然存在。
