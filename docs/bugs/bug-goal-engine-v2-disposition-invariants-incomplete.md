# Bug: Goal Engine v2 处置状态机门禁不完整

## 症状
v2 流在 `goal.created`、`task.dispatched`、`task.settled` 后追加 v1 `task.accepted` 会绕过 workspace 集成门禁并接受任务。`task.workspace_disposition_started` 也可在尚未 settle 的 dispatched 任务上开始；`disposition_applied` 可改写 started 绑定的 `strategy` 或 `executorHead`。同时事件测试从既有 16 个减少为 10 个，回归覆盖被删除。

## 影响
混合版本事件流可以把未处置或未集成的 v2 workspace 标记为 accepted，破坏审计与验收保证。未 settle 的 workspace 可被错误处置，恢复身份可被篡改；被删除的历史测试使这些不变量和既有兼容行为失去持续回归保护。

## 稳定复现
重放 v2 `goal.created`、`task.dispatched`、`task.settled(succeeded)`，再追加 v1 `task.accepted`，当前投影会得到 `accepted` 且 workspace 仍为 active。对仅 dispatched 的 v2 任务发送三种 disposition_started 之一会被接受。发送 started 后，以不同的 `strategy` 或 `executorHead` 发送 applied 也会被接受。比较 `94c288e:test/goal-engine-events.test.mjs` 与当前文件可见既有 16 个测试只剩 10 个。

## 根因
投影没有记录并单向约束事件 schema 版本，只在 v2 accepted 分支检查 workspace，导致后续 v1 accepted 能降级绕过。处置开始未根据 task 的 settle 状态和结果校验 action；applied 只校验 action，随后直接覆盖 started 保存的身份字段。测试文件被重写而非在完整基线上增量扩展。

## 促成因素
v2 状态机先实现了阶段、attempt 与 action 的局部门禁，未把 schema 和 settle outcome 作为跨事件不变量。projection.json 未序列化 schema 身份，store round-trip 未覆盖完整 disposed/integrated/released/acceptanceVerification 终态，测试数量下降没有作为回归门槛执行。

## 修复与验证策略
先恢复 `94c288e` 的全部 16 个既有事件测试并保留原断言，再增量写 RED 用例。投影在 created 时记录 schema，并在见到 v2 后单向升级；升级后拒绝任意 v1 event，纯 v1 历史仍标记 `legacy_unverified`。started 仅允许 settle 后：integrate 仅 succeeded，discard/preserve 允许 pending、succeeded、blocked；applied 必须确认 started 的 strategy 与 executorHead。将 schema 字段写入 projection.json，并以完整 disposed/integrated/released/acceptanceVerification 的 JSONL/store round-trip 断言验证。运行 focused、events 与全部 Goal Engine 测试，测试总数不少于 63。
